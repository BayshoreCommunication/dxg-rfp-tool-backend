import mongoose from "mongoose";
import Proposal from "../../../../../modal/proposalsModel";
import type { ProposalWriteRepository } from "../../domain/ports/proposalWriteRepository";
import { tenantFilter } from "../../../shared/tenancy/tenantContext";
import { claimProposalSlot } from "../../../entitlements/infrastructure/mongoOrganizationEntitlements";
import { assertEditUpdateIsSafe, withoutTenancyFields } from "../../domain/proposalFieldOwnership";
import type { RfpAction } from "../../../identity/domain/rfpAccessPolicy";
import {
  assertProposalMissIsNotFound,
  requestActorFor,
  scopeProposalFilter,
} from "../../../identity/application/proposalAccess";

// Single-proposal filter scoped by the access policy for the requesting actor.
const scoped = (actorUserId: string, action: RfpAction, filter: Record<string, unknown>) =>
  scopeProposalFilter(requestActorFor(actorUserId), action, filter);

// A miss on a proposal the actor can see in their organization but may not act on is a 403.
const explainMiss = (actorUserId: string, proposalId: string, action: RfpAction) =>
  assertProposalMissIsNotFound(requestActorFor(actorUserId), proposalId, action);

const DETAIL_PROPOSAL_SELECT = "-__v";

export const mongoProposalWriteRepository: ProposalWriteRepository = {
  // The only place a proposal row is inserted (new, copy and from a template, ORG-604). The plan's
  // slot is taken and the row inserted in one transaction (ORG-601): a create at the limit throws
  // PlanLimitReachedError, a failed insert doesn't use a slot, and Organization.proposalsCreated
  // counts every proposal ever created.
  async createOwned({ ownerUserId, proposal }) {
    const tenant = tenantFilter();
    const session = await mongoose.startSession();
    try {
      const created = await session.withTransaction(async () => {
        await claimProposalSlot(tenant.organizationId, session);
        // A fresh document per attempt: the driver re-runs this callback on a write conflict.
        const document = new Proposal({ ...withoutTenancyFields(proposal), userId: ownerUserId, ...tenant });
        await document.save({ session });
        return document;
      });
      return created.toObject();
    } finally {
      await session.endSession();
    }
  },

  async findOwnedCopySourceById({ proposalId, ownerUserId }) {
    const proposal = await Proposal.findOne(scoped(ownerUserId, "view", { _id: proposalId })).lean();
    if (!proposal) await explainMiss(ownerUserId, proposalId, "view");
    return proposal;
  },

  async findOwnedLifecycleById({ proposalId, ownerUserId }) {
    const proposal = await Proposal.findOne(scoped(ownerUserId, "edit", { _id: proposalId }))
      .select("isCopy")
      .lean<{ isCopy?: boolean }>();
    if (!proposal) await explainMiss(ownerUserId, proposalId, "edit");
    return proposal ? { isCopy: proposal.isCopy === true } : null;
  },

  async updateOwnedById({
    proposalId,
    ownerUserId,
    updates,
    runValidators,
  }) {
    // Backstop: this update can't move the proposal to another organization or owner, change its
    // archive state or lifecycle, or carry an operator, whatever the caller built.
    assertEditUpdateIsSafe(updates);
    // A proposal whose permanent delete has started is no longer editable.
    const proposal = await Proposal.findOneAndUpdate(
      scoped(ownerUserId, "edit", { _id: proposalId, purgeStarted: { $ne: true } }),
      { $set: updates },
      // context:"query" binds conditional validators to the query so they can
      // read the pending update; without it they see no lifecycle fields at all.
      { new: true, ...(runValidators ? { runValidators: true, context: "query" as const } : {}) },
    )
      .select(DETAIL_PROPOSAL_SELECT)
      .lean();
    if (!proposal) await explainMiss(ownerUserId, proposalId, "edit");
    return proposal;
  },

  async incrementOwnedViews({ proposalId, ownerUserId }) {
    const proposal = await Proposal.findOneAndUpdate(
      scoped(ownerUserId, "view", { _id: proposalId }),
      { $inc: { viewsCount: 1 } },
      { new: true },
    )
      .select(DETAIL_PROPOSAL_SELECT)
      .lean();
    if (!proposal) await explainMiss(ownerUserId, proposalId, "view");
    return proposal;
  },

  async archiveOwnedById({ proposalId, ownerUserId, archivedAt }) {
    const proposal = await Proposal.findOneAndUpdate(
      scoped(ownerUserId, "archive", { _id: proposalId, isArchived: { $ne: true } }),
      { $set: { isArchived: true, archivedAt } },
      { new: true },
    ).select("_id");
    if (!proposal) await explainMiss(ownerUserId, proposalId, "archive");
    return proposal !== null;
  },

  async restoreOwnedById({ proposalId, ownerUserId }) {
    // The condition and the write are one atomic update, so a restore and the
    // start of a permanent delete cannot both win.
    const proposal = await Proposal.findOneAndUpdate(
      scoped(ownerUserId, "archive", { _id: proposalId, isArchived: true, purgeStarted: { $ne: true } }),
      { $set: { isArchived: false }, $unset: { archivedAt: "" } },
      { new: true },
    ).select("_id");
    if (proposal) return true;
    const beingDeleted = await Proposal.findOne(
      scoped(ownerUserId, "archive", { _id: proposalId, isArchived: true, purgeStarted: true }),
    ).select("_id").lean();
    if (beingDeleted) return "being_deleted";
    await explainMiss(ownerUserId, proposalId, "archive");
    return false;
  },

  async findOwnedArchivedPurgeTargetById({ proposalId, ownerUserId }) {
    const proposal = await Proposal.findOne(scoped(ownerUserId, "delete", { _id: proposalId, isArchived: true }))
      .select("_id organizationId")
      .lean<{ _id: unknown; organizationId?: unknown } | null>();
    if (!proposal) {
      await explainMiss(ownerUserId, proposalId, "delete");
      return null;
    }
    return {
      proposalMongoId: String(proposal._id),
      organizationMongoId: proposal.organizationId ? String(proposal.organizationId) : "",
    };
  },

  async markOwnedArchivedPurgeStartedById({ proposalId, ownerUserId }) {
    // The first start time is kept; `timestamps: false` leaves updatedAt alone.
    const started = await Proposal.findOneAndUpdate(
      scoped(ownerUserId, "delete", { _id: proposalId, isArchived: true, purgeStarted: { $ne: true } }),
      { $set: { purgeStarted: true, purgeStartedAt: new Date() } },
      { new: true, timestamps: false },
    ).select("_id");
    if (started) return true;
    const already = await Proposal.findOne(
      scoped(ownerUserId, "delete", { _id: proposalId, isArchived: true, purgeStarted: true }),
    ).select("_id").lean();
    return already !== null;
  },

  async permanentlyDeleteOwnedArchivedById({ proposalId, ownerUserId }) {
    const proposal = await Proposal.findOneAndDelete(
      scoped(ownerUserId, "delete", { _id: proposalId, isArchived: true }),
    ).select("_id");
    if (!proposal) await explainMiss(ownerUserId, proposalId, "delete");
    return proposal !== null;
  },
};
