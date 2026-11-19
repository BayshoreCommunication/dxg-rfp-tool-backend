import { isPlanStaff, type PlanStaff } from "../../entitlements/application/manageOrganizationPlans";
import { parseVersion } from "../../organizationMembers/application/manageMembers";
import {
  MAX_SELECTED_RFPS,
  STAFF_MANAGER,
  customerRole,
  decideDeactivation,
  decideOwnershipTransfer,
  decideReactivation,
  decideReassignment,
  decideRoleChange,
  isAssignableRole,
  isDemotion,
  ownerHasRfps,
  withCustomerRole,
  type CustomerRole,
  type Decision,
  type Refusal,
} from "../../organizationMembers/domain/memberPolicy";
import type {
  MemberChangeAudit,
  MemberRecord,
  MembershipStore,
  MemberSessionHooks,
  RfpOwnershipMirror,
  RfpReassignmentStore,
} from "../../organizationMembers/domain/ports";
import { STAFF_MEMBER_AUDIT, StaffAccessError, StaffMemberError, type StaffMemberDirectory } from "../domain";
import { staffMemberView, type StaffContentAudit } from "./readOrganizationContent";

/* Staff member management (owner decision, 2026-11-18; docs/DECISIONS.md). RFPilot staff change a
   member's role, deactivate and reactivate a member, reassign a member's proposals and transfer
   ownership, in a customer organization.

   The rules are the customer's own. Every decision is asked of the same policy
   (organizationMembers/domain/memberPolicy.ts) and every write goes through the same membership
   store, so the refusals, the optimistic version check, the in-transaction "still owns proposals"
   check and the session revocation are the ones the organization's Owner and Admins get. What
   differs is the actor: staff are NOT members. They are passed to the policy as STAFF_MANAGER,
   which has no user id and no role in the organization; no membership is created, faked or
   written for them. The Owner is transfer-only: a role change never moves a member to or from
   Owner, the Owner can't be deactivated, and a transfer leaves exactly one Owner.

   Tenant scope: the organization is the one in the path and nothing else. Every read and write
   names it together with the member's user id, so a member (or a reassignment or transfer target)
   that belongs to another organization is "not found". RFPilot's own organization and a legacy
   holding tenant are refused (409 ORGANIZATION_NOT_MANAGEABLE).

   Audit: after the staff check, every request leaves exactly ONE event, in the STAFF
   organization (`organizationId: staff.organizationId`), under a `platform.organization_member.*`
   action: `allowed` for a change (or a request that found nothing to change), `denied` for a
   refusal. An applied change's event is inserted by the store in the SAME MongoDB transaction as
   the change, so a change is never applied without its record. Nothing is written to the
   customer organization's audit trail: none of `organization.member.*`,
   `organization.ownership.transferred`, `proposal.owner.reassigned` or
   `auth.sessions.revoked_others` is written when the actor is staff.

   Sessions: the event of a change is written BEFORE the member's sessions are revoked, so it says
   what is true then: `revocation_requested` (every session ends now) or
   `next_request_revocation_requested` (the member's next request ends the other ones). If the
   revocation then fails the request fails; repeating it finds nothing to change and asks for the
   revocation again, so a retry repairs it. The revocation itself, and what the member's later
   requests do because of it, is never written to the customer organization either
   (auth/composition.ts and auth/application/staffCausedSessionRevocation.ts). */

const ID = /^[a-f0-9]{24}$/;
export const STAFF_REASON_MIN = 10;
export const STAFF_REASON_MAX = 500;

type Dependencies = {
  directory: StaffMemberDirectory;
  store: MembershipStore;
  reassignments: RfpReassignmentStore;
  ownershipMirror: RfpOwnershipMirror;
  /** Ends the member's sessions without writing to the member's organization's audit trail. */
  sessions: MemberSessionHooks;
  /** Refusals and requests that changed nothing. An applied change's event goes through the store. */
  audit: StaffContentAudit;
};

type Attempt = {
  staff: PlanStaff;
  action: string;
  /** As the caller typed them: validated before they are used in a query. */
  organizationId: string;
  memberUserId: string;
  staffReason: string | null;
};

