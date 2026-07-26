import Proposal from "../../../../../modal/proposalsModel";
import type { ProposalWriteRepository } from "../../domain/ports/proposalWriteRepository";
import { tenantFilter } from "../../../shared/tenancy/tenantContext";

const DETAIL_PROPOSAL_SELECT = "-__v";

export const mongoProposalWriteRepository: ProposalWriteRepository = {
  async createOwned({ ownerUserId, proposal }) {
    const created = new Proposal({ ...proposal, userId: ownerUserId, ...tenantFilter() });
    await created.save();
    return created.toObject();
  },

  async findOwnedCopySourceById({ proposalId, ownerUserId }) {
    return Proposal.findOne({ _id: proposalId, userId: ownerUserId, ...tenantFilter() }).lean();
  },

  async findOwnedLifecycleById({ proposalId, ownerUserId }) {
    const proposal = await Proposal.findOne({
      _id: proposalId,
      userId: ownerUserId,
      ...tenantFilter(),
    })
      .select("isCopy")
      .lean<{ isCopy?: boolean }>();
    return proposal ? { isCopy: proposal.isCopy === true } : null;
  },

  async updateOwnedById({
    proposalId,
    ownerUserId,
    updates,
    runValidators,
  }) {
    return Proposal.findOneAndUpdate(
      { _id: proposalId, userId: ownerUserId, ...tenantFilter() },
      { $set: updates },
      { new: true, ...(runValidators ? { runValidators: true } : {}) },
    )
      .select(DETAIL_PROPOSAL_SELECT)
      .lean();
  },

  async incrementOwnedViews({ proposalId, ownerUserId }) {
    return Proposal.findOneAndUpdate(
      { _id: proposalId, userId: ownerUserId, ...tenantFilter() },
      { $inc: { viewsCount: 1 } },
      { new: true },
    )
      .select(DETAIL_PROPOSAL_SELECT)
      .lean();
  },

  async archiveOwnedById({ proposalId, ownerUserId, archivedAt }) {
    const proposal = await Proposal.findOneAndUpdate(
      { _id: proposalId, userId: ownerUserId, isArchived: { $ne: true }, ...tenantFilter() },
      { $set: { isArchived: true, archivedAt } },
      { new: true },
    ).select("_id");
    return proposal !== null;
  },

  async restoreOwnedById({ proposalId, ownerUserId }) {
    const proposal = await Proposal.findOneAndUpdate(
      { _id: proposalId, userId: ownerUserId, isArchived: true, ...tenantFilter() },
      { $set: { isArchived: false }, $unset: { archivedAt: "" } },
      { new: true },
    ).select("_id");
    return proposal !== null;
  },

  async permanentlyDeleteOwnedArchivedById({ proposalId, ownerUserId }) {
    const proposal = await Proposal.findOneAndDelete({
      _id: proposalId,
      userId: ownerUserId,
      isArchived: true,
      ...tenantFilter(),
    }).select("_id");
    return proposal !== null;
  },
};
