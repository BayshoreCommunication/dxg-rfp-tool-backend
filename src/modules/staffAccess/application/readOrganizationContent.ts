import { isPlanStaff, type PlanStaff } from "../../entitlements/application/manageOrganizationPlans";
import type { GrantedRfpReader, SupportAccessDirectory, SupportTicketLookup } from "../../supportAccess/domain";
import {
  STAFF_CONTENT_AUDIT,
  StaffAccessError,
  type StaffContentResource,
  type StaffOrganizationReader,
  type StaffOrganizationRef,
} from "../domain";

/* The VIEW half of staff access (owner decision, 2026-11-17). One service behind both the new
   routes (`/api/v1/admin/organizations/:organizationId/...`) and the older support-access
   routes the deployed admin app still calls. No grant is consulted anywhere in this file.

   Order of every read: staff-account check, ids validated (400), the organization looked up
   (404), the data read for THAT organization, then one audit event written in the STAFF
   organization and awaited. If the event can't be written the read fails and nothing is
   returned. Nothing is ever written to the customer organization. */

export type StaffContentAudit = {
  append(input: {
    organizationId: string;
    actorUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    decision: "allowed";
    reason: string;
    correlationId: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
};

type Dependencies = {
  organizations: StaffOrganizationReader;
  /** The proposal reads support access already had (list, detail, vendor responses). */
  proposals: GrantedRfpReader;
  directory: Pick<SupportAccessDirectory, "findRfp">;
  tickets: SupportTicketLookup;
  audit: StaffContentAudit;
  isValidId(value: string): boolean;
};

export const STAFF_PER_PAGE = 20;
export const STAFF_MEMBERS_PER_PAGE = 50;
export const STAFF_INVITATION_LIMIT = 200;
export const STAFF_ORGANIZATION_LIMIT = 2000;

const pageOf = (value: unknown) => {
  const parsed = Number.parseInt(String(value ?? "1"), 10);
  return Number.isNaN(parsed) || parsed < 1 ? 1 : Math.min(parsed, 10_000);
};
const searchOf = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, 200) : "");
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T, name: string): T => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new StaffAccessError("INVALID_FILTER", `"${name}" must be one of: ${allowed.join(", ")}.`, 400);
  }
  return value as T;
};
const pagination = (page: number, perPage: number, total: number) => ({ page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) });

const proposalNotFound = () => new StaffAccessError("PROPOSAL_NOT_FOUND", "Proposal not found.", 404);

