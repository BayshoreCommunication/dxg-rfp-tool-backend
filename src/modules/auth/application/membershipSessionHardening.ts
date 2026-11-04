// ORG-307: membership changes end the member's other refresh sessions.
// - Promotion or lateral role change by someone else: the member isn't the actor, so we can't
//   tell which of their sessions is "theirs". The change flags the membership; the member's next
//   request (on any session) claims the flag, revokes the rest and only then clears it. Roles are
//   read live per request, so the change applies on that request with no sign-out.
// - Demotion by someone else: every session of the member ends now (DECISIONS.md, ORG-307). Lost
//   rights already stop on the next request; ending the sessions also stops a session nobody is
//   watching from carrying on until the member happens to make a request.
// - Role change of the actor themselves (an Owner after transferring ownership), and a 2FA
//   reset: every other session ends now; the acting session is kept.
// - Deactivation: every session ends now.

export type MembershipChange = {
  organizationId: string;
  userId: string;
  actorUserId: string;
  actorSessionId?: string;
  correlationId: string;
  // True when the member lost rights (a lower role, or a role removed).
  demoted?: boolean;
};

type Dependencies = {
  revokeOtherSessions(input: {
    userId: string; organizationId: string; exceptSessionId?: string; reason: string; actorUserId?: string; correlationId: string;
  }): Promise<number>;
  markRevocationPending(input: { organizationId: string; userId: string }): Promise<void>;
  // Takes a short lease on the pending flag for one session; false when there's no flag or
  // another request holds a live lease.
  claimRevocationPending(input: { organizationId: string; userId: string; sessionId: string }): Promise<boolean>;
  // Clears the flag (it stays set if a newer change re-flagged meanwhile) and drops the lease.
  completeRevocationPending(input: { organizationId: string; userId: string; sessionId: string }): Promise<void>;
  // Drops the lease and leaves the flag, so the next request retries.
  releaseRevocationClaim(input: { organizationId: string; userId: string; sessionId: string }): Promise<void>;
};

export const createMembershipSessionHardening = (dependencies: Dependencies) => {
  const keptSession = (change: MembershipChange) =>
    change.actorUserId === change.userId ? change.actorSessionId : undefined;

  const afterRoleChange = async (change: MembershipChange) => {
    if (change.actorUserId === change.userId) {
      return dependencies.revokeOtherSessions({ ...change, exceptSessionId: keptSession(change), reason: "membership_role_changed" });
    }
    if (change.demoted) {
      return dependencies.revokeOtherSessions({ ...change, exceptSessionId: undefined, reason: "membership_role_demoted" });
    }
    await dependencies.markRevocationPending(change);
    return 0;
  };

  const afterDeactivation = (change: MembershipChange) =>
    dependencies.revokeOtherSessions({ ...change, exceptSessionId: undefined, reason: "membership_deactivated" });

  // For ORG-304: call after an Admin (or the member) resets the member's 2FA.
  const afterTwoFactorReset = (change: MembershipChange) =>
    dependencies.revokeOtherSessions({ ...change, exceptSessionId: keptSession(change), reason: "two_factor_reset" });

  // Called by the access path when the membership carries the flag. Only the request holding the
  // lease revokes, so exactly one session survives; the flag clears only after the revocation
  // succeeded, so a failure leaves it for the next request.
  const onRequestWithPendingRevocation = async (input: { organizationId: string; userId: string; sessionId: string; correlationId: string }) => {
    if (!(await dependencies.claimRevocationPending(input))) return 0;
    let revoked: number;
    try {
      revoked = await dependencies.revokeOtherSessions({
        userId: input.userId, organizationId: input.organizationId, exceptSessionId: input.sessionId,
        reason: "membership_role_changed", correlationId: input.correlationId,
      });
    } catch (error) {
      await dependencies.releaseRevocationClaim(input).catch(() => undefined);
      throw error;
    }
    await dependencies.completeRevocationPending(input);
    return revoked;
  };

  return { afterRoleChange, afterDeactivation, afterTwoFactorReset, onRequestWithPendingRevocation };
};

export type MembershipSessionHardening = ReturnType<typeof createMembershipSessionHardening>;
