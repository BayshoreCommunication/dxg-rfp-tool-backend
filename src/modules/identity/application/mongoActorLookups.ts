import Team from "../../../../modal/teamModel";
import TeamMembership from "../../../../modal/teamMembershipModel";
import type { ActorLookups } from "./resolveRfpActor";

// Teams and shares behind each request's RfpActor. Only active teams count, so archiving a team
// ends its managers' scope over the team's proposals on their next request.
export const mongoActorLookups: ActorLookups = {
  async managedTeamIds({ organizationId, userId }) {
    const managed = await TeamMembership.find({ organizationId, userId, isManager: true }).select("teamId").lean();
    if (managed.length === 0) return [];
    const active = await Team.find({ _id: { $in: managed.map((m) => m.teamId) }, organizationId, archived: false }).select("_id").lean();
    return active.map((team) => String(team._id));
  },
  shares: async () => new Map(),
};
