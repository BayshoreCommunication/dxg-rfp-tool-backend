import mongoose from "mongoose";
import Team from "../../../../modal/teamModel";
import TeamMembership from "../../../../modal/teamMembershipModel";
import type { StaffMemberDirectory, StaffTeamDetail, StaffTeamDirectory } from "../domain";
import { mongoStaffMemberDirectory } from "./mongoStaffMemberDirectory";

/* The read behind staff team management (owner decision, 2026-11-18). Only RFPilot staff reach
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
const LOOKUPS_AT_ONCE = 10;

export const createMongoStaffTeamDirectory = (members: Pick<StaffMemberDirectory, "member">): StaffTeamDirectory => ({
  async team(organizationId, teamId) {
    const organization = oid(organizationId);
    const team = await Team.findOne({ organizationId: organization, _id: oid(teamId) }).select("name archived archivedAt createdAt").lean<Row>();
    if (!team) return null;
    const [rows, memberCount] = await Promise.all([
      TeamMembership.find({ organizationId: organization, teamId: team._id }).select("userId isManager")
        .sort({ createdAt: 1, _id: 1 }).limit(STAFF_TEAM_MEMBER_LIMIT).lean<Row[]>(),
      TeamMembership.countDocuments({ organizationId: organization, teamId: team._id }),
    ]);
    const detail: StaffTeamDetail["members"] = [];
    for (let start = 0; start < rows.length; start += LOOKUPS_AT_ONCE) {
      const batch = rows.slice(start, start + LOOKUPS_AT_ONCE);
      // The member is looked up in the SAME organization: a row whose user is not a member of it is left out.
      const found = await Promise.all(batch.map((row) => members.member(organizationId, String(row.userId))));
      found.forEach((member, index) => {
        if (member) detail.push({ member: member.member, version: member.version, isManager: batch[index].isManager === true });
      });
    }
    return {
      team: {
        id: String(team._id),
        name: str(team.name),
        archived: team.archived === true,
        archivedAt: date(team.archivedAt),
        createdAt: date(team.createdAt),
        memberCount,
        managers: detail.filter((entry) => entry.isManager).map((entry) => ({ id: entry.member.userId, name: entry.member.name, email: entry.member.email })),
      },
      members: detail,
    };
  },
});

export const mongoStaffTeamDirectory = createMongoStaffTeamDirectory(mongoStaffMemberDirectory);
