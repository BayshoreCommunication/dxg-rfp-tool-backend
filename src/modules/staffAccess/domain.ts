import type { GrantedRfpListItem, GrantedVendorResponse } from "../supportAccess/domain";

/* Staff access to customer content (owner decision, 2026-11-17; docs/DECISIONS.md).
   RFPilot staff (an `admins` account holding an admin role) may VIEW everything in every
   organization with no action from that organization: proposals, vendor responses, members,
   teams, templates and the vendor list. Nothing here writes: staff do not edit or delete
   customer content, and do not change an organization's members or teams (owner decision,
   2026-11-24). The one staff write is blocking and reactivating a whole organization (below).

   Every read is recorded on the RFPilot side only: one `platform.organization_content.read`
   event in the STAFF organization's audit trail (`platform.organization_content.denied` for a
   read that ended in "not found"). Nothing is written to the customer
   organization, and the customer's audit log never shows it. */

export class StaffAccessError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "StaffAccessError";
  }
}

// `read`: a read that returned data. `denied`: one that ended in "not found" (an organization,
// record or ticket that isn't there, or a record that belongs to another organization). Both are
// written in the staff organization only; `platform.*` is never shown in a customer audit log.
export const STAFF_CONTENT_AUDIT = {
  read: "platform.organization_content.read",
  denied: "platform.organization_content.denied",
} as const;

export const STAFF_CONTENT_RESOURCES = [
  "proposals", "proposal", "vendor_responses", "ticket_proposals",
  "members", "teams", "templates", "template", "vendors",
] as const;
export type StaffContentResource = (typeof STAFF_CONTENT_RESOURCES)[number];

export type StaffPerson = { id: string; name: string | null; email: string | null };

export type StaffOrganizationRef = { id: string; name: string; createdAt: Date | null };

export type StaffMemberView = {
  userId: string;
  name: string | null;
  email: string | null;
  roles: string[];
  status: string;
  teams: Array<{ id: string; name: string; archived: boolean; isManager: boolean }>;
  joinedAt: Date | null;
  lastSignedInAt: Date | null;
};

export type StaffInvitationView = {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date | null;
  createdAt: Date | null;
};

export type StaffTeamView = {
  id: string;
  name: string;
  archived: boolean;
  archivedAt: Date | null;
  createdAt: Date | null;
  memberCount: number;
  managers: StaffPerson[];
};

export type StaffTemplateSummary = {
  id: string;
  scope: string;
  title: string;
  description: string;
  eventName: string;
  presentationLayout: string | null;
  publishedAt: Date | null;
  archived: boolean;
  archivedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  owner: StaffPerson | null;
};
export type StaffTemplateDetail = StaffTemplateSummary & { content: Record<string, unknown> };

