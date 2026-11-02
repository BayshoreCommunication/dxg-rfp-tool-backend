require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSessionManager } = require("../src/modules/auth/application/manageSessions");
const { resolveRfpActor, noTeamsOrShares } = require("../src/modules/identity/application/resolveRfpActor");

const fakeManager = (revokedCounts) => {
  const calls = { revokeAll: [], audit: [] };
  const manager = createSessionManager({
    sessions: { revokeAll: async (input) => { calls.revokeAll.push(input); return revokedCounts.shift() ?? 0; } },
    accounts: {},
    accessTokens: {},
    audit: { append: async (event) => { calls.audit.push(event); } },
    now: () => new Date("2026-11-01T00:00:00Z"),
  });
  return { manager, calls };
};

test("an inactive membership revokes every refresh session in that organization", async () => {
  const { manager, calls } = fakeManager([2]);
  const revoked = await manager.revokeInactiveMembership({ userId: "u1", organizationId: "o1", correlationId: "c1" });
  assert.equal(revoked, 2);
  assert.deepEqual(calls.revokeAll, [{ userId: "u1", organizationId: "o1", reason: "membership_inactive", now: new Date("2026-11-01T00:00:00Z") }]);
  assert.equal(calls.audit.length, 1);
  assert.equal(calls.audit[0].reason, "membership_inactive");
  assert.deepEqual(calls.audit[0].metadata, { revokedCount: 2 });
});

test("later requests that revoke nothing write no audit event", async () => {
  const { manager, calls } = fakeManager([0]);
  assert.equal(await manager.revokeInactiveMembership({ userId: "u1", organizationId: "o1", correlationId: "c2" }), 0);
  assert.equal(calls.audit.length, 0);
});

test("an active membership resolves teams and shares through the lookups", async () => {
  const seen = [];
  const actor = await resolveRfpActor(
    { organizationId: "o1", userId: "u1", roles: ["team_manager"], status: "active" },
    {
      managedTeamIds: async (scope) => { seen.push(["teams", scope]); return ["t1"]; },
      shares: async (scope) => { seen.push(["shares", scope]); return new Map([["p1", "edit"]]); },
    },
  );
  assert.deepEqual(actor.managedTeamIds, ["t1"]);
  assert.equal(actor.shares.get("p1"), "edit");
  assert.equal(actor.membershipStatus, "active");
  assert.deepEqual(seen.map(([kind]) => kind).sort(), ["shares", "teams"]);
  assert.deepEqual(seen[0][1], { organizationId: "o1", userId: "u1" });
});

test("an inactive membership skips the lookups and carries nothing", async () => {
  const fail = async () => { throw new Error("lookup should not run"); };
  const actor = await resolveRfpActor({ organizationId: "o1", userId: "u1", roles: ["owner"], status: "suspended" }, { managedTeamIds: fail, shares: fail });
  assert.deepEqual(actor.managedTeamIds, []);
  assert.equal(actor.shares.size, 0);
  assert.equal(actor.membershipStatus, "suspended");
});

test("the no-teams lookups give an actor only role and ownership reach", async () => {
  const actor = await resolveRfpActor({ organizationId: "o1", userId: "u1", roles: ["planner"], status: "active" }, noTeamsOrShares);
  assert.deepEqual(actor.managedTeamIds, []);
  assert.equal(actor.shares.size, 0);
});
