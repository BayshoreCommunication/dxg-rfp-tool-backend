import { isPlanStaff, type PlanStaff } from "../../entitlements/application/manageOrganizationPlans";
import {
  STAFF_ORGANIZATION_AUDIT,
  StaffAccessError,
  StaffMemberError,
  unmanageableStanding,
  type OrganizationBlockAudit,
  type OrganizationBlockOutcome,
  type OrganizationBlockStore,
  type StaffMemberDirectory,
} from "../domain";
import { asTyped, parseReason, refused } from "./manageOrganizationMembers";
import type { StaffContentAudit } from "./readOrganizationContent";

/* Staff organization block (owner decision, 2026-11-18; docs/DECISIONS.md). RFPilot staff block a
   whole customer organization and reactivate it.

   What a block DOES is not here: it is the marker on the organization document
   (organizationBlock/domain.ts) and the enforcement points that ask about it. This service only
   sets and removes the marker, with the guard, the reason and the staff-side record of the
   sibling staff services (manageOrganizationMembers.ts, manageOrganizationTeams.ts).

   Tenant scope: the organization is the one in the path and nothing else. RFPilot's own
   organization (the caller's, or any organization holding `admins` accounts) and any
   organization that is not of kind `customer` (a legacy holding tenant) can never be blocked:
   409 ORGANIZATION_NOT_MANAGEABLE, by the rule the member and team routes share.

   Idempotent: blocking a blocked organization, or reactivating one that is not blocked, answers
   success with `changed: false`, and is still recorded.

   Audit: after the staff check every request leaves exactly ONE event, in the STAFF organization,
   under `platform.organization.blocked` or `platform.organization.reactivated`: `allowed` for a
   change or a request that found nothing to change, `denied` for a refusal. The allowed event is
   inserted by the store IN THE SAME MongoDB transaction as the marker (and, for a block, as the
   ending of the organization's sessions), so an organization is never blocked or reactivated
   without its record. Nothing is written to the customer organization's audit trail, and the
   block is never named there by a later request either (see the enforcement points). */

const ID = /^[a-f0-9]{24}$/;

type Dependencies = {
  directory: Pick<StaffMemberDirectory, "organization">;
  store: OrganizationBlockStore;
  /** Refusals only. An allowed request's event goes through the store, inside its transaction. */
  audit: StaffContentAudit;
  now?: () => Date;
};

type Attempt = { staff: PlanStaff; action: string; organizationId: string; staffReason: string | null };

export const createStaffOrganizationBlock = (dependencies: Dependencies) => {
  const { directory, store, audit } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  const assertStaff = (staff: PlanStaff) => {
    if (!isPlanStaff(staff)) throw new StaffAccessError("STAFF_ACCESS_FORBIDDEN", "Only RFPilot staff can do that.", 403);
    if (!staff.adminId || !staff.organizationId) throw new StaffAccessError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  };

  // Every event of this service. Its organization is always the staff member's own; the customer
  // organization appears only as the target and in the metadata.
  const eventOf = (current: Attempt, metadata: Record<string, unknown>): OrganizationBlockAudit => ({
    organizationId: current.staff.organizationId,
    actorUserId: current.staff.adminId,
    action: current.action,
    targetType: "organization",
    targetId: current.organizationId,
    correlationId: current.staff.correlationId,
    metadata: {
      agentAccountType: "admin",
      organizationId: current.organizationId,
      ...(current.staffReason ? { staffReason: current.staffReason } : {}),
      ...metadata,
    },
  });

  // A refusal: nothing was changed, so the answer is returned whether or not this can be written.
  const recordDenied = async (current: Attempt, error: StaffMemberError) => {
    try {
      const { targetId, ...event } = eventOf(current, error.status === 400 ? {} : { ...error.details });
      await audit.append({ ...event, ...(ID.test(targetId) ? { targetId } : {}), decision: "denied", reason: error.code.toLowerCase() });
    } catch (failure) {
      console.error("Staff organization block error: a refused request could not be recorded:", failure instanceof Error ? failure.message : failure);
    }
  };

  const notManageable = (standing: string) =>
    standing === "platform"
      ? refused(409, "ORGANIZATION_NOT_MANAGEABLE", "RFPilot's own organization can't be blocked.", { standing })
      : refused(409, "ORGANIZATION_NOT_MANAGEABLE", "This organization is awaiting placement. It can't be blocked or reactivated.", { standing });

  const attempt = async (
    staff: PlanStaff,
    action: string,
    organizationId: unknown,
    input: { reason?: unknown },
    write: (current: Attempt, organization: string) => Promise<OrganizationBlockOutcome>,
  ) => {
    assertStaff(staff);
    const current: Attempt = { staff, action, organizationId: asTyped(organizationId), staffReason: null };
    try {
      // The id first (nothing is looked up for a malformed one), then the reason every write carries.
      if (!ID.test(current.organizationId)) throw refused(400, "INVALID_ORGANIZATION_ID", "That is not an organization id.");
      current.staffReason = parseReason(input?.reason);
      const organization = await directory.organization(current.organizationId);
      if (!organization) throw refused(404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
      // One rule for the member, team and block routes (domain.ts).
      const standing = unmanageableStanding(organization, staff.organizationId);
      if (standing) throw notManageable(standing);
      const outcome = await write(current, organization.id);
      // The store re-checks inside its transaction: the organization may have gone, or stopped
      // being a customer organization, between the read above and the commit.
      if (outcome === "not_found") throw refused(404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
      if (outcome === "not_manageable") throw notManageable("changed");
      return {
        organizationId: organization.id,
        changed: outcome.changed,
        blocked: outcome.blockedAt !== null,
        blockedAt: outcome.blockedAt,
        ...(action === STAFF_ORGANIZATION_AUDIT.blocked ? { sessionsEnded: outcome.sessionsEnded } : {}),
      };
    } catch (error) {
      if (error instanceof StaffMemberError) await recordDenied(current, error);
      throw error;
    }
  };

  return {
    /** Body: { reason }. Sets the marker and ends every session of the organization, at once. */
    block: (staff: PlanStaff, organizationId: unknown, input: { reason?: unknown }) =>
      attempt(staff, STAFF_ORGANIZATION_AUDIT.blocked, organizationId, input, (current, organization) =>
        store.block({
          organizationId: organization,
          staffOrganizationId: staff.organizationId,
          staffAccountId: staff.adminId,
          now: now(),
          audit: eventOf(current, {}),
        })),

    /** Body: { reason }. Removes the marker. Sessions the block ended stay ended; members sign in again. */
    reactivate: (staff: PlanStaff, organizationId: unknown, input: { reason?: unknown }) =>
      attempt(staff, STAFF_ORGANIZATION_AUDIT.reactivated, organizationId, input, (current, organization) =>
        store.reactivate({ organizationId: organization, staffOrganizationId: staff.organizationId, now: now(), audit: eventOf(current, {}) })),
  };
};

export type StaffOrganizationBlock = ReturnType<typeof createStaffOrganizationBlock>;