// What a caller typed in a path or body, cut to an id's length before it is stored.
const asTyped = (value: unknown) => (typeof value === "string" ? value.slice(0, 64) : "");

const refused = (status: number, code: string, message: string, details?: Record<string, unknown>) => new StaffMemberError(code, message, status, details);
const fromRefusal = (refusal: Refusal) => refused(refusal.status, refusal.code, refusal.message, refusal.details);
const allow = (decision: Decision) => {
  if (!decision.ok) throw fromRefusal(decision);
};
const memberNotFound = () => refused(404, "MEMBER_NOT_FOUND", "Member not found.");
const stale = (current: MemberRecord | null) =>
  refused(409, "STALE_VERSION", "This member was changed by someone else. Reload and try again.", { currentVersion: current?.version ?? null });

const parseReason = (value: unknown): string => {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length < STAFF_REASON_MIN || reason.length > STAFF_REASON_MAX) {
    const message = `Give a reason of ${STAFF_REASON_MIN} to ${STAFF_REASON_MAX} characters.`;
    throw refused(400, "INVALID_REASON", message, { fields: { reason: message } });
  }
  return reason;
};

const versionOf = (value: unknown): number => {
  const version = parseVersion(value);
  if (version === null) throw refused(400, "VERSION_REQUIRED", "The member's current version is required.");
  return version;
};

