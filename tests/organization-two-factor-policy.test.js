const test = require("node:test");
const assert = require("node:assert/strict");
const { createOrganizationTwoFactorPolicy } = require("../src/modules/twoFactor/application/organizationTwoFactorPolicy");

const setup = () => {
  const state = { requires: false, members: new Map([["owner", ["owner"]], ["admin", ["organization_admin"]], ["planner", ["planner"]], ["viewer", ["viewer"]]]), enrolled: new Set(["owner", "admin"]), elsewhere: new Set() };
  const revoked = [];
  const resets = [];
  const audits = [];
  const policy = createOrganizationTwoFactorPolicy({
    directory: {
      async requiresTwoFactor() { return state.requires; },
      async setRequiresTwoFactor(_org, value) { state.requires = value; },
      async membership(_org, userId) { const roles = state.members.get(userId); return roles ? { roles, status: "active" } : null; },
      async activeElsewhere(_org, userId) { return state.elsewhere.has(userId); },
      async activeMemberIds() { return [...state.members.keys()]; },
      async enrolledUserIds(ids) { return ids.filter((id) => state.enrolled.has(id)); },
    },
    twoFactor: { async adminReset(input) { resets.push(input); return { kind: "reset", wasEnrolled: true, revokedSessions: 1 }; } },
    revokeMemberSessions: async (input) => { revoked.push(input.userId); return input.userId === "viewer" ? 0 : 1; },
    audit: { async append(event) { audits.push(event); } },
  });
  return { policy, state, revoked, resets, audits };
};

test("turning the requirement on signs out non-enrolled members and is audited", async () => {
  const ctx = setup();
  const result = await ctx.policy.setRequireTwoFactor({ organizationId: "o1", actorUserId: "admin", requireTwoFactor: true, correlationId: "c" });
  assert.deepEqual(result, { kind: "updated", requireTwoFactor: true, signedOutMembers: 1 });
  assert.deepEqual(ctx.revoked.sort(), ["planner", "viewer"]);
  const audit = ctx.audits.find((a) => a.action === "organization.settings.updated");
  assert.equal(audit.actorUserId, "admin");
  assert.deepEqual(audit.metadata, { setting: "requireTwoFactor", from: false, to: true, signedOutMembers: 1 });
  assert.deepEqual(await ctx.policy.settings("o1"), { requireTwoFactor: true, activeMembers: 4, membersWithoutTwoFactor: 2 });
});

test("an Admin without 2FA can't require it; bad input and no-ops change nothing", async () => {
  const ctx = setup();
  ctx.state.enrolled.delete("admin");
  assert.equal((await ctx.policy.setRequireTwoFactor({ organizationId: "o1", actorUserId: "admin", requireTwoFactor: true, correlationId: "c" })).kind, "actor_not_enrolled");
  assert.equal((await ctx.policy.setRequireTwoFactor({ organizationId: "o1", actorUserId: "owner", requireTwoFactor: "yes", correlationId: "c" })).kind, "validation");
  assert.equal((await ctx.policy.setRequireTwoFactor({ organizationId: "o1", actorUserId: "owner", requireTwoFactor: false, correlationId: "c" })).kind, "unchanged");
  assert.equal(ctx.state.requires, false);
  assert.equal(ctx.audits.length, 0);
});

test("turning it off signs no one out", async () => {
  const ctx = setup();
  ctx.state.requires = true;
  assert.equal((await ctx.policy.setRequireTwoFactor({ organizationId: "o1", actorUserId: "owner", requireTwoFactor: false, correlationId: "c" })).kind, "updated");
  assert.deepEqual(ctx.revoked, []);
});

test("reset: members of the organization only, never yourself, and only the Owner resets the Owner", async () => {
  const ctx = setup();
  const reset = (actor, actorRoles, target) => ctx.policy.resetMember({ organizationId: "o1", actorUserId: actor, actorRoles, targetUserId: target, correlationId: "c" });
  assert.equal((await reset("admin", ["organization_admin"], "planner")).kind, "reset");
  assert.equal((await reset("admin", ["organization_admin"], "admin")).kind, "self");
  assert.equal((await reset("admin", ["organization_admin"], "stranger")).kind, "not_found");
  assert.equal((await reset("admin", ["organization_admin"], "owner")).kind, "forbidden");
  assert.equal((await reset("owner", ["owner"], "admin")).kind, "reset");
  assert.deepEqual(ctx.resets.map((r) => [r.actorUserId, r.targetUserId]), [["admin", "planner"], ["owner", "admin"]]);
});

test("reset is refused when the member also belongs to another organization, whose factor it would remove", async () => {
  const ctx = setup();
  ctx.state.elsewhere.add("planner");
  const result = await ctx.policy.resetMember({ organizationId: "o1", actorUserId: "owner", actorRoles: ["owner"], targetUserId: "planner", correlationId: "c" });
  assert.equal(result.kind, "member_of_other_organization");
  assert.deepEqual(ctx.resets, []);
  // Membership and role checks still come first: a stranger is still not_found.
  assert.equal((await ctx.policy.resetMember({ organizationId: "o1", actorUserId: "owner", actorRoles: ["owner"], targetUserId: "stranger", correlationId: "c" })).kind, "not_found");
});
