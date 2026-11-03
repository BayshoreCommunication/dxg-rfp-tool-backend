const assert = require("node:assert/strict");
const test = require("node:test");
const { createMembershipSessionHardening } = require("../src/modules/auth/application/membershipSessionHardening");

const harness = () => {
  const revoked = [];
  let pending = false;
  let claim = null;
  let failNext = false;
  const hooks = createMembershipSessionHardening({
    revokeOtherSessions: async (input) => {
      if (failNext) { failNext = false; throw new Error("session store down"); }
      revoked.push(input);
      return 2;
    },
    markRevocationPending: async () => { pending = true; claim = null; },
    claimRevocationPending: async ({ sessionId }) => {
      if (!pending || claim) return false;
      claim = sessionId;
      return true;
    },
    completeRevocationPending: async ({ sessionId }) => { if (claim === sessionId) { pending = false; claim = null; } },
    releaseRevocationClaim: async ({ sessionId }) => { if (claim === sessionId) claim = null; },
  });
  return { hooks, revoked, isPending: () => pending, failNextRevocation: () => { failNext = true; } };
};
const change = (over = {}) => ({ organizationId: "o", userId: "member", actorUserId: "admin", actorSessionId: "admin-session", correlationId: "c", ...over });

test("a role change by someone else defers revocation to the member's next request", async () => {
  const { hooks, revoked, isPending } = harness();
  await hooks.afterRoleChange(change());
  assert.equal(revoked.length, 0, "the admin's acting session must not be touched");
  assert.equal(isPending(), true);

  assert.equal(await hooks.onRequestWithPendingRevocation({ organizationId: "o", userId: "member", sessionId: "s1", correlationId: "c" }), 2);
  assert.deepEqual(revoked[0], { userId: "member", organizationId: "o", exceptSessionId: "s1", reason: "membership_role_changed", correlationId: "c" });
  // Only the first request claims; a second session can't also keep itself alive.
  assert.equal(await hooks.onRequestWithPendingRevocation({ organizationId: "o", userId: "member", sessionId: "s2", correlationId: "c" }), 0);
  assert.equal(revoked.length, 1);
});

test("a self role change and a 2FA reset keep the acting session and end the others now", async () => {
  const { hooks, revoked, isPending } = harness();
  await hooks.afterRoleChange(change({ actorUserId: "member", actorSessionId: "mine" }));
  await hooks.afterTwoFactorReset(change({ actorUserId: "member", actorSessionId: "mine" }));
  await hooks.afterTwoFactorReset(change());
  assert.equal(isPending(), false);
  assert.deepEqual(revoked.map((r) => [r.reason, r.exceptSessionId]), [
    ["membership_role_changed", "mine"], ["two_factor_reset", "mine"], ["two_factor_reset", undefined],
  ]);
});

test("deactivation ends every session", async () => {
  const { hooks, revoked } = harness();
  await hooks.afterDeactivation(change({ actorUserId: "member", actorSessionId: "mine" }));
  assert.equal(revoked[0].exceptSessionId, undefined);
  assert.equal(revoked[0].reason, "membership_deactivated");
});

test("a failed revocation keeps the flag, so the next request revokes", async () => {
  const { hooks, revoked, isPending, failNextRevocation } = harness();
  await hooks.afterRoleChange(change());
  failNextRevocation();
  await assert.rejects(hooks.onRequestWithPendingRevocation({ organizationId: "o", userId: "member", sessionId: "s1", correlationId: "c" }));
  assert.equal(isPending(), true, "the flag must survive a failed revocation");
  assert.equal(await hooks.onRequestWithPendingRevocation({ organizationId: "o", userId: "member", sessionId: "s2", correlationId: "c" }), 2);
  assert.equal(revoked[0].exceptSessionId, "s2");
  assert.equal(isPending(), false);
});

test("a demotion by someone else ends every session of the member now; a promotion waits", async () => {
  const { hooks, revoked, isPending } = harness();
  assert.equal(await hooks.afterRoleChange(change({ demoted: true })), 2);
  assert.deepEqual(revoked[0], { organizationId: "o", userId: "member", actorUserId: "admin", actorSessionId: "admin-session", correlationId: "c", demoted: true, exceptSessionId: undefined, reason: "membership_role_demoted" });
  assert.equal(isPending(), false);
  await hooks.afterRoleChange(change({ demoted: false }));
  assert.equal(revoked.length, 1);
  assert.equal(isPending(), true);
  // A self change keeps the acting session even when it is a demotion (an Owner who transferred).
  await hooks.afterRoleChange(change({ actorUserId: "member", actorSessionId: "mine", demoted: true }));
  assert.equal(revoked.at(-1).exceptSessionId, "mine");
});
