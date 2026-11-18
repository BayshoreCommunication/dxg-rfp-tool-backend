import type { PlanStaff } from "../../entitlements/application/manageOrganizationPlans";
import type { StaffOrganizationContent } from "../../staffAccess/application/readOrganizationContent";
import { StaffAccessError } from "../../staffAccess/domain";
import { SupportAccessError, type SupportAgent } from "../domain";

/* The RFPilot staff side of the older support-access routes (ORG-404), which the deployed admin
   app still calls. Owner decision, 2026-11-17 (docs/DECISIONS.md): staff read every
   organization's content with no grant. So these routes no longer look at grants at all. They
   delegate to the staff content service (src/modules/staffAccess), which applies the
   staff-account guard and writes each read to the STAFF organization's audit trail. Nothing is
   written to the customer organization: `support_access.used` and `support_access.denied` are
   no longer written by anything.

   The answers keep their shape. Where they used to carry the grant the read was made under
   (`grant` / `grants`, which the admin app's banner and its 30-second "is this grant still
   active" check need), they now carry one STANDING entry for the organization: organization-wide,
   with the organization's own id as its id, and an end that is always STANDING_WINDOW_DAYS
   away. Nothing expires; the end date is there only because the deployed admin app hides the
   screen without one. The admin app is rebuilt against the new routes in a later PR. */

export const STANDING_WINDOW_DAYS = 30;
const STANDING_WINDOW_MS = STANDING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

type Dependencies = {
  content: StaffOrganizationContent;
  clock?: () => Date;
};

const staffOf = (agent: SupportAgent): PlanStaff => ({
  adminId: agent.adminId,
  organizationId: agent.organizationId,
  role: agent.role,
  accountType: agent.accountType,
  correlationId: agent.correlationId,
});

// These routes keep their own refusal code for a caller who is not RFPilot staff.
const translate = (error: unknown): never => {
  if (error instanceof StaffAccessError) {
    throw new SupportAccessError(error.code === "STAFF_ACCESS_FORBIDDEN" ? "SUPPORT_ACCESS_FORBIDDEN" : error.code, error.message, error.status);
  }
  throw error;
};

export const standingAccess = (organizationId: string, now: Date) => ({
  id: organizationId,
  scope: "organization" as const,
  proposalId: null,
  expiresAt: new Date(now.getTime() + STANDING_WINDOW_MS),
  secondsRemaining: STANDING_WINDOW_MS / 1000,
});

export const createSupportAccess = (dependencies: Dependencies) => {
  const { content } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  return {
    /* "Granted to me". It used to list the active grants; it now lists every organization, each
       as one standing organization-wide entry, because staff reach every organization and the
       deployed admin app both navigates from this list and closes an organization's screen when
       the organization is missing from it. Organization names only, so nothing is recorded. */
    async listGranted(agent: SupportAgent) {
      const now = clock();
      const organizations = await content.organizations(staffOf(agent)).catch(translate);
      return {
        grants: organizations.map((organization) => ({
          ...standingAccess(organization.id, now),
          organization: { id: organization.id, name: organization.name || null },
          rfp: null,
          reason: null,
          createdAt: organization.createdAt,
        })),
      };
    },

    async listRfps(agent: SupportAgent, organizationId: string, query: { page?: unknown; search?: unknown }) {
      const result = await content.proposals(staffOf(agent), organizationId, query).catch(translate);
      return { organizationId: result.organizationId, grants: [standingAccess(result.organizationId, clock())], rfps: result.rfps, pagination: result.pagination };
    },

    async getRfp(agent: SupportAgent, organizationId: string, proposalId: string) {
      const result = await content.proposal(staffOf(agent), organizationId, proposalId).catch(translate);
      return { organizationId: result.organizationId, grant: standingAccess(result.organizationId, clock()), rfp: result.rfp, owner: result.owner };
    },

    async listVendorResponses(agent: SupportAgent, organizationId: string, proposalId: string) {
      const result = await content.vendorResponses(staffOf(agent), organizationId, proposalId).catch(translate);
      return { organizationId: result.organizationId, grant: standingAccess(result.organizationId, clock()), proposalId: result.proposalId, vendorResponses: result.vendorResponses };
    },

    // The proposals behind a helpdesk ticket: the requester's, in the ticket's organization.
    async listTicketRfps(agent: SupportAgent, ticketId: string, query: { page?: unknown; search?: unknown }) {
      const result = await content.ticketProposals(staffOf(agent), ticketId, query).catch(translate);
      return { organizationId: result.organizationId, grants: [standingAccess(result.organizationId, clock())], rfps: result.rfps, pagination: result.pagination };
    },
  };
};

export type SupportAccess = ReturnType<typeof createSupportAccess>;
