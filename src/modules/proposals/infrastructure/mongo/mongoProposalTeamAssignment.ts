import mongoose from "mongoose";
import Proposal from "../../../../../modal/proposalsModel";
import Team from "../../../../../modal/teamModel";
import TeamMembership from "../../../../../modal/teamMembershipModel";
import type { ProposalTeamAssignment } from "../../domain/ports/proposalTeamAssignment";
import { tenantFilter } from "../../../shared/tenancy/tenantContext";

export const mongoProposalTeamAssignment: ProposalTeamAssignment = {
  async defaultTeamFor(ownerUserId) {
    const { organizationId } = tenantFilter();
    const memberships = await TeamMembership.find({ organizationId, userId: ownerUserId }).select("teamId").lean();
    if (memberships.length === 0) return null;
    const active = await Team.find({ _id: { $in: memberships.map((m) => m.teamId) }, organizationId, archived: false }).select("_id").limit(2).lean();
    return active.length === 1 ? String(active[0]._id) : null;
  },

  async isAssignable({ teamId, proposalId }) {
    if (!mongoose.isValidObjectId(teamId)) return false;
    const { organizationId } = tenantFilter();
    if (await Team.exists({ _id: teamId, organizationId, archived: false })) return true;
    return mongoose.isValidObjectId(proposalId) && (await Proposal.exists({ _id: proposalId, organizationId, teamId })) !== null;
  },
};
