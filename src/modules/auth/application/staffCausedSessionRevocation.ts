import { createMembershipSessionHardening } from "./membershipSessionHardening";
import type { SecurityAuditWriter } from "../domain/ports/sessionPorts";

/* What the access path does for a session revocation caused by a membership change that RFPILOT
   STAFF made. Staff no longer change members (owner decision, 2026-11-24; docs/DECISIONS.md), so
   no new cause is stored; this stays for the memberships that already carry one from the week
   staff member management existed, which must behave exactly as they did.
   Customers see no staff activity, so such a revocation is not written to the member's
   organization's audit trail. The security outcome is the customer flow's: the same sessions are
   revoked and the member is refused or kept exactly as before. Only where it is recorded differs:
   in the staff organization, under a `platform.` action.

   The cause is data the staff flow stored then (a StaffCause on the membership), never a guess. With
   no stored cause every call goes to the customer flow untouched. */

export type StaffCause = { organizationId?: string | null; actorUserId?: string | null };
export const STAFF_SESSIONS_REVOKED_ACTION = "platform.organization_member.sessions_revoked";

type Member = { userId: string; organizationId: string };
type PendingRequest = Member & { sessionId: string; correlationId: string };
type InactiveRequest = Member & { correlationId: string; reason?: string };
type Claims = Pick<Parameters<typeof createMembershipSessionHardening>[0], "claimRevocationPending" | "completeRevocationPending" | "releaseRevocationClaim">;

type Dependencies = {
  /** The staff cause on the membership's pending-revocation flag; null when a member of the organization set it. */
  pendingCause(member: Member): Promise<StaffCause | null>;
  /** The staff cause of the member's deactivation; null when the member is not deactivated, or not by staff. */
  suspensionCause(member: Member): Promise<StaffCause | null>;
  /** The customer flow, used unchanged whenever there is no staff cause. */
  customer: {
    onRequestWithPendingRevocation(input: PendingRequest): Promise<number>;
    revokeInactiveMembership(input: InactiveRequest): Promise<number>;
  };
  /** Revokes the member's sessions for the staff reason, writing nothing. */
  revokeSessions(input: Member & { exceptSessionId?: string }): Promise<number>;
  /** Claims on a pending flag that staff set. */
  staffClaims: Claims;
  audit: SecurityAuditWriter;
  isValidId(value: string): boolean;
};

export const createStaffCausedSessionRevocation = (dependencies: Dependencies) => {
  // Best effort: the sessions are already revoked and the member's request must not fail on it.
  const record = async (cause: StaffCause, input: Member & { correlationId: string; reason: string; revokedCount: number; keptSession: boolean }) => {
    if (input.revokedCount === 0 || !cause.organizationId || !dependencies.isValidId(cause.organizationId)) return;
    try {
      await dependencies.audit.append({
        organizationId: cause.organizationId,
        ...(cause.actorUserId && dependencies.isValidId(cause.actorUserId) ? { actorUserId: cause.actorUserId } : {}),
        action: STAFF_SESSIONS_REVOKED_ACTION,
        targetType: "organization_membership",
        targetId: input.userId,
        decision: "revoked",
        reason: input.reason,
        correlationId: input.correlationId,
        metadata: {
          agentAccountType: "admin", organizationId: input.organizationId, memberUserId: input.userId,
          revokedCount: input.revokedCount, keptSession: input.keptSession, trigger: "member_request",
        },
      });
    } catch (failure) {
      console.error("Staff member management error: a session revocation could not be recorded:", failure instanceof Error ? failure.message : failure);
    }
  };

  /* A request from a member whose membership carries the pending flag. Set by a member of the
     organization: the customer flow. Set by staff: the same lease, the member's other sessions
     revoked for the staff reason, recorded in the staff organization. */
  const revokeOtherSessionsAfterMembershipChange = async (input: PendingRequest) => {
    const cause = await dependencies.pendingCause(input);
    if (!cause) return dependencies.customer.onRequestWithPendingRevocation(input);
    return createMembershipSessionHardening({
      revokeOtherSessions: async (revocation) => {
        const revokedCount = await dependencies.revokeSessions({ userId: revocation.userId, organizationId: revocation.organizationId, exceptSessionId: revocation.exceptSessionId });
        await record(cause, { ...input, reason: revocation.reason, revokedCount, keptSession: true });
        return revokedCount;
      },
      markRevocationPending: async () => undefined,
      ...dependencies.staffClaims,
    }).onRequestWithPendingRevocation(input);
  };

  /* A request from a member who is no longer active. A given `reason` (an account waiting for
     placement) and a member not deactivated by staff: the customer flow. Deactivated by staff:
     every session revoked for the staff reason, recorded in the staff organization. */
  const revokeInactiveMembershipSessions = async (input: InactiveRequest) => {
    if (input.reason) return dependencies.customer.revokeInactiveMembership(input);
    let cause: StaffCause | null;
    try {
      cause = await dependencies.suspensionCause(input);
    } catch (failure) {
      // A failed read must not skip the revocation. Who deactivated the member is unknown, so the
      // sessions end for the staff reason and nothing is recorded: nothing can reach the member's
      // organization, and an unrecorded revocation is the lesser harm.
      console.error("Staff member management error: the cause of a deactivation could not be read:", failure instanceof Error ? failure.message : failure);
      return dependencies.revokeSessions({ userId: input.userId, organizationId: input.organizationId });
    }
    if (!cause) return dependencies.customer.revokeInactiveMembership(input);
    const revokedCount = await dependencies.revokeSessions({ userId: input.userId, organizationId: input.organizationId });
    await record(cause, { ...input, reason: "membership_inactive", revokedCount, keptSession: false });
    return revokedCount;
  };

  return { revokeOtherSessionsAfterMembershipChange, revokeInactiveMembershipSessions };
};