export type StaffVendorView = {
  id: string;
  company: string;
  category: string;
  contacts: Array<{ name: string; email: string }>;
  addedBy: string | null;
  archived: boolean;
  archivedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type StaffPage = { skip: number; limit: number };
export type StaffTemplateFilter = StaffPage & { search: string; scope: "all" | "personal" | "organization"; status: "all" | "active" | "archived" };
export type StaffVendorFilter = StaffPage & { search: string; category: string; status: "all" | "active" | "archived" };

/* Reads of one customer organization. Every method takes the organization the request's PATH
   names (already validated); none reads the caller's tenant context, and each returns a view
   built field by field, never a stored document. */
export interface StaffOrganizationReader {
  organization(organizationId: string): Promise<StaffOrganizationRef | null>;
  /** Every organization, by name: what the standing "granted to me" list is built from. */
  organizations(limit: number): Promise<StaffOrganizationRef[]>;
  members(organizationId: string, page: StaffPage): Promise<{ members: StaffMemberView[]; total: number }>;
  pendingInvitations(organizationId: string, limit: number): Promise<{ invitations: StaffInvitationView[]; total: number }>;
  teams(organizationId: string): Promise<StaffTeamView[]>;
  templates(organizationId: string, filter: StaffTemplateFilter): Promise<{ templates: StaffTemplateSummary[]; total: number }>;
  template(organizationId: string, templateId: string): Promise<StaffTemplateDetail | null>;
  vendors(organizationId: string, filter: StaffVendorFilter): Promise<{ vendors: StaffVendorView[]; total: number }>;
}

export type StaffProposalListItem = GrantedRfpListItem;
export type StaffVendorResponse = GrantedVendorResponse;

/* The staff-side audit actions about a customer organization's members. Every request that
   reaches the member read as staff leaves exactly one event in the STAFF organization's audit
   trail (allowed or denied); nothing is written to the customer organization's. `platform.*` is
   never shown in a customer audit log.

   ONLY `read` IS WRITTEN. Staff changed members from 2026-11-18 until the owner removed that on
   2026-11-24 (docs/DECISIONS.md), and the staff audit trail keeps the rows of that week. The
   other names stay here as the catalog of those historical rows, so a staff audit view can still
   name them; no code writes them, and tests/staff-organization-routes-guard.test.js fails if
   one is used outside this file. */
export const STAFF_MEMBER_AUDIT = {
  read: "platform.organization_member.read",
  // Historical rows only (2026-11-18 to 2026-11-24).
  roleChanged: "platform.organization_member.role_changed",
  deactivated: "platform.organization_member.deactivated",
  reactivated: "platform.organization_member.reactivated",
  proposalsReassigned: "platform.organization_member.proposals_reassigned",
  ownershipTransferred: "platform.organization_member.ownership_transferred",
} as const;

/** A refusal of a staff member, team or block request. `details` are sent with the answer, beside code and message. */
export class StaffMemberError extends StaffAccessError {
  constructor(code: string, message: string, status: number, readonly details?: Record<string, unknown>) {
    super(code, message, status);
    this.name = "StaffMemberError";
  }
}

/** What decides whether staff may read one member or team of an organization, or block it. */
export type StaffManagedOrganization = { id: string; kind: string; staffAccountCount: number };

/* One member of the organization the path names, and that organization's standing. Both
   queries name the organization; a member of another organization is not found. */
export interface StaffMemberDirectory {
  organization(organizationId: string): Promise<StaffManagedOrganization | null>;
  member(organizationId: string, userId: string): Promise<{ member: StaffMemberView; version: number } | null>;
}

/** Why the staff member read, team read and block refuse this organization (`platform`:
    RFPilot's own organization, the caller's or any that `admins` accounts belong to; otherwise
    its kind, such as `legacy_holding`), or null when they don't. One rule for all three. */
export const unmanageableStanding = (organization: StaffManagedOrganization, staffOrganizationId: string): string | null => {
  if (organization.id === staffOrganizationId || organization.staffAccountCount > 0) return "platform";
  if (organization.kind !== "customer") return organization.kind;
  return null;
};

/* The staff-side audit actions about a customer organization's teams. As for members: ONLY
   `read` IS WRITTEN (one event per request that reaches the team read as staff, in the STAFF
   organization). The other names are the catalog of the historical rows staff team management
   wrote between 2026-11-18 and 2026-11-24, when the owner removed it (docs/DECISIONS.md); no
   code writes them. `memberTeamsChanged` was a change of a member, so it is named with the
   member actions. */
export const STAFF_TEAM_AUDIT = {
  read: "platform.organization_team.read",
  // Historical rows only (2026-11-18 to 2026-11-24).
  created: "platform.organization_team.created",
  renamed: "platform.organization_team.renamed",
  archived: "platform.organization_team.archived",
  memberAdded: "platform.organization_team.member_added",
  memberRemoved: "platform.organization_team.member_removed",
  managerChanged: "platform.organization_team.manager_changed",
  memberTeamsChanged: "platform.organization_member.teams_changed",
} as const;

/** One team with its members: the staff teams read's team and the staff members read's member. */
export type StaffTeamDetail = {
  team: StaffTeamView;
  members: Array<{ member: StaffMemberView; version: number; isManager: boolean }>;
};

/* One team of the organization the path names. Every query names the organization; a team of
   another organization is not found. */
export interface StaffTeamDirectory {
  team(organizationId: string, teamId: string): Promise<StaffTeamDetail | null>;
}

/* Staff organization block (owner decision, 2026-11-18; docs/DECISIONS.md). RFPilot staff block a
   whole customer organization and reactivate it: the one staff write on a customer organization.
   As for the member and team reads: the organization comes only from the path, a reason is required, RFPilot's own organization and a legacy
   holding tenant are refused, and every request that reaches the service as staff leaves exactly
   one event in the STAFF organization's audit trail; nothing is written to the customer
   organization's. What "blocked" means is src/modules/organizationBlock/domain.ts, and nowhere else. */
export const STAFF_ORGANIZATION_AUDIT = {
  blocked: "platform.organization.blocked",
  reactivated: "platform.organization.reactivated",
} as const;

/** The staff-side event of a block or a reactivation, without the facts only the store knows. */
export type OrganizationBlockAudit = {
  organizationId: string;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  correlationId: string;
  metadata: Record<string, unknown>;
};

export type OrganizationBlockOutcome =
  | { changed: boolean; blockedAt: Date | null; sessionsEnded: number }
  /** The organization was not there, or was not a customer organization, when the change committed. */
  | "not_found" | "not_manageable";

/* The two writes. Each runs in ONE MongoDB transaction: the marker (set or removed), for a block
   the organization's sessions ended, and the staff-side event, which the store completes with
   `changed`, the dates and the session count it saw inside the transaction. A request that finds
   nothing to change commits its event alone. */
export interface OrganizationBlockStore {
  block(input: { organizationId: string; staffOrganizationId: string; staffAccountId: string; now: Date; audit: OrganizationBlockAudit }): Promise<OrganizationBlockOutcome>;
  /* Reactivating only removes a marker, so it is allowed for ANY organization that carries one,
     manageable or not: an organization blocked while it was a customer organization and later
     made unmanageable (an `admins` account added, its kind changed) must not stay blocked for
     ever. `manageable` is the service's verdict on the full rule; the store applies it only to an
     organization that carries NO marker (answer `not_manageable`, nothing written). */
  reactivate(input: { organizationId: string; staffOrganizationId: string; manageable: boolean; now: Date; audit: OrganizationBlockAudit }): Promise<OrganizationBlockOutcome>;
}
