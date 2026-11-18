import type { GrantedRfpListItem, GrantedVendorResponse } from "../supportAccess/domain";

/* Staff access to customer content (owner decision, 2026-11-17; docs/DECISIONS.md).
   RFPilot staff (an `admins` account holding an admin role) may VIEW everything in every
   organization with no action from that organization: proposals, vendor responses, members,
   teams, templates and the vendor list. Nothing here writes: staff do not edit or delete
   customer content, and account management is a later ticket.

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

/* Staff member management (owner decision, 2026-11-18; docs/DECISIONS.md). RFPilot staff change
   a member's role, deactivate and reactivate a member, reassign a member's proposals and
   transfer ownership, in any customer organization, under the same rules its own Owner and
   Admins work under. Every request that reaches the service as staff leaves exactly one event in
   the STAFF organization's audit trail (allowed or denied, under the same action name); nothing
   is written to the customer organization's. `platform.*` is never shown in a customer audit log. */
export const STAFF_MEMBER_AUDIT = {
  read: "platform.organization_member.read",
  roleChanged: "platform.organization_member.role_changed",
  deactivated: "platform.organization_member.deactivated",
  reactivated: "platform.organization_member.reactivated",
  proposalsReassigned: "platform.organization_member.proposals_reassigned",
  ownershipTransferred: "platform.organization_member.ownership_transferred",
} as const;

/** A refusal of a staff member request. `details` are sent with the answer, beside code and message. */
export class StaffMemberError extends StaffAccessError {
  constructor(code: string, message: string, status: number, readonly details?: Record<string, unknown>) {
    super(code, message, status);
    this.name = "StaffMemberError";
  }
}

/** What decides whether staff may manage an organization's members. */
export type StaffManagedOrganization = { id: string; kind: string; staffAccountCount: number };

/* One member of the organization the path names, and that organization's standing. Both
   queries name the organization; a member of another organization is not found. */
export interface StaffMemberDirectory {
  organization(organizationId: string): Promise<StaffManagedOrganization | null>;
  member(organizationId: string, userId: string): Promise<{ member: StaffMemberView; version: number } | null>;
}
