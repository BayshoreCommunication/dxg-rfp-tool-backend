const assert = require("node:assert/strict");
const test = require("node:test");
const { createMembershipSessionHardening } = require("../src/modules/auth/application/membershipSessionHardening");

const harness = () => {
  const revoked = [];
  let pending = false;
  const hooks = createMembershipSessionHardening({
    revokeOtherSessions: async (input) => { revoked.push(input); return 2; },
    markRevocationPending: async () => { pending = true; },
    claimRevocationPending: async () => { const had = pending; pending = false; return had; },
  });
  return { hooks, revoked, isPending: () => pending };
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
