import mongoose from "mongoose";
import Invitation from "../../../../modal/invitationModel";
import Organization from "../../../../modal/organizationModel";
import OrganizationMembership from "../../../../modal/organizationMembershipModel";
import OrganizationVendor from "../../../../modal/organizationVendorModel";
import ProposalTemplate from "../../../../modal/proposalTemplateModel";
import Team from "../../../../modal/teamModel";
import TeamMembership from "../../../../modal/teamMembershipModel";
import User from "../../../../modal/userModel";
import type {
  StaffInvitationView,
  StaffMemberView,
  StaffOrganizationReader,
  StaffOrganizationRef,
  StaffPerson,
  StaffTeamView,
  StaffTemplateDetail,
  StaffTemplateSummary,
  StaffVendorView,
} from "../domain";

/* Staff reads of one customer organization (owner decision, 2026-11-17). Only RFPilot staff
   reach this (routes/adminOrganizationContentRoute.ts and the staff half of
   routes/supportAccessRoute.ts). Every query on customer data names the organization the
   request's path gave, as `organizationId`; nothing reads the caller's tenant context. People
   are read from `users` by ids taken from that organization's own rows, and only their name and
   email are selected.

   Every `.select()` is an allowlist and every view is built field by field: no stored document
   is spread into a result. Never selected: password hashes, two-factor data, federated
   identities, invitation token hashes, session data, SSO configuration. This file performs no
   write. */

