import mongoose from "mongoose";
import Team from "../../../../modal/teamModel";
import TeamMembership from "../../../../modal/teamMembershipModel";
import type { MemberChangeAudit, StaffMemberTeamsStore, TeamDirectory, TeamRef } from "../domain/ports";
import { appendAudit, bumpVersionInTransaction } from "./mongoMembershipStore";

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

class Stale extends Error {
  constructor() { super("member version moved"); }
}

/* One transaction. The chosen teams are written (updatedAt) inside it, so archiving one of them
   concurrently conflicts with this change instead of slipping a member onto an archived team.

   `staff` is given only by the RFPilot staff route (owner decision 2026-11-18): the membership's
   version moves and the staff-side audit event is inserted in this same transaction, so the
   whole change commits with its record or not at all. Without it this is the member path,
   unchanged: the version was bumped by the caller beforehand and no event is written here. */
const setTeams = async (
  { organizationId, userId, teamIds }: { organizationId: string; userId: string; teamIds: string[] },
  staff?: { expectedVersion: number; audit: MemberChangeAudit },
): Promise<{ previousTeamIds: string[]; version: number | null } | { unknownTeamIds: string[] } | "stale"> => {
  const org = objectId(organizationId);
  const user = objectId(userId);
  const session = await mongoose.startSession();
  let previousTeamIds: string[] = [];
  let version: number | null = null;
  try {
    await session.withTransaction(async () => {
      if (staff) {
        version = await bumpVersionInTransaction({ organizationId, userId, expectedVersion: staff.expectedVersion }, session);
        if (version === null) throw new Stale();
      }
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
      if (staff) {
        await appendAudit(staff.audit, session, {
          before: { teamIds: [...currentActive].sort() }, changed: leaving.length > 0 || joining.length > 0, version,
        });
      }
    });
  } catch (error) {
    if (error instanceof TeamsChanged) return { unknownTeamIds: error.unknownTeamIds };
    if (error instanceof Stale) return "stale";
    throw error;
  } finally {
    await session.endSession();
  }
  return { previousTeamIds, version };
};

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

  // Makes the member's active teams exactly teamIds (see `setTeams`). No event, no version.
  async setMemberTeams(input) {
    const result = await setTeams(input);
    if (result === "stale") throw new Error("a member change of teams carries no version");
    return "unknownTeamIds" in result ? result : { previousTeamIds: result.previousTeamIds };
  },
};

// The RFPilot staff route's write: the same change, with the version and the staff-side event
// in its transaction. Used only by staffAccess/composition.ts.
export const mongoStaffMemberTeams: StaffMemberTeamsStore = {
  async setMemberTeams({ organizationId, userId, teamIds, expectedVersion, audit }) {
    const result = await setTeams({ organizationId, userId, teamIds }, { expectedVersion, audit });
    if (result === "stale" || "unknownTeamIds" in result) return result;
    return { previousTeamIds: result.previousTeamIds, version: result.version as number };
  },
};
