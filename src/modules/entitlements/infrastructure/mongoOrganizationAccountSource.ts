import mongoose from "mongoose";
import Admin from "../../../../modal/adminModel";
import Invitation from "../../../../modal/invitationModel";
import Organization from "../../../../modal/organizationModel";
import OrganizationDomain from "../../../../modal/organizationDomainModel";
import OrganizationMembership from "../../../../modal/organizationMembershipModel";
import Proposal from "../../../../modal/proposalsModel";
import SsoConnection from "../../../../modal/ssoConnectionModel";
import SupportAccessGrant from "../../../../modal/supportAccessGrantModel";
import SupportTicket from "../../../../modal/supportTicketModel";
import Team from "../../../../modal/teamModel";
import User from "../../../../modal/userModel";
import type {
  OrganizationAccountFacts,
  OrganizationAccountRecord,
  OrganizationAccountSource,
} from "../application/organizationAccountDetail";

/* Organization account detail for RFPilot staff (owner decision, 2026-11-17). Only staff reach
   this (routes/adminOrganizationPlansRoute.ts), and every query names the one organization the
   request is about; nothing reads the caller's tenant context. Customer data is only counted:
   no query here selects a proposal, ticket, invitation or member row to return, the vendor
   list and templates are not read at all, and the Owner is the one person whose name and email are read. Each query uses an
   index that leads with organizationId, apart from the Owner's account, read by its _id. */

const FIELDS = "name slug status kind plan proposalsCreated createdAt country requireTwoFactor requireSso allowManagerInvites autoApproveDomain";
const DOMAIN_LIMIT = 50;
const GRANT_LIMIT = 50;

const oid = (value: string) => new mongoose.Types.ObjectId(value);
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const date = (value: unknown): Date | null => (value instanceof Date ? value : null);
const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

type Row = Record<string, unknown>;

const splitByArchived = (rows: Array<{ _id: unknown; count: number }>) => ({
  active: rows.filter((row) => row._id !== true).reduce((sum, row) => sum + row.count, 0),
  archived: rows.filter((row) => row._id === true).reduce((sum, row) => sum + row.count, 0),
});

const ownerOf = async (id: mongoose.Types.ObjectId): Promise<OrganizationAccountFacts["owner"]> => {
  const membership = await OrganizationMembership.findOne({ organizationId: id, status: "active", roles: "owner" }).select("userId").lean<Row>();
  if (!membership?.userId) return null;
  const user = await User.findOne({ _id: membership.userId }).select("name email").lean<Row>();
  return user ? { name: String(user.name ?? ""), email: String(user.email ?? "") } : null;
};

export const mongoOrganizationAccountSource: OrganizationAccountSource = {
  async find(organizationId) {
    const doc = await Organization.findOne({ _id: oid(organizationId) }).select(FIELDS).lean<Row>();
    if (!doc) return null;
    const record: OrganizationAccountRecord = {
      id: String(doc._id),
      name: String(doc.name ?? ""),
      slug: String(doc.slug ?? ""),
      status: String(doc.status ?? "active"),
      kind: String(doc.kind ?? "customer"),
      plan: text(doc.plan),
      proposalsCreated: typeof doc.proposalsCreated === "number" ? doc.proposalsCreated : null,
      createdAt: date(doc.createdAt),
      country: text(doc.country),
      requireTwoFactor: doc.requireTwoFactor === true,
      requireSso: doc.requireSso === true,
      allowManagerInvites: doc.allowManagerInvites === true,
      autoApproveDomain: doc.autoApproveDomain === true,
    };
    return record;
  },

  async facts(organizationId, now) {
    const id = oid(organizationId);
    const [owner, memberGroups, pendingInvitations, teams, proposals, openSupportTickets, domains, sso, staffAccounts, grants] =
      await Promise.all([
        ownerOf(id),
        OrganizationMembership.aggregate<{ _id: { status: string; roles: string[] }; count: number; lastSignedInAt: Date | null }>([
          { $match: { organizationId: id, status: { $in: ["active", "suspended"] } } },
          { $group: { _id: { status: "$status", roles: "$roles" }, count: { $sum: 1 }, lastSignedInAt: { $max: "$lastSignedInAt" } } },
        ]),
        Invitation.countDocuments({ organizationId: id, status: "pending", expiresAt: { $gt: now } }),
        Team.aggregate<{ _id: unknown; count: number }>([
          { $match: { organizationId: id } },
          { $group: { _id: "$archived", count: { $sum: 1 } } },
        ]),
        Proposal.aggregate<{ total: number; archived: number; lastUpdatedAt: Date | null }>([
          { $match: { organizationId: id } },
          { $group: { _id: null, total: { $sum: 1 }, archived: { $sum: { $cond: [{ $eq: ["$isArchived", true] }, 1, 0] } }, lastUpdatedAt: { $max: "$updatedAt" } } },
        ]),
        SupportTicket.countDocuments({ organizationId: id, status: { $in: ["open", "waiting_on_customer"] } }),
        OrganizationDomain.find({ organizationId: id }).select("domain status").sort({ domain: 1 }).limit(DOMAIN_LIMIT).lean<Row[]>(),
        SsoConnection.findOne({ organizationId: id }).select("status").lean<Row>(),
        Admin.countDocuments({ organizationId: id }),
        SupportAccessGrant.find({ organizationId: id, revokedAt: null, expiresAt: { $gt: now } })
          .select("proposalId expiresAt").sort({ expiresAt: -1 }).limit(GRANT_LIMIT).lean<Row[]>(),
      ]);

    return {
      owner,
      memberGroups: memberGroups.map((group) => ({
        status: String(group._id?.status ?? ""),
        roles: Array.isArray(group._id?.roles) ? group._id.roles.map(String) : [],
        count: number(group.count),
        lastSignedInAt: date(group.lastSignedInAt),
      })),
      pendingInvitations,
      teams: splitByArchived(teams),
      proposals: { total: number(proposals[0]?.total), archived: number(proposals[0]?.archived), lastUpdatedAt: date(proposals[0]?.lastUpdatedAt) },
      openSupportTickets,
      domains: domains.map((row) => ({ domain: String(row.domain ?? ""), status: String(row.status ?? "") })),
      ssoStatus: sso ? String(sso.status ?? "draft") : null,
      staffAccounts,
      activeGrants: grants.map((row) => ({ proposalId: row.proposalId ? String(row.proposalId) : null, expiresAt: row.expiresAt as Date })),
    };
  },
};