const oid = (value: string) => new mongoose.Types.ObjectId(value);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const collation = { locale: "en", strength: 2 } as const;
const date = (value: unknown): Date | null => (value instanceof Date ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

type Row = Record<string, unknown>;

const TEAM_LIMIT = 500;
const TEAM_MEMBERSHIP_LIMIT = 20_000;

// Names and emails of people whose ids came from rows of the organization being read.
const people = async (userIds: readonly string[]): Promise<Map<string, StaffPerson>> => {
  const ids = [...new Set(userIds)].filter((id) => mongoose.isValidObjectId(id));
  if (ids.length === 0) return new Map();
  const docs = await User.find({ _id: { $in: ids.map(oid) } }).select("name email").lean<Row[]>();
  return new Map(docs.map((doc) => [String(doc._id), { id: String(doc._id), name: text(doc.name), email: text(doc.email) }]));
};

const organizationRef = (doc: Row): StaffOrganizationRef => ({ id: String(doc._id), name: str(doc.name), createdAt: date(doc.createdAt) });

const TEMPLATE_SUMMARY_FIELDS = "ownerUserId scope title description presentationLayout publishedAt archived archivedAt createdAt updatedAt content.event.eventName";
const TEMPLATE_DETAIL_FIELDS = "ownerUserId scope title description presentationLayout publishedAt archived archivedAt createdAt updatedAt content";

const templateSummary = (doc: Row, owners: Map<string, StaffPerson>): StaffTemplateSummary => {
  const eventName = ((doc.content as { event?: { eventName?: unknown } } | undefined)?.event ?? {}).eventName;
  const ownerId = doc.ownerUserId ? String(doc.ownerUserId) : null;
  return {
    id: String(doc._id),
    scope: str(doc.scope),
    title: str(doc.title),
    description: str(doc.description),
    eventName: str(eventName),
    presentationLayout: text(doc.presentationLayout),
    publishedAt: date(doc.publishedAt),
    archived: doc.archived === true,
    archivedAt: date(doc.archivedAt),
    createdAt: date(doc.createdAt),
    updatedAt: date(doc.updatedAt),
    owner: ownerId ? owners.get(ownerId) ?? { id: ownerId, name: null, email: null } : null,
  };
};

export const mongoStaffOrganizationReader: StaffOrganizationReader = {
  async organization(organizationId) {
    const doc = await Organization.findOne({ _id: oid(organizationId) }).select("name createdAt").lean<Row>();
    return doc ? organizationRef(doc) : null;
  },

  async organizations(limit) {
    // Spans organizations by design: the staff directory of organizations (names only).
    const docs = await Organization.find({}).select("name createdAt").sort({ kind: 1, name: 1, _id: 1 }).limit(limit).lean<Row[]>();
    return docs.map(organizationRef);
  },

  async members(organizationId, page) {
    const organization = oid(organizationId);
    const [rows, total] = await Promise.all([
      OrganizationMembership.find({ organizationId: organization })
        .select("userId roles status activatedAt lastSignedInAt createdAt")
        .sort({ createdAt: 1, _id: 1 }).skip(page.skip).limit(page.limit).lean<Row[]>(),
      OrganizationMembership.countDocuments({ organizationId: organization }),
    ]);
    const userIds = rows.map((row) => String(row.userId));
    const [names, teamRows] = await Promise.all([
      people(userIds),
      userIds.length === 0
        ? Promise.resolve([] as Row[])
        : TeamMembership.find({ organizationId: organization, userId: { $in: userIds.map(oid) } })
          .select("teamId userId isManager").limit(TEAM_MEMBERSHIP_LIMIT).lean<Row[]>(),
    ]);
    const teamIds = [...new Set(teamRows.map((row) => String(row.teamId)))];
    const teams = teamIds.length === 0
      ? []
      : await Team.find({ organizationId: organization, _id: { $in: teamIds.map(oid) } }).select("name archived").lean<Row[]>();
    const teamById = new Map(teams.map((team) => [String(team._id), team]));
    const members: StaffMemberView[] = rows.map((row) => {
      const userId = String(row.userId);
      const person = names.get(userId);
      return {
        userId,
        name: person?.name ?? null,
        email: person?.email ?? null,
        roles: Array.isArray(row.roles) ? row.roles.map(String) : [],
        status: str(row.status),
        teams: teamRows
          .filter((membership) => String(membership.userId) === userId && teamById.has(String(membership.teamId)))
          .map((membership) => {
            const team = teamById.get(String(membership.teamId)) as Row;
            return { id: String(team._id), name: str(team.name), archived: team.archived === true, isManager: membership.isManager === true };
          })
          .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })),
        joinedAt: date(row.activatedAt) ?? date(row.createdAt),
        lastSignedInAt: date(row.lastSignedInAt),
      };
    });
    return { members, total };
  },

  async pendingInvitations(organizationId, limit) {
    const filter = { organizationId: oid(organizationId), status: "pending" };
    const [rows, total] = await Promise.all([
      // The token hashes and delivery bookkeeping are never selected.
      Invitation.find(filter).select("email role status expiresAt createdAt").sort({ createdAt: -1, _id: -1 }).limit(limit).lean<Row[]>(),
      Invitation.countDocuments(filter),
    ]);
    const invitations: StaffInvitationView[] = rows.map((row) => ({
      id: String(row._id),
      email: str(row.email),
      role: str(row.role),
      status: str(row.status),
      expiresAt: date(row.expiresAt),
      createdAt: date(row.createdAt),
    }));
    return { invitations, total };
  },

  async teams(organizationId) {
    const organization = oid(organizationId);
    const teams = await Team.find({ organizationId: organization })
      .select("name archived archivedAt createdAt")
      .sort({ archived: 1, name: 1 }).collation(collation).limit(TEAM_LIMIT).lean<Row[]>();
    if (teams.length === 0) return [];
    const memberships = await TeamMembership.find({ organizationId: organization, teamId: { $in: teams.map((team) => team._id) } })
      .select("teamId userId isManager").limit(TEAM_MEMBERSHIP_LIMIT).lean<Row[]>();
    const managers = await people(memberships.filter((row) => row.isManager === true).map((row) => String(row.userId)));
    return teams.map((team): StaffTeamView => {
      const own = memberships.filter((row) => String(row.teamId) === String(team._id));
      return {
        id: String(team._id),
        name: str(team.name),
        archived: team.archived === true,
        archivedAt: date(team.archivedAt),
        createdAt: date(team.createdAt),
        memberCount: own.length,
        managers: own.filter((row) => row.isManager === true).map((row) => {
          const id = String(row.userId);
          return managers.get(id) ?? { id, name: null, email: null };
        }),
      };
    });
  },

  async templates(organizationId, filter) {
    // Organization AND personal templates of every member: staff see all of them.
    const organization = oid(organizationId);
    const query: Record<string, unknown> = {};
    if (filter.scope !== "all") query.scope = filter.scope;
    if (filter.status !== "all") query.archived = filter.status === "archived";
    if (filter.search) {
      const contains = { $regex: escapeRegex(filter.search), $options: "i" };
      query.$or = [{ title: contains }, { description: contains }];
    }
    const [docs, total] = await Promise.all([
      ProposalTemplate.find({ organizationId: organization, ...query }).select(TEMPLATE_SUMMARY_FIELDS)
        .sort({ title: 1, _id: 1 }).collation(collation).skip(filter.skip).limit(filter.limit).lean<Row[]>(),
      ProposalTemplate.countDocuments({ organizationId: organization, ...query }),
    ]);
    const owners = await people(docs.flatMap((doc) => (doc.ownerUserId ? [String(doc.ownerUserId)] : [])));
    return { templates: docs.map((doc) => templateSummary(doc, owners)), total };
  },

  async template(organizationId, templateId) {
    const doc = await ProposalTemplate.findOne({ _id: oid(templateId), organizationId: oid(organizationId) })
      .select(TEMPLATE_DETAIL_FIELDS).lean<Row>();
    if (!doc) return null;
    const owners = await people(doc.ownerUserId ? [String(doc.ownerUserId)] : []);
    const content = typeof doc.content === "object" && doc.content !== null && !Array.isArray(doc.content) ? (doc.content as Record<string, unknown>) : {};
    const detail: StaffTemplateDetail = { ...templateSummary(doc, owners), content };
    return detail;
  },

  async vendors(organizationId, filter) {
    const organization = oid(organizationId);
    const query: Record<string, unknown> = {};
    if (filter.status !== "all") query.archived = filter.status === "archived";
    if (filter.category) query.category = { $regex: `^${escapeRegex(filter.category)}$`, $options: "i" };
    if (filter.search) {
      const contains = { $regex: escapeRegex(filter.search), $options: "i" };
      query.$or = [{ company: contains }, { category: contains }];
    }
    const [docs, total] = await Promise.all([
      OrganizationVendor.find({ organizationId: organization, ...query }).select("company category contacts addedBy archived archivedAt createdAt updatedAt")
        .sort({ company: 1, _id: 1 }).collation(collation).skip(filter.skip).limit(filter.limit).lean<Row[]>(),
      OrganizationVendor.countDocuments({ organizationId: organization, ...query }),
    ]);
    const vendors: StaffVendorView[] = docs.map((doc) => ({
      id: String(doc._id),
      company: str(doc.company),
      category: str(doc.category),
      contacts: (Array.isArray(doc.contacts) ? (doc.contacts as Row[]) : []).map((contact) => ({ name: str(contact.name), email: str(contact.email) })),
      addedBy: doc.addedBy ? String(doc.addedBy) : null,
      archived: doc.archived === true,
      archivedAt: date(doc.archivedAt),
      createdAt: date(doc.createdAt),
      updatedAt: date(doc.updatedAt),
    }));
    return { vendors, total };
  },
};
