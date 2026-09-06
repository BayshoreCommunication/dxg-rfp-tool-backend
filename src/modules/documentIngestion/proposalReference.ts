import { ensureConversationProposalReference } from "../conversations/conversationProposalReference";
import { ConversationError } from "../conversations/domain";
import { DocumentIngestionError } from "./domain";

type DocumentContext = {
  organizationMongoId: string;
  userMongoId: string;
  correlationId: string;
};

type EnsureProposalReference = (
  ctx: { organizationMongoId: string; actorUserMongoId: string; correlationId: string },
  proposalMongoId: string,
) => Promise<void>;

const referenceMissing = (error: unknown): boolean =>
  error instanceof DocumentIngestionError && error.code === "PROPOSAL_NOT_FOUND";

/* Document sources live in PostgreSQL and join their proposal through
   rfpilot.proposal_references. That row is only written by the proposal
   create/update path when PROPOSAL_REFERENCE_DUAL_WRITE_ENABLED is on, and even
   then best-effort, so a proposal the user owns in MongoDB can still be unknown
   to PostgreSQL — typically a proposal created seconds ago whose first action
   is "attach a file". The repository then reports PROPOSAL_NOT_FOUND although
   ownership was already verified against MongoDB.

   The conversation workspace repairs exactly this on demand; document uploads
   and pasted notes reuse that repair so the first attachment on a fresh
   proposal succeeds instead of failing with a 404 the client can only show as
   a generic error. The operation is retried once after the repair. */
export const createWithDocumentProposalReference =
  (ensure: EnsureProposalReference) =>
  async <T>(ctx: DocumentContext, proposalMongoId: string, operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (!referenceMissing(error)) throw error;
      try {
        await ensure(
          { organizationMongoId: ctx.organizationMongoId, actorUserMongoId: ctx.userMongoId, correlationId: ctx.correlationId },
          proposalMongoId,
        );
      } catch (repairError) {
        // Ownership genuinely failed: keep the original 404 rather than
        // reporting a data-foundation outage.
        if (repairError instanceof ConversationError && repairError.code === "PROPOSAL_NOT_FOUND") throw error;
        throw new DocumentIngestionError("ORGANIZATION_NOT_READY", "Organization data foundation is unavailable.", 503);
      }
      return operation();
    }
  };

export const withDocumentProposalReference = createWithDocumentProposalReference(ensureConversationProposalReference);
