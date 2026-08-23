import crypto from "node:crypto";
import Proposal from "../../../modal/proposalsModel";
import { synchronizeProposalReference } from "../dataFoundation/composition";
import { activeProposalWorkflowFingerprintContent } from "../proposals/domain/workflowSections";
import { ConversationError } from "./domain";

type ConversationContext = {
  organizationMongoId: string;
  actorUserMongoId: string;
  correlationId: string;
};

type ProposalReferenceRecord = Record<string, unknown> & {
  _id?: unknown;
};

type Dependencies = {
  findOwnedProposal: (
    ctx: ConversationContext,
    proposalMongoId: string,
  ) => Promise<ProposalReferenceRecord | null>;
  synchronize: typeof synchronizeProposalReference;
};

const unavailable = () =>
  new ConversationError(
    "ORGANIZATION_NOT_READY",
    "Organization data foundation is unavailable.",
    503,
  );

const proposalNotFound = () =>
  new ConversationError(
    "PROPOSAL_NOT_FOUND",
    "Proposal was not found.",
    404,
  );

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
};

const activeChecksum = (proposal: ProposalReferenceRecord) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify(
        canonical(activeProposalWorkflowFingerprintContent(proposal)),
      ),
    )
    .digest("hex");

export const createEnsureConversationProposalReference =
  (dependencies: Dependencies) =>
  async (
    ctx: ConversationContext,
    proposalMongoId: string,
  ): Promise<void> => {
    const proposal = await dependencies.findOwnedProposal(
      ctx,
      proposalMongoId,
    );
    if (!proposal) throw proposalNotFound();
    try {
      const checksum = activeChecksum(proposal);
      const result = await dependencies.synchronize({
        organizationMongoId: ctx.organizationMongoId,
        ownerUserMongoId: ctx.actorUserMongoId,
        proposalMongoId,
        sourceVersion: checksum,
        sourceChecksum: checksum,
        correlationId: ctx.correlationId,
        eventType: "proposal.reference.backfilled",
      });
      if (result.kind !== "synchronized") throw unavailable();
    } catch (error) {
      if (error instanceof ConversationError) throw error;
      throw unavailable();
    }
  };

export const ensureConversationProposalReference =
  createEnsureConversationProposalReference({
    findOwnedProposal: async (ctx, proposalMongoId) =>
      Proposal.findOne({
        _id: proposalMongoId,
        userId: ctx.actorUserMongoId,
        isArchived: { $ne: true },
        $or: [
          { organizationId: ctx.organizationMongoId },
          { organizationId: { $exists: false } },
          { organizationId: null },
        ],
      }).lean<ProposalReferenceRecord>(),
    synchronize: synchronizeProposalReference,
  });

const proposalReferenceMissing = (error: unknown): boolean =>
  error instanceof ConversationError &&
  error.code === "PROPOSAL_NOT_FOUND";

export const createWithConversationProposalReference =
  (
    ensure: (
      ctx: ConversationContext,
      proposalMongoId: string,
    ) => Promise<void>,
  ) =>
  async <T>(
    ctx: ConversationContext,
    proposalMongoId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (!proposalReferenceMissing(error)) throw error;
      await ensure(ctx, proposalMongoId);
      return operation();
    }
  };

export const withConversationProposalReference =
  createWithConversationProposalReference(
    ensureConversationProposalReference,
  );
