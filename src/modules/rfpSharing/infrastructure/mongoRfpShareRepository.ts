import mongoose from "mongoose";
import Proposal from "../../../../modal/proposalsModel";
import RfpShare from "../../../../modal/rfpShareModel";
import OrganizationMembership from "../../../../modal/organizationMembershipModel";
import type { SharePermission } from "../../identity/domain/rfpAccessPolicy";
import type { ShareMemberDirectory, SharedProposalLookup, ShareRepository } from "../domain";

export const mongoRfpShareRepository: ShareRepository = {
  async list(organizationId, proposalId) {
    const shares = await RfpShare.find({ organizationId, proposalId }).sort({ createdAt: 1 }).lean();
    return shares.map((share) => ({
      userId: String(share.userId),
      permission: share.permission,
      grantedBy: String(share.grantedBy),
      createdAt: share.createdAt,
      updatedAt: share.updatedAt,
    }));
  },

  async upsert({ organizationId, proposalId, userId, permission, grantedBy }) {
    const previous = await RfpShare.findOneAndUpdate(
      { organizationId, proposalId, userId },
      { $set: { permission, grantedBy } },
      { upsert: true, new: false },
    ).select("permission").lean();
    return (previous?.permission as SharePermission | undefined) ?? null;
  },

  async remove({ organizationId, proposalId, userId }) {
    const removed = await RfpShare.findOneAndDelete({ organizationId, proposalId, userId }).select("permission").lean();
    return (removed?.permission as SharePermission | undefined) ?? null;
  },
};

export const mongoSharedProposalLookup: SharedProposalLookup = {
  async find(organizationId, proposalId) {
    const proposal = await Proposal.findOne({ _id: proposalId, organizationId })
      .select("organizationId userId teamId")
      .lean<{ _id: unknown; organizationId?: unknown; userId?: unknown; teamId?: unknown } | null>();
    if (!proposal) return null;
    return {
      id: String(proposal._id),
      organizationId: proposal.organizationId ? String(proposal.organizationId) : null,
      ownerUserId: proposal.userId ? String(proposal.userId) : null,
      teamId: proposal.teamId ? String(proposal.teamId) : null,
    };
  },
};

export const mongoShareMemberDirectory: ShareMemberDirectory = {
  async find(organizationId, userIds) {
    if (userIds.length === 0) return new Map();
    const memberships = await OrganizationMembership.find({ organizationId, userId: { $in: userIds } }).select("userId roles status").lean();
    return new Map(memberships.map((m) => [String(m.userId), { roles: m.roles, status: m.status }]));
  },
};

export const isValidShareId = (value: string) => mongoose.isValidObjectId(value) && /^[0-9a-f]{24}$/i.test(value);
