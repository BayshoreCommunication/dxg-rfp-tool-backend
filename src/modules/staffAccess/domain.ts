import type { GrantedRfpListItem, GrantedVendorResponse } from "../supportAccess/domain";

/* Staff access to customer content (owner decision, 2026-11-17; docs/DECISIONS.md).
   RFPilot staff (an `admins` account holding an admin role) may VIEW everything in every
   organization with no action from that organization: proposals, vendor responses, members,
   teams, templates and the vendor list. Nothing here writes: staff do not edit or delete
   customer content, and account management is a later ticket.

   Every read is recorded on the RFPilot side only: one `platform.organization_content.read`
   event in the STAFF organization's audit trail. Nothing is written to the customer
   organization, and the customer's audit log never shows it. */

export class StaffAccessError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "StaffAccessError";
  }
}

export const STAFF_CONTENT_AUDIT = { read: "platform.organization_content.read" } as const;

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
