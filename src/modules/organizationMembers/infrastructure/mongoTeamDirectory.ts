import mongoose from "mongoose";
import Team from "../../../../modal/teamModel";
import TeamMembership from "../../../../modal/teamMembershipModel";
import type { TeamDirectory, TeamRef } from "../domain/ports";

// ORG-206 "change a member's teams" over ORG-201's Team and TeamMembership. Only active teams of
// the member's organization count: archived teams keep their memberships for history and are
// neither listed nor assignable, and another organization's team id is simply unknown.

const objectId = (value: string) => new mongoose.Types.ObjectId(value);

const activeTeams = (organizationId: string, teamIds: string[], session?: mongoose.ClientSession) =>
  Team.find({ _id: { $in: teamIds.map(objectId) }, organizationId: objectId(organizationId), archived: false })
    .select("_id name").session(session ?? null).lean<{ _id: unknown; name: string }[]>();

class TeamsChanged extends Error {
  constructor(readonly unknownTeamIds: string[]) { super("teams changed"); }
}

export const mongoTeamDirectory: TeamDirectory = {
  async teamsFor(organizationId, userIds) {
    const result = new Map<string, TeamRef[]>();
    if (userIds.length === 0) return result;
    const memberships = await TeamMembership.find({ organizationId: objectId(organizationId), userId: { $in: userIds.map(objectId) } })
      .select("teamId userId").lean();
    const teams = await activeTeams(organizationId, [...new Set(memberships.map((m) => String(m.teamId)))]);
    const byId = new Map(teams.map((t) => [String(t._id), { id: String(t._id), name: t.name }]));
    for (const membership of memberships) {
      const team = byId.get(String(membership.teamId));
      if (!team) continue;
      const list = result.get(String(membership.userId)) ?? [];
      list.push(team);
      result.set(String(membership.userId), list);
    }
    for (const list of result.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  },

  async activeTeamIds(organizationId, teamIds) {
    if (teamIds.length === 0) return [];
    return (await activeTeams(organizationId, teamIds)).map((t) => String(t._id));
  },

  // One transaction. The chosen teams are written (updatedAt) inside it, so archiving one of them
  // concurrently conflicts with this change instead of slipping a member onto an archived team.
  async setMemberTeams({ organizationId, userId, teamIds }) {
    const org = objectId(organizationId);
    const user = objectId(userId);
    const session = await mongoose.startSession();
    let previousTeamIds: string[] = [];
    try {
      await session.withTransaction(async () => {
        if (teamIds.length > 0) {
          const touched = await Team.updateMany(
            { _id: { $in: teamIds.map(objectId) }, organizationId: org, archived: false },
            { $set: { updatedAt: new Date() } },
            { session },
          );
          if (touched.matchedCount !== teamIds.length) {
            const active = new Set((await activeTeams(organizationId, teamIds, session)).map((t) => String(t._id)));
            throw new TeamsChanged(teamIds.filter((id) => !active.has(id)));
          }
        }
        const current = await TeamMembership.find({ organizationId: org, userId: user }).select("teamId").session(session).lean();
        const currentActive = (await activeTeams(organizationId, current.map((m) => String(m.teamId)), session)).map((t) => String(t._id));
        previousTeamIds = currentActive;
        const leaving = currentActive.filter((id) => !teamIds.includes(id));
        const joining = teamIds.filter((id) => !currentActive.includes(id));
        if (leaving.length) await TeamMembership.deleteMany({ organizationId: org, userId: user, teamId: { $in: leaving.map(objectId) } }, { session });
        if (joining.length) {
          await TeamMembership.create(joining.map((teamId) => ({ organizationId: org, teamId: objectId(teamId), userId: user, isManager: false })), { session, ordered: true });
        }
      });
    } catch (error) {
      if (error instanceof TeamsChanged) return { unknownTeamIds: error.unknownTeamIds };
      throw error;
    } finally {
      await session.endSession();
    }
    return { previousTeamIds };
  },
};
