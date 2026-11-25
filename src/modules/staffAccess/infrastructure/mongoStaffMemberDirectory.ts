import mongoose from "mongoose";
import Admin from "../../../../modal/adminModel";
import Organization from "../../../../modal/organizationModel";
import OrganizationMembership from "../../../../modal/organizationMembershipModel";
import Team from "../../../../modal/teamModel";
import TeamMembership from "../../../../modal/teamMembershipModel";
import User from "../../../../modal/userModel";
import type { StaffManagedOrganization, StaffMemberDirectory, StaffMemberView } from "../domain";

/* Reads behind the staff member read, team read and organization block. Only RFPilot staff reach
   this, through routes/adminOrganizationMembersRoute.ts. Every query on customer data names the
   organization the request's path gave AND, for a member, that member's user id: a member of
   another organization is not found. The person's name and email are read from `users` by the id
   on that organization's own membership row. Every `.select()` is an allowlist and the view is
   built field by field. This file performs no write. */

const oid = (value: string) => new mongoose.Types.ObjectId(value);
const date = (value: unknown): Date | null => (value instanceof Date ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

type Row = Record<string, unknown>;

const TEAM_MEMBERSHIP_LIMIT = 500;

export const mongoStaffMemberDirectory: StaffMemberDirectory = {
  async organization(organizationId) {
    const organization = oid(organizationId);
    const [doc, staffAccountCount] = await Promise.all([
      Organization.findOne({ _id: organization }).select("kind").lean<Row>(),
      // RFPilot's own organization is one that `admins` accounts belong to.
      Admin.countDocuments({ organizationId: organization }),
    ]);
    if (!doc) return null;
    const found: StaffManagedOrganization = { id: String(doc._id), kind: str(doc.kind) || "customer", staffAccountCount };
    return found;
  },

  async member(organizationId, userId) {
    const organization = oid(organizationId);
    const user = oid(userId);
    const row = await OrganizationMembership.findOne({ organizationId: organization, userId: user })
      .select("userId roles status version activatedAt lastSignedInAt createdAt").lean<Row>();
    if (!row) return null;
    const [person, teamRows] = await Promise.all([
      User.findOne({ _id: user }).select("name email").lean<Row>(),
      TeamMembership.find({ organizationId: organization, userId: user }).select("teamId isManager").limit(TEAM_MEMBERSHIP_LIMIT).lean<Row[]>(),
    ]);
    const teams = teamRows.length === 0
      ? []
      : await Team.find({ organizationId: organization, _id: { $in: teamRows.map((membership) => membership.teamId) } }).select("name archived").lean<Row[]>();
    const teamById = new Map(teams.map((team) => [String(team._id), team]));
    const member: StaffMemberView = {
      userId: String(row.userId),
      name: text(person?.name),
      email: text(person?.email),
      roles: Array.isArray(row.roles) ? row.roles.map(String) : [],
      status: str(row.status),
      teams: teamRows
        .filter((membership) => teamById.has(String(membership.teamId)))
        .map((membership) => {
          const team = teamById.get(String(membership.teamId)) as Row;
          return { id: String(team._id), name: str(team.name), archived: team.archived === true, isManager: membership.isManager === true };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })),
      joinedAt: date(row.activatedAt) ?? date(row.createdAt),
      lastSignedInAt: date(row.lastSignedInAt),
    };
    return { member, version: Number(row.version ?? 1) };
  },
};