export const createStaffOrganizationContent = (dependencies: Dependencies) => {
  const { organizations, proposals, directory, tickets, audit } = dependencies;

  const assertStaff = (staff: PlanStaff) => {
    if (!isPlanStaff(staff)) throw new StaffAccessError("STAFF_ACCESS_FORBIDDEN", "Only RFPilot staff can do that.", 403);
    if (!staff.adminId || !staff.organizationId) throw new StaffAccessError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  };

  const organizationOf = async (organizationId: string): Promise<StaffOrganizationRef> => {
    if (!dependencies.isValidId(organizationId)) throw new StaffAccessError("INVALID_ORGANIZATION_ID", "That is not an organization id.", 400);
    const organization = await organizations.organization(organizationId);
    if (!organization) throw new StaffAccessError("ORGANIZATION_NOT_FOUND", "Organization not found.", 404);
    return organization;
  };

  const recordId = (value: string, code: string, what: string) => {
    if (!dependencies.isValidId(value)) throw new StaffAccessError(code, `That is not ${what} id.`, 400);
    return value;
  };

  // One event per read, in the staff organization. Awaited by every caller before it returns.
  const recordRead = (staff: PlanStaff, organizationId: string, resource: StaffContentResource, extra: Record<string, unknown> = {}) =>
    audit.append({
      organizationId: staff.organizationId,
      actorUserId: staff.adminId,
      action: STAFF_CONTENT_AUDIT.read,
      targetType: "organization",
      targetId: organizationId,
      decision: "allowed",
      reason: resource,
      correlationId: staff.correlationId,
      metadata: { agentAccountType: "admin", resource, ...extra },
    });

  const listProposals = async (
    staff: PlanStaff,
    organizationId: string,
    query: { page?: unknown; search?: unknown },
    options: { resource: "proposals" | "ticket_proposals"; ownerUserId?: string; extra?: Record<string, unknown> },
  ) => {
    const page = pageOf(query.page);
    const result = await proposals.list(organizationId, {
      ...(options.ownerUserId ? { ownerUserId: options.ownerUserId } : {}),
      search: searchOf(query.search),
      skip: (page - 1) * STAFF_PER_PAGE,
      limit: STAFF_PER_PAGE,
    });
    await recordRead(staff, organizationId, options.resource, options.extra);
    return { organizationId, rfps: result.rfps, pagination: pagination(page, STAFF_PER_PAGE, result.total) };
  };

  return {
    /** Every organization, for the older "granted to me" list. Names only, so nothing is recorded. */
    async organizations(staff: PlanStaff) {
      assertStaff(staff);
      return organizations.organizations(STAFF_ORGANIZATION_LIMIT);
    },

    async proposals(staff: PlanStaff, organizationId: string, query: { page?: unknown; search?: unknown } = {}) {
      assertStaff(staff);
      const organization = await organizationOf(organizationId);
      return listProposals(staff, organization.id, query, { resource: "proposals" });
    },

    async proposal(staff: PlanStaff, organizationId: string, proposalId: string) {
      assertStaff(staff);
      const organization = await organizationOf(organizationId);
      recordId(proposalId, "INVALID_PROPOSAL_ID", "a proposal");
      // The reader names the organization: a proposal that belongs to another one is not found.
      const detail = await proposals.find(organization.id, proposalId);
      if (!detail) throw proposalNotFound();
      await recordRead(staff, organization.id, "proposal", { recordId: proposalId });
      return { organizationId: organization.id, rfp: detail.rfp, owner: detail.owner };
    },

    async vendorResponses(staff: PlanStaff, organizationId: string, proposalId: string) {
      assertStaff(staff);
      const organization = await organizationOf(organizationId);
      recordId(proposalId, "INVALID_PROPOSAL_ID", "a proposal");
      if (!(await directory.findRfp(organization.id, proposalId))) throw proposalNotFound();
      const responses = await proposals.vendorResponses(organization.id, proposalId);
      await recordRead(staff, organization.id, "vendor_responses", { recordId: proposalId });
      return { organizationId: organization.id, proposalId, vendorResponses: responses };
    },

    // The proposals behind a helpdesk ticket: the requester's, in the ticket's own organization
    // (never the staff member's).
    async ticketProposals(staff: PlanStaff, ticketId: string, query: { page?: unknown; search?: unknown } = {}) {
      assertStaff(staff);
      const ticket = dependencies.isValidId(ticketId) ? await tickets.find(ticketId) : null;
      if (!ticket) throw new StaffAccessError("SUPPORT_TICKET_NOT_FOUND", "The support ticket was not found.", 404);
      return listProposals(staff, ticket.organizationId, query, {
        resource: "ticket_proposals",
        ownerUserId: ticket.requesterUserId,
        extra: { ticketId: ticket.id },
      });
    },

    async members(staff: PlanStaff, organizationId: string, query: { page?: unknown } = {}) {
      assertStaff(staff);
      const organization = await organizationOf(organizationId);
      const page = pageOf(query.page);
      const [members, invitations] = await Promise.all([
        organizations.members(organization.id, { skip: (page - 1) * STAFF_MEMBERS_PER_PAGE, limit: STAFF_MEMBERS_PER_PAGE }),
        organizations.pendingInvitations(organization.id, STAFF_INVITATION_LIMIT),
      ]);
      await recordRead(staff, organization.id, "members");
      return {
        organizationId: organization.id,
        members: members.members.map((member) => ({
          userId: member.userId,
          name: member.name,
          email: member.email,
          roles: [...member.roles],
          status: member.status,
          teams: member.teams.map((team) => ({ id: team.id, name: team.name, archived: team.archived, isManager: team.isManager })),
          joinedAt: member.joinedAt,
          lastSignedInAt: member.lastSignedInAt,
        })),
        pagination: pagination(page, STAFF_MEMBERS_PER_PAGE, members.total),
        pendingInvitations: invitations.invitations.map((invitation) => ({
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
          createdAt: invitation.createdAt,
        })),
        pendingInvitationsTotal: invitations.total,
      };
    },

    async teams(staff: PlanStaff, organizationId: string) {
      assertStaff(staff);
      const organization = await organizationOf(organizationId);
      const teams = await organizations.teams(organization.id);
      await recordRead(staff, organization.id, "teams");
      return {
        organizationId: organization.id,
        teams: teams.map((team) => ({
          id: team.id,
          name: team.name,
          archived: team.archived,
          archivedAt: team.archivedAt,
          createdAt: team.createdAt,
          memberCount: team.memberCount,
          managers: team.managers.map((manager) => ({ id: manager.id, name: manager.name, email: manager.email })),
        })),
      };
    },

    async templates(staff: PlanStaff, organizationId: string, query: { page?: unknown; search?: unknown; scope?: unknown; status?: unknown } = {}) {
      assertStaff(staff);
      const organization = await organizationOf(organizationId);
      const page = pageOf(query.page);
      const result = await organizations.templates(organization.id, {
        search: searchOf(query.search),
        scope: oneOf(query.scope, ["all", "personal", "organization"] as const, "all", "scope"),
        status: oneOf(query.status, ["all", "active", "archived"] as const, "all", "status"),
        skip: (page - 1) * STAFF_PER_PAGE,
        limit: STAFF_PER_PAGE,
      });
      await recordRead(staff, organization.id, "templates");
      return {
        organizationId: organization.id,
        templates: result.templates.map(summaryOf),
        pagination: pagination(page, STAFF_PER_PAGE, result.total),
      };
    },

    async template(staff: PlanStaff, organizationId: string, templateId: string) {
      assertStaff(staff);
      const organization = await organizationOf(organizationId);
      recordId(templateId, "INVALID_TEMPLATE_ID", "a template");
      const template = await organizations.template(organization.id, templateId);
      if (!template) throw new StaffAccessError("TEMPLATE_NOT_FOUND", "Template not found.", 404);
      await recordRead(staff, organization.id, "template", { recordId: templateId });
      return { organizationId: organization.id, template: { ...summaryOf(template), content: template.content } };
    },

    async vendors(staff: PlanStaff, organizationId: string, query: { page?: unknown; search?: unknown; category?: unknown; status?: unknown } = {}) {
      assertStaff(staff);
      const organization = await organizationOf(organizationId);
      const page = pageOf(query.page);
      const result = await organizations.vendors(organization.id, {
        search: searchOf(query.search),
        category: searchOf(query.category).slice(0, 80),
        status: oneOf(query.status, ["all", "active", "archived"] as const, "all", "status"),
        skip: (page - 1) * STAFF_PER_PAGE,
        limit: STAFF_PER_PAGE,
      });
      await recordRead(staff, organization.id, "vendors");
      return {
        organizationId: organization.id,
        vendors: result.vendors.map((vendor) => ({
          id: vendor.id,
          company: vendor.company,
          category: vendor.category,
          contacts: vendor.contacts.map((contact) => ({ name: contact.name, email: contact.email })),
          addedBy: vendor.addedBy,
          archived: vendor.archived,
          archivedAt: vendor.archivedAt,
          createdAt: vendor.createdAt,
          updatedAt: vendor.updatedAt,
        })),
        pagination: pagination(page, STAFF_PER_PAGE, result.total),
      };
    },
  };
};

// Field by field, so nothing else a reader hands back reaches the response.
const summaryOf = (template: {
  id: string; scope: string; title: string; description: string; eventName: string; presentationLayout: string | null;
  publishedAt: Date | null; archived: boolean; archivedAt: Date | null; createdAt: Date | null; updatedAt: Date | null;
  owner: { id: string; name: string | null; email: string | null } | null;
}) => ({
  id: template.id,
  scope: template.scope,
  title: template.title,
  description: template.description,
  eventName: template.eventName,
  presentationLayout: template.presentationLayout,
  publishedAt: template.publishedAt,
  archived: template.archived,
  archivedAt: template.archivedAt,
  createdAt: template.createdAt,
  updatedAt: template.updatedAt,
  owner: template.owner ? { id: template.owner.id, name: template.owner.name, email: template.owner.email } : null,
});

export type StaffOrganizationContent = ReturnType<typeof createStaffOrganizationContent>;
