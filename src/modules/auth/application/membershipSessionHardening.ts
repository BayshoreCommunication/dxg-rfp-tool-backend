// ORG-307: membership changes end the member's other refresh sessions.
// - Role change by someone else: the member isn't the actor, so we can't tell which of their
//   sessions is "theirs". The change flags the membership; the member's next request (on any
//   session) claims the flag atomically, keeps that session with the new roles and revokes the
//   rest. Role changes therefore apply on the next request with no sign-out.
// - Role change of the actor themselves (an Owner after transferring ownership), and a 2FA
//   reset: every other session ends now; the acting session is kept.
// - Deactivation: every session ends now.

export type MembershipChange = {
  organizationId: string;
  userId: string;
  actorUserId: string;
  actorSessionId?: string;
  correlationId: string;
};

type Dependencies = {
  revokeOtherSessions(input: {
    userId: string; organizationId: string; exceptSessionId?: string; reason: string; actorUserId?: string; correlationId: string;
  }): Promise<number>;
  markRevocationPending(input: { organizationId: string; userId: string }): Promise<void>;
  claimRevocationPending(input: { organizationId: string; userId: string }): Promise<boolean>;
};

export const createMembershipSessionHardening = (dependencies: Dependencies) => {
  const keptSession = (change: MembershipChange) =>
    change.actorUserId === change.userId ? change.actorSessionId : undefined;

  const afterRoleChange = async (change: MembershipChange) => {
    if (change.actorUserId === change.userId) {
      return dependencies.revokeOtherSessions({ ...change, exceptSessionId: keptSession(change), reason: "membership_role_changed" });
    }
    await dependencies.markRevocationPending(change);
    return 0;
  };

  const afterDeactivation = (change: MembershipChange) =>
    dependencies.revokeOtherSessions({ ...change, exceptSessionId: undefined, reason: "membership_deactivated" });

  // For ORG-304: call after an Admin (or the member) resets the member's 2FA.
  const afterTwoFactorReset = (change: MembershipChange) =>
    dependencies.revokeOtherSessions({ ...change, exceptSessionId: keptSession(change), reason: "two_factor_reset" });

  // Called by the access path when the membership carries the flag. Only the request that wins
  // the claim revokes, so exactly one session survives.
  const onRequestWithPendingRevocation = async (input: { organizationId: string; userId: string; sessionId: string; correlationId: string }) => {
    if (!(await dependencies.claimRevocationPending(input))) return 0;
    return dependencies.revokeOtherSessions({
      userId: input.userId, organizationId: input.organizationId, exceptSessionId: input.sessionId,
      reason: "membership_role_changed", correlationId: input.correlationId,
    });
  };

  return { afterRoleChange, afterDeactivation, afterTwoFactorReset, onRequestWithPendingRevocation };
};

export type MembershipSessionHardening = ReturnType<typeof createMembershipSessionHardening>;