export const createStaffMemberManagement = (dependencies: Dependencies) => {
  const { directory, store, reassignments, ownershipMirror, sessions, audit } = dependencies;

  const assertStaff = (staff: PlanStaff) => {
    if (!isPlanStaff(staff)) throw new StaffAccessError("STAFF_ACCESS_FORBIDDEN", "Only RFPilot staff can do that.", 403);
    if (!staff.adminId || !staff.organizationId) throw new StaffAccessError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  };

  // Every event of this service. Its organization is always the staff member's own; the
  // customer organization and the member appear only as the target and in the metadata.
  const eventOf = (attempt: Attempt, reason: string, metadata: Record<string, unknown>): MemberChangeAudit => ({
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
      ...(attempt.staffReason ? { staffReason: attempt.staffReason } : {}),
      ...metadata,
    },
  });

  // A request that changed nothing (a read, or a change that was already in place). Awaited
  // before anything is returned: if it can't be written the request fails.
  const recordAllowed = (attempt: Attempt, reason: string, metadata: Record<string, unknown>) =>
    audit.append({ ...eventOf(attempt, reason, metadata), decision: "allowed" });

  // A refusal: nothing was changed, so the answer is returned whether or not this can be written.
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
    const current: Attempt = { staff, action, organizationId: asTyped(where.organizationId), memberUserId: asTyped(where.memberUserId), staffReason: null };
    try {
      return await work(current);
    } catch (error) {
      if (error instanceof StaffMemberError) await recordDenied(current, error);
      throw error;
    }
  };

  // Ids first (nothing is looked up for a malformed one), then the reason every write carries.
  const validate = (current: Attempt, input: { reason?: unknown } | null, memberCode: { code: string; message: string }) => {
    if (!ID.test(current.organizationId)) throw refused(400, "INVALID_ORGANIZATION_ID", "That is not an organization id.");
    if (!ID.test(current.memberUserId)) throw refused(400, memberCode.code, memberCode.message);
    if (input) current.staffReason = parseReason(input.reason);
  };
  const MEMBER_ID = { code: "INVALID_MEMBER_ID", message: "That is not a member id." };

  // The organization in the path: it must exist, be a customer organization, and not be RFPilot's.
  const organizationOf = async (current: Attempt): Promise<string> => {
    const organization = await directory.organization(current.organizationId);
    if (!organization) throw refused(404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
    if (organization.id === current.staff.organizationId || organization.staffAccountCount > 0) {
      throw refused(409, "ORGANIZATION_NOT_MANAGEABLE", "Members of RFPilot's own organization can't be managed here.", { standing: "platform" });
    }
    if (organization.kind !== "customer") {
      throw refused(409, "ORGANIZATION_NOT_MANAGEABLE", "This organization is awaiting placement. Its members can't be managed yet.", { standing: organization.kind });
    }
    return organization.id;
  };

  const memberOf = async (organizationId: string, userId: string): Promise<MemberRecord> => {
    const member = await store.find(organizationId, userId);
    if (!member) throw memberNotFound();
    return member;
  };

  // The answer: the member through the staff member allowlist, with the version the next write needs.
  const viewOf = async (organizationId: string, userId: string) => {
    const found = await directory.member(organizationId, userId);
    if (!found) throw new Error("The member could not be read back.");
    return { member: staffMemberView(found.member), version: found.version };
  };

  const sessionChange = (current: Attempt, organizationId: string, userId: string) =>
    ({ organizationId, userId, actorUserId: current.staff.adminId, correlationId: current.staff.correlationId, staffOrganizationId: current.staff.organizationId });

  const facts = (member: MemberRecord) => ({ role: customerRole(member.roles), roles: [...member.roles], status: member.status });

  return {
    /** One member with its version: what a write needs and the members list does not carry. */
    member: (staff: PlanStaff, organizationId: string, userId: string) =>
      attempt(staff, STAFF_MEMBER_AUDIT.read, { organizationId, memberUserId: userId }, async (current) => {
        validate(current, null, MEMBER_ID);
        const organization = await organizationOf(current);
        const found = await directory.member(organization, current.memberUserId);
        if (!found) throw memberNotFound();
        await recordAllowed(current, "member", { resource: "member" });
        return { organizationId: organization, member: staffMemberView(found.member), version: found.version };
      }),

    changeRole: (staff: PlanStaff, organizationId: string, userId: string, input: { role?: unknown; version?: unknown; reason?: unknown }) =>
      attempt(staff, STAFF_MEMBER_AUDIT.roleChanged, { organizationId, memberUserId: userId }, async (current) => {
        validate(current, input, MEMBER_ID);
        if (input.role !== "owner" && !isAssignableRole(input.role)) {
          throw refused(400, "INVALID_ROLE", "Role must be one of organization_admin, team_manager, planner or viewer.");
        }
        const role = input.role as CustomerRole;
        const version = versionOf(input.version);
        const organization = await organizationOf(current);
        const target = await memberOf(organization, current.memberUserId);
        if (target.version !== version) throw stale(target);
        const ownedRfpCount = role === "viewer" ? await store.countOwnedRfps(organization, target.userId) : 0;
        // Refuses `owner` as the new role and the Owner as the member: staff only transfer.
        allow(decideRoleChange({ actor: STAFF_MANAGER, target, role, ownedRfpCount }));
        const before = facts(target);
        if (before.role === role) {
          // Nothing to change; the direction of the change that put the role in place isn't known
          // here, so the member's next request ends their other sessions (a retry's repair).
          await recordAllowed(current, "role_unchanged", { changed: false, before, after: before, sessions: "next_request_revocation_requested" });
          await sessions.afterRoleChange(sessionChange(current, organization, target.userId));
          return { organizationId: organization, changed: false, ...(await viewOf(organization, target.userId)) };
        }
        const roles = withCustomerRole(target.roles, role);
        const demoted = isDemotion(target.roles, roles);
        const updated = await store.setRoles({
          organizationId: organization, userId: target.userId, expectedVersion: version, roles,
          audit: eventOf(current, "role_changed", {
            changed: true, before, after: { role, roles, status: target.status },
            sessions: demoted ? "revocation_requested" : "next_request_revocation_requested",
          }),
        });
        if (updated === "stale") throw stale(await store.find(organization, target.userId));
        // A proposal reassigned to the member between the count above and the write.
        if ("ownedRfpCount" in updated) throw fromRefusal(ownerHasRfps(updated.ownedRfpCount));
        await sessions.afterRoleChange({ ...sessionChange(current, organization, target.userId), demoted });
        return { organizationId: organization, changed: true, ...(await viewOf(organization, target.userId)) };
      }),

    deactivate: (staff: PlanStaff, organizationId: string, userId: string, input: { version?: unknown; reason?: unknown }) =>
      attempt(staff, STAFF_MEMBER_AUDIT.deactivated, { organizationId, memberUserId: userId }, async (current) => {
        validate(current, input, MEMBER_ID);
        const version = versionOf(input.version);
        const organization = await organizationOf(current);
        const target = await memberOf(organization, current.memberUserId);
        if (target.version !== version) throw stale(target);
        const before = facts(target);
        if (target.status === "suspended") {
          await recordAllowed(current, "member_already_deactivated", { changed: false, before, after: before, sessions: "revocation_requested" });
          await sessions.afterDeactivation(sessionChange(current, organization, target.userId));
          return { organizationId: organization, changed: false, ...(await viewOf(organization, target.userId)) };
        }
        const ownedRfpCount = await store.countOwnedRfps(organization, target.userId);
        // Refuses the Owner (LAST_OWNER): staff transfer ownership first, like anyone else.
        allow(decideDeactivation({ actor: STAFF_MANAGER, target, ownedRfpCount }));
        const updated = await store.deactivate({
          organizationId: organization, userId: target.userId, expectedVersion: version, now: new Date(),
          audit: eventOf(current, "member_deactivated", { changed: true, before, after: { ...before, status: "suspended" }, sessions: "revocation_requested" }),
          // Committed with the put-back if the member has to be put back after the commit.
          revertAudit: eventOf(current, "member_deactivation_reverted", { changed: false, reverted: true, before: { ...before, status: "suspended" }, after: before }),
        });
        if (updated === "stale") throw stale(await store.find(organization, target.userId));
        if ("ownedRfpCount" in updated) {
          // `reverted`: the member created a proposal while the deactivation committed and was put
          // back. The allowed event was already written, and the store committed the put-back
          // together with the `member_deactivation_reverted` event; this refusal follows them.
          const refusal = ownerHasRfps(updated.ownedRfpCount);
          throw refused(refusal.status, refusal.code, refusal.message, { ...refusal.details, ...(updated.reverted ? { reverted: true } : {}) });
        }
        await sessions.afterDeactivation(sessionChange(current, organization, target.userId));
        return { organizationId: organization, changed: true, ...(await viewOf(organization, target.userId)) };
      }),

    reactivate: (staff: PlanStaff, organizationId: string, userId: string, input: { version?: unknown; reason?: unknown }) =>
      attempt(staff, STAFF_MEMBER_AUDIT.reactivated, { organizationId, memberUserId: userId }, async (current) => {
        validate(current, input, MEMBER_ID);
        const version = versionOf(input.version);
        const organization = await organizationOf(current);
        const target = await memberOf(organization, current.memberUserId);
        if (target.version !== version) throw stale(target);
        allow(decideReactivation({ target }));
        const before = facts(target);
        if (target.status === "active") {
          await recordAllowed(current, "member_already_active", { changed: false, before, after: before });
          return { organizationId: organization, changed: false, ...(await viewOf(organization, target.userId)) };
        }
        const updated = await store.reactivate({
          organizationId: organization, userId: target.userId, expectedVersion: version,
          audit: eventOf(current, "member_reactivated", { changed: true, before, after: { ...before, status: "active" } }),
        });
        if (updated === "stale") throw stale(await store.find(organization, target.userId));
        return { organizationId: organization, changed: true, ...(await viewOf(organization, target.userId)) };
      }),

    /* The current Owner, whoever that is, becomes an Admin and `toUserId` becomes the Owner, in
       one transaction. Staff need not be (and never are) the Owner; everything else is the
       customer's transfer. `version` is the new Owner's current membership version. */
    transferOwnership: (staff: PlanStaff, organizationId: string, input: { toUserId?: unknown; version?: unknown; reason?: unknown }) =>
      attempt(staff, STAFF_MEMBER_AUDIT.ownershipTransferred, { organizationId, memberUserId: input.toUserId }, async (current) => {
        validate(current, input, { code: "MEMBER_REQUIRED", message: "Choose the member who becomes the Owner." });
        const toUserId = current.memberUserId;
        const version = versionOf(input.version);
        const organization = await organizationOf(current);
        const target = await store.find(organization, toUserId);
        allow(decideOwnershipTransfer({ actor: STAFF_MANAGER, target }));
        if (!target) throw memberNotFound();
        if (target.version !== version) throw stale(target);
        const owner = await store.activeOwner(organization);
        if (!owner) throw refused(409, "OWNER_NOT_FOUND", "This organization has no active Owner to transfer from.");
        const result = await store.transferOwnership({
          organizationId: organization, fromUserId: owner.userId, toUserId, expectedTargetVersion: version,
          audit: eventOf(current, "ownership_transferred", {
            changed: true,
            previousOwnerUserId: owner.userId,
            before: { ownerUserId: owner.userId, newOwnerRole: customerRole(target.roles), previousOwnerRole: "owner" },
            after: { ownerUserId: toUserId, newOwnerRole: "owner", previousOwnerRole: "organization_admin" },
            sessions: { previousOwner: "revocation_requested", newOwner: "next_request_revocation_requested" },
          }),
        });
        // Someone else moved the ownership between the read above and the commit.
        if (result === "not_owner") throw refused(409, "OWNER_CHANGED", "The Owner changed while this was being saved. Reload and try again.");
        if (result === "stale") throw stale(await store.find(organization, toUserId));
        // The previous Owner lost rights through someone else's action: every session ends now.
        await sessions.afterRoleChange({ ...sessionChange(current, organization, owner.userId), demoted: true });
        await sessions.afterRoleChange(sessionChange(current, organization, toUserId));
        return { organizationId: organization, previousOwner: await viewOf(organization, owner.userId), owner: await viewOf(organization, toUserId) };
      }),

    /* Offboarding: all, or the selected, proposals owned by the member move to another active
       member of the SAME organization who isn't a Viewer. One staff-side event for the request;
       the per-proposal `proposal.owner.reassigned` events of the customer flow are not written. */
    reassignRfps: (staff: PlanStaff, organizationId: string, fromUserId: string, input: { toUserId?: unknown; rfpIds?: unknown; reason?: unknown }) =>
      attempt(staff, STAFF_MEMBER_AUDIT.proposalsReassigned, { organizationId, memberUserId: fromUserId }, async (current) => {
        validate(current, input, MEMBER_ID);
        const toUserId = typeof input.toUserId === "string" ? input.toUserId : "";
        if (!ID.test(toUserId)) throw refused(400, "REASSIGN_TARGET_REQUIRED", "Choose the member who receives the proposals.");
        let rfpIds: string[] | null = null;
        if (input.rfpIds !== undefined && input.rfpIds !== "all") {
          if (!Array.isArray(input.rfpIds) || input.rfpIds.length === 0 || input.rfpIds.length > MAX_SELECTED_RFPS ||
            !input.rfpIds.every((id) => typeof id === "string" && ID.test(id))) {
            throw refused(400, "INVALID_RFP_SELECTION", `Select between 1 and ${MAX_SELECTED_RFPS} proposals, or omit rfpIds to reassign all.`);
          }
          rfpIds = [...new Set(input.rfpIds as string[])];
        }
        const organization = await organizationOf(current);
        // Both looked up in the path's organization: a target in another one is not found.
        const [from, to] = await Promise.all([store.find(organization, current.memberUserId), store.find(organization, toUserId)]);
        allow(decideReassignment({ from, to }));
        const result = await reassignments.reassign({
          organizationId: organization, fromUserId: current.memberUserId, toUserId, rfpIds,
          // The store adds `reassignedCount` and the moved `rfpIds` inside the transaction.
          audit: eventOf(current, "proposals_reassigned", {
            changed: true, toUserId, selection: rfpIds ? "selected" : "all",
            before: { ownerUserId: current.memberUserId }, after: { ownerUserId: toUserId },
          }),
        });
        if (result === "target_ineligible") {
          throw refused(409, "REASSIGN_TARGET_INELIGIBLE", "Proposals can only go to an active member who isn't a Viewer.");
        }
        if ("notOwnedCount" in result) {
          throw refused(409, "RFPS_NOT_OWNED_BY_MEMBER", "Some selected proposals aren't owned by this member. Nothing was reassigned.", { notOwnedCount: result.notOwnedCount });
        }
        if (result.rfpIds.length > 0) await ownershipMirror.afterReassign({ organizationId: organization, rfpIds: result.rfpIds, toUserId });
        return { organizationId: organization, reassignedCount: result.rfpIds.length, rfpIds: result.rfpIds };
      }),
  };
};

export type StaffMemberManagement = ReturnType<typeof createStaffMemberManagement>;
