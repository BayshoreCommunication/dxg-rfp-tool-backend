import { isPlanStaff, type PlanStaff } from "../../entitlements/application/manageOrganizationPlans";
import { STAFF_MEMBER_AUDIT, StaffAccessError, StaffMemberError, unmanageableStanding, type StaffMemberDirectory } from "../domain";
import { staffMemberView, type StaffContentAudit } from "./readOrganizationContent";

/* The staff read of ONE member of a customer organization, and the request helpers the staff
   routes share (the staff team read and the organization block use them).

   Staff do not change a customer organization's members (owner decision, 2026-11-24;
   docs/DECISIONS.md). The role change, deactivation, reactivation, proposal reassignment and
   ownership transfer that were here from 2026-11-18 are removed: this service reads and nothing
   else, and it is given no store that can write.

   Tenant scope: the organization is the one in the path and nothing else. The read names it
   together with the member's user id, so a member that belongs to another organization is "not
   found". RFPilot's own organization and a legacy holding tenant are refused
   (409 ORGANIZATION_NOT_MANAGEABLE).

   Audit: after the staff check, every request leaves exactly ONE event, in the STAFF organization
   (`organizationId: staff.organizationId`), under `platform.organization_member.read`:
   `allowed` for a read that returned the member, `denied` for a refusal. Nothing is written to
   the customer organization's audit trail. */

const ID = /^[a-f0-9]{24}$/;
export const STAFF_REASON_MIN = 10;
export const STAFF_REASON_MAX = 500;

type Dependencies = {
  directory: StaffMemberDirectory;
  audit: StaffContentAudit;
};

type Attempt = {
  staff: PlanStaff;
  action: string;
  /** As the caller typed them: validated before they are used in a query. */
  organizationId: string;
  memberUserId: string;
};

// What a caller typed in a path or body, cut to an id's length before it is stored.
export const asTyped = (value: unknown) => (typeof value === "string" ? value.slice(0, 64) : "");

export const refused = (status: number, code: string, message: string, details?: Record<string, unknown>) => new StaffMemberError(code, message, status, details);
export const memberNotFound = () => refused(404, "MEMBER_NOT_FOUND", "Member not found.");

// The reason a staff write carries (today: blocking and reactivating an organization).
export const parseReason = (value: unknown): string => {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length < STAFF_REASON_MIN || reason.length > STAFF_REASON_MAX) {
    const message = `Give a reason of ${STAFF_REASON_MIN} to ${STAFF_REASON_MAX} characters.`;
    throw refused(400, "INVALID_REASON", message, { fields: { reason: message } });
  }
  return reason;
};

export const createStaffMemberManagement = (dependencies: Dependencies) => {
  const { directory, audit } = dependencies;

  const assertStaff = (staff: PlanStaff) => {
    if (!isPlanStaff(staff)) throw new StaffAccessError("STAFF_ACCESS_FORBIDDEN", "Only RFPilot staff can do that.", 403);
    if (!staff.adminId || !staff.organizationId) throw new StaffAccessError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  };

  // Every event of this service. Its organization is always the staff member's own; the
  // customer organization and the member appear only as the target and in the metadata.
  const eventOf = (attempt: Attempt, reason: string, metadata: Record<string, unknown>) => ({
    organizationId: attempt.staff.organizationId,
    actorUserId: attempt.staff.adminId,
    action: attempt.action,
    targetType: "organization_membership",
    targetId: attempt.memberUserId,
    reason,
    correlationId: attempt.staff.correlationId,
    metadata: {
      agentAccountType: "admin",
      organizationId: attempt.organizationId,
      memberUserId: attempt.memberUserId,
      ...metadata,
    },
  });

  // A read that returned the member. Awaited before anything is returned: if it can't be written
  // the request fails.
  const recordAllowed = (attempt: Attempt, reason: string, metadata: Record<string, unknown>) =>
    audit.append({ ...eventOf(attempt, reason, metadata), decision: "allowed" });

  // A refusal: nothing was read, so the answer is returned whether or not this can be written.
  const recordDenied = async (attempt: Attempt, error: StaffMemberError) => {
    try {
      const { targetId, ...event } = eventOf(attempt, error.code.toLowerCase(), error.status === 400 ? {} : { ...error.details });
      await audit.append({ ...event, ...(ID.test(targetId) ? { targetId } : {}), decision: "denied" });
    } catch (failure) {
      console.error("Staff member management error: a refused request could not be recorded:", failure instanceof Error ? failure.message : failure);
    }
  };

  const attempt = async <T>(
    staff: PlanStaff,
    action: string,
    where: { organizationId: unknown; memberUserId: unknown },
    work: (attempt: Attempt) => Promise<T>,
  ): Promise<T> => {
    assertStaff(staff);
    const current: Attempt = { staff, action, organizationId: asTyped(where.organizationId), memberUserId: asTyped(where.memberUserId) };
    try {
      return await work(current);
    } catch (error) {
      if (error instanceof StaffMemberError) await recordDenied(current, error);
      throw error;
    }
  };

  // Ids first: nothing is looked up for a malformed one.
  const validate = (current: Attempt) => {
    if (!ID.test(current.organizationId)) throw refused(400, "INVALID_ORGANIZATION_ID", "That is not an organization id.");
    if (!ID.test(current.memberUserId)) throw refused(400, "INVALID_MEMBER_ID", "That is not a member id.");
  };

  // The organization in the path: it must exist, be a customer organization, and not be RFPilot's.
  const organizationOf = async (current: Attempt): Promise<string> => {
    const organization = await directory.organization(current.organizationId);
    if (!organization) throw refused(404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
    // One rule for the member read, the team read and the organization block (domain.ts).
    const standing = unmanageableStanding(organization, current.staff.organizationId);
    if (standing === "platform") {
      throw refused(409, "ORGANIZATION_NOT_MANAGEABLE", "Members of RFPilot's own organization can't be managed here.", { standing });
    }
    if (standing) {
      throw refused(409, "ORGANIZATION_NOT_MANAGEABLE", "This organization is awaiting placement. Its members can't be managed yet.", { standing });
    }
    return organization.id;
  };

  return {
    /** One member, with the membership's version (which the members list does not carry). */
    member: (staff: PlanStaff, organizationId: string, userId: string) =>
      attempt(staff, STAFF_MEMBER_AUDIT.read, { organizationId, memberUserId: userId }, async (current) => {
        validate(current);
        const organization = await organizationOf(current);
        const found = await directory.member(organization, current.memberUserId);
        if (!found) throw memberNotFound();
        await recordAllowed(current, "member", { resource: "member" });
        return { organizationId: organization, member: staffMemberView(found.member), version: found.version };
      }),
  };
};

export type StaffMemberManagement = ReturnType<typeof createStaffMemberManagement>;
