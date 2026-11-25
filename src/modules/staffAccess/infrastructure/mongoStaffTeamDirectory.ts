import mongoose from "mongoose";
import Team from "../../../../modal/teamModel";
import TeamMembership from "../../../../modal/teamMembershipModel";
import type { StaffMemberDirectory, StaffTeamDetail, StaffTeamDirectory } from "../domain";
import { mongoStaffMemberDirectory } from "./mongoStaffMemberDirectory";

/* The read behind the staff team read. Only RFPilot staff reach
   this, through routes/adminOrganizationTeamsRoute.ts. Every query names the organization the
   request's path gave AND the team: a team of another organization is not found, and only that
   organization's own team rows are listed. Each member is read through the staff member
   directory (the organization's own membership row, name and email only). Every `.select()` is
   an allowlist and the view is built field by field. This file performs no write. */

const oid = (value: string) => new mongoose.Types.ObjectId(value);
const date = (value: unknown): Date | null => (value instanceof Date ? value : null);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

type Row = Record<string, unknown>;

// Members returned with a team. `memberCount` is the true count, whatever this is.
export const STAFF_TEAM_MEMBER_LIMIT = 200;
// Managers returned with a team. Read on their own, so a manager is listed wherever they sort among the members.
export const STAFF_TEAM_MANAGER_LIMIT = 200;
const LOOKUPS_AT_ONCE = 10;

export const createMongoStaffTeamDirectory = (members: Pick<StaffMemberDirectory, "member">): StaffTeamDirectory => ({
  async team(organizationId, teamId) {
    const organization = oid(organizationId);
    const team = await Team.findOne({ organizationId: organization, _id: oid(teamId) }).select("name archived archivedAt createdAt").lean<Row>();
    if (!team) return null;
    const [rows, memberCount, managerRows] = await Promise.all([
      TeamMembership.find({ organizationId: organization, teamId: team._id }).select("userId isManager")
        .sort({ createdAt: 1, _id: 1 }).limit(STAFF_TEAM_MEMBER_LIMIT).lean<Row[]>(),
      TeamMembership.countDocuments({ organizationId: organization, teamId: team._id }),
      // The team's managers, whether or not they are among the members returned above.
      TeamMembership.find({ organizationId: organization, teamId: team._id, isManager: true }).select("userId")
        .sort({ createdAt: 1, _id: 1 }).limit(STAFF_TEAM_MANAGER_LIMIT).lean<Row[]>(),
    ]);
    type Found = NonNullable<Awaited<ReturnType<typeof members.member>>>;
    const known = new Map<string, Found>();
    // The member is looked up in the SAME organization: a row whose user is not a member of it is left out.
    const lookUp = async (list: Row[]) => {
      // A manager already read as one of the members above is not read twice.
      const missing = list.filter((row) => !known.has(String(row.userId)));
      for (let start = 0; start < missing.length; start += LOOKUPS_AT_ONCE) {
        const batch = missing.slice(start, start + LOOKUPS_AT_ONCE);
        const found = await Promise.all(batch.map((row) => members.member(organizationId, String(row.userId))));
        found.forEach((member, index) => {
          if (member) known.set(String(batch[index].userId), member);
        });
      }
    };
    await lookUp(rows);
    const detail: StaffTeamDetail["members"] = [];
    for (const row of rows) {
      const member = known.get(String(row.userId));
      if (member) detail.push({ member: member.member, version: member.version, isManager: row.isManager === true });
    }
    await lookUp(managerRows);
    const managers: StaffTeamDetail["team"]["managers"] = [];
    for (const row of managerRows) {
      const member = known.get(String(row.userId));
      if (member) managers.push({ id: member.member.userId, name: member.member.name, email: member.member.email });
    }
    return {
      team: {
        id: String(team._id),
        name: str(team.name),
        archived: team.archived === true,
        archivedAt: date(team.archivedAt),
        createdAt: date(team.createdAt),
        memberCount,
        managers,
      },
      members: detail,
    };
  },
});

export const mongoStaffTeamDirectory = createMongoStaffTeamDirectory(mongoStaffMemberDirectory);
