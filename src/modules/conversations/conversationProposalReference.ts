import crypto from "node:crypto";
import Proposal from "../../../modal/proposalsModel";
import { synchronizeProposalReference } from "../dataFoundation/composition";
import { ConversationError } from "./domain";

type ConversationContext = {
  organizationMongoId: string;
  actorUserMongoId: string;
  correlationId: string;
};

type ProposalReferenceRecord = {
  _id?: unknown;
  __v?: unknown;
  version?: unknown;
  updatedAt?: unknown;
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

const metadataChecksum = (
  ctx: ConversationContext,
  proposalMongoId: string,
  proposal: ProposalReferenceRecord,
) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        organizationMongoId: ctx.organizationMongoId,
        ownerUserMongoId: ctx.actorUserMongoId,
        proposalMongoId,
        sourceVersion: proposal.version ?? proposal.__v ?? 0,
        sourceUpdatedAt:
          proposal.updatedAt instanceof Date
            ? proposal.updatedAt.toISOString()
            : null,
      }),
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
      const result = await dependencies.synchronize({
        organizationMongoId: ctx.organizationMongoId,
        ownerUserMongoId: ctx.actorUserMongoId,
        proposalMongoId,
        sourceVersion: String(proposal.version ?? proposal.__v ?? 0),
        sourceChecksum: metadataChecksum(ctx, proposalMongoId, proposal),
        sourceUpdatedAt:
          proposal.updatedAt instanceof Date
            ? proposal.updatedAt
            : undefined,
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
      })
        .select("_id __v version updatedAt")
        .lean<ProposalReferenceRecord>(),
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
