const assert = require("node:assert/strict");
const test = require("node:test");

const policy = require("../src/modules/organizationMembers/domain/memberPolicy");
const { createMemberManagement } = require("../src/modules/organizationMembers/application/manageMembers");

const ORG = "a".repeat(24);
const ids = { owner: "1".repeat(24), admin: "2".repeat(24), manager: "3".repeat(24), planner: "4".repeat(24), viewer: "5".repeat(24) };

const fakeStore = (members, owned = {}) => {
  const rows = new Map(members.map((m) => [m.userId, { membershipId: `m-${m.userId}`, name: m.userId, email: `${m.userId}@example.com`, lastSignedInAt: null, createdAt: null, version: 1, status: "active", ...m }]));
  const bump = (userId, version, patch) => {
    const row = rows.get(userId);
    if (!row || row.version !== version) return "stale";
    Object.assign(row, patch, { version: row.version + 1 });
    return { ...row };
  };
  return {
    rows,
    list: async () => [...rows.values()].map((r) => ({ ...r })),
    find: async (_org, userId) => (rows.has(userId) ? { ...rows.get(userId) } : null),
    countOwnedRfps: async (_org, userId) => owned[userId] ?? 0,
    setRoles: async ({ userId, expectedVersion, roles }) => bump(userId, expectedVersion, { roles }),
    deactivate: async ({ userId, expectedVersion }) => (owned[userId] ? { ownedRfpCount: owned[userId] } : bump(userId, expectedVersion, { status: "suspended" })),
    reactivate: async ({ userId, expectedVersion }) => bump(userId, expectedVersion, { status: "active" }),
  };
};

const setup = (owned = {}) => {
  const store = fakeStore([
    { userId: ids.owner, roles: ["owner"] },
    { userId: ids.admin, roles: ["organization_admin"] },
    { userId: ids.manager, roles: ["team_manager", "knowledge_editor"] },
    { userId: ids.planner, roles: ["planner"] },
    { userId: ids.viewer, roles: ["viewer"] },
  ], owned);
  const events = [];
  const sessionCalls = [];
  const reassignCalls = [];
  const mirrorCalls = [];
  let reassignResult = { rfpIds: ["b".repeat(24), "c".repeat(24)] };
  const members = createMemberManagement({
    store,
    teams: { teamsFor: async () => new Map([[ids.planner, [{ id: "t1", name: "East" }]]]) },
    audit: { append: async (event) => { events.push(event); } },
    reassignments: { reassign: async (input) => { reassignCalls.push(input); return reassignResult; } },
    ownershipMirror: { afterReassign: async (input) => { mirrorCalls.push(input); } },
    sessions: { afterRoleChange: async (c) => { sessionCalls.push(["role", c.userId, c.actorSessionId]); }, afterDeactivation: async (c) => { sessionCalls.push(["deactivated", c.userId]); } },
  });
  const actor = (role) => ({ organizationId: ORG, userId: ids[role], roles: [role === "admin" ? "organization_admin" : role === "manager" ? "team_manager" : role], correlationId: "c" });
  return { store, events, members, actor, sessionCalls, reassignCalls, mirrorCalls, setReassignResult: (r) => { reassignResult = r; } };
};

test("role changes follow the Owner and RFP-ownership rules for every actor", () => {
  const owner = { userId: ids.owner, roles: ["owner"] };
  const admin = { userId: ids.admin, roles: ["organization_admin"] };
  const member = (userId, role) => ({ userId, roles: [role], status: "active" });
  const decide = (actor, target, role, ownedRfpCount = 0) => {
    const decision = policy.decideRoleChange({ actor, target, role, ownedRfpCount });
    return decision.ok ? "ok" : decision.code;
  };
  assert.equal(decide(admin, member(ids.planner, "planner"), "team_manager"), "ok");
  assert.equal(decide(admin, member(ids.manager, "organization_admin"), "planner"), "ok");
  assert.equal(decide(admin, member(ids.owner, "owner"), "planner"), "OWNER_ONLY");
  assert.equal(decide(admin, member(ids.planner, "planner"), "owner"), "OWNER_ONLY");
  assert.equal(decide(owner, member(ids.owner, "owner"), "organization_admin"), "LAST_OWNER");
  assert.equal(decide(owner, member(ids.planner, "planner"), "owner"), "OWNERSHIP_TRANSFER_REQUIRED");
  assert.equal(decide(admin, member(ids.planner, "planner"), "viewer", 2), "OWNER_HAS_RFPS");
  assert.equal(decide(admin, { ...member(ids.planner, "planner"), status: "removed" }, "viewer"), "MEMBER_REMOVED");

  for (const roles of [["planner"], ["team_manager"], ["viewer"], []]) {
    assert.equal(policy.decideManage({ userId: ids.planner, roles }).ok, false, roles.join());
  }
  assert.equal(policy.decideManage(owner).ok, true);
  assert.equal(policy.decideManage(admin).ok, true);
});

test("deactivation refuses the Owner and members who still own RFPs", () => {
  const owner = { userId: ids.owner, roles: ["owner"] };
  const admin = { userId: ids.admin, roles: ["organization_admin"] };
  const ownerTarget = { userId: ids.owner, roles: ["owner"], status: "active" };
  const decide = (actor, target, ownedRfpCount = 0) => {
    const decision = policy.decideDeactivation({ actor, target, ownedRfpCount });
    return decision.ok ? "ok" : decision.code;
  };
  assert.equal(decide(owner, ownerTarget), "LAST_OWNER");
  assert.equal(decide(admin, ownerTarget), "OWNER_ONLY");
  assert.equal(decide(admin, { userId: ids.planner, roles: ["planner"], status: "active" }, 3), "OWNER_HAS_RFPS");
  assert.equal(decide(admin, { userId: ids.planner, roles: ["planner"], status: "active" }), "ok");
  assert.deepEqual(policy.ownerHasRfps(3).details, { ownedRfpCount: 3 });
});

test("a role change keeps knowledge roles and replaces only the customer role", () => {
  assert.deepEqual(policy.withCustomerRole(["team_manager", "knowledge_editor"], "planner"), ["planner", "knowledge_editor"]);
  assert.equal(policy.customerRole(["knowledge_editor", "viewer"]), "viewer");
});

test("listing shows role, teams, status and last login; Planners and Viewers are refused", async () => {
  const { members, actor, store } = setup();
  store.rows.get(ids.viewer).status = "suspended";
  store.rows.get(ids.owner).lastSignedInAt = new Date("2026-11-01T10:00:00Z");
  const listed = await members.list(actor("admin"));
  assert.equal(listed.ok, true);
  assert.equal(listed.members.length, 5);
  const planner = listed.members.find((m) => m.userId === ids.planner);
  assert.deepEqual(planner.teams, [{ id: "t1", name: "East" }]);
  assert.equal(planner.role, "planner");
  assert.equal(listed.members.find((m) => m.userId === ids.viewer).status, "deactivated");
  assert.equal(listed.members.find((m) => m.userId === ids.owner).lastSignedInAt, "2026-11-01T10:00:00.000Z");

  assert.equal((await members.list(actor("admin"), { status: "deactivated" })).members.length, 1);
  assert.equal((await members.list(actor("admin"), { q: ids.planner.slice(0, 6) })).members[0].userId, ids.planner);
  for (const role of ["planner", "viewer", "manager"]) {
    const refused = await members.list(actor(role));
    assert.equal(refused.status, 403, role);
  }
});

test("a role change is optimistic on version and audited", async () => {
  const { members, actor, events, store } = setup();
  const changed = await members.changeRole(actor("admin"), { userId: ids.manager, role: "planner", version: 1 });
  assert.equal(changed.ok, true);
  assert.equal(changed.member.role, "planner");
  assert.deepEqual(store.rows.get(ids.manager).roles, ["planner", "knowledge_editor"]);
  assert.equal(changed.member.version, 2);
  assert.equal(events.at(-1).action, "organization.member.role_changed");
  assert.equal(events.at(-1).decision, "allowed");
  assert.deepEqual(events.at(-1).metadata, { previousRole: "team_manager", role: "planner", version: 2 });

  const staleResult = await members.changeRole(actor("admin"), { userId: ids.manager, role: "viewer", version: 1 });
  assert.equal(staleResult.status, 409);
  assert.equal(staleResult.code, "STALE_VERSION");
  assert.deepEqual(staleResult.details, { currentVersion: 2 });

  assert.equal((await members.changeRole(actor("admin"), { userId: ids.manager, role: "viewer" })).code, "VERSION_REQUIRED");
  assert.equal((await members.changeRole(actor("admin"), { userId: ids.manager, role: "dxg_admin", version: 2 })).code, "INVALID_ROLE");
  assert.equal((await members.changeRole(actor("admin"), { userId: "f".repeat(24), role: "viewer", version: 1 })).status, 404);
});

test("refusals are audited as denied", async () => {
  const { members, actor, events } = setup({ [ids.planner]: 2 });
  const refused = await members.changeRole(actor("planner"), { userId: ids.viewer, role: "planner", version: 1 });
  assert.equal(refused.status, 403);
  assert.equal(events.at(-1).decision, "denied");
  assert.equal(events.at(-1).reason, "forbidden");

  const ownerChange = await members.changeRole(actor("admin"), { userId: ids.owner, role: "planner", version: 1 });
  assert.equal(ownerChange.code, "OWNER_ONLY");
  const toViewer = await members.changeRole(actor("admin"), { userId: ids.planner, role: "viewer", version: 1 });
  assert.equal(toViewer.code, "OWNER_HAS_RFPS");
  assert.equal(toViewer.details.ownedRfpCount, 2);
  assert.deepEqual(events.slice(-2).map((e) => e.reason), ["owner_only", "owner_has_rfps"]);
});

test("deactivation and reactivation round-trip with version checks", async () => {
  const { members, actor, events } = setup({ [ids.manager]: 4 });
  const blocked = await members.deactivate(actor("admin"), { userId: ids.manager, version: 1 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.code, "OWNER_HAS_RFPS");
  assert.equal(blocked.details.ownedRfpCount, 4);

  const deactivated = await members.deactivate(actor("admin"), { userId: ids.planner, version: 1 });
  assert.equal(deactivated.member.status, "deactivated");
  assert.equal((await members.deactivate(actor("admin"), { userId: ids.planner, version: 1 })).code, "STALE_VERSION");
  const reactivated = await members.reactivate(actor("admin"), { userId: ids.planner, version: 2 });
  assert.equal(reactivated.member.status, "active");
  assert.equal(reactivated.member.version, 3);
  assert.deepEqual(events.filter((e) => e.decision === "allowed").map((e) => e.action), ["organization.member.deactivated", "organization.member.reactivated"]);

  const ownerSelf = await members.deactivate(actor("owner"), { userId: ids.owner, version: 1 });
  assert.equal(ownerSelf.code, "LAST_OWNER");
});

test("only the Owner transfers ownership, to another active member", () => {
  const owner = { userId: ids.owner, roles: ["owner"] };
  const admin = { userId: ids.admin, roles: ["organization_admin"] };
  const active = { userId: ids.planner, roles: ["planner"], status: "active" };
  const code = (d) => (d.ok ? "ok" : d.code);
  assert.equal(code(policy.decideOwnershipTransfer({ actor: owner, target: active })), "ok");
  assert.equal(code(policy.decideOwnershipTransfer({ actor: admin, target: active })), "OWNER_ONLY");
  assert.equal(code(policy.decideOwnershipTransfer({ actor: owner, target: null })), "MEMBER_NOT_FOUND");
  assert.equal(code(policy.decideOwnershipTransfer({ actor: owner, target: { ...owner, status: "active" } })), "ALREADY_OWNER");
  assert.equal(code(policy.decideOwnershipTransfer({ actor: owner, target: { ...active, status: "suspended" } })), "MEMBER_INACTIVE");
});

test("a transfer is audited and refusals are audited as denied", async () => {
  const { members, actor, events, store } = setup();
  store.transferOwnership = async ({ fromUserId, toUserId }) => {
    store.rows.get(fromUserId).roles = ["organization_admin"];
    store.rows.get(toUserId).roles = ["owner"];
    return { from: { ...store.rows.get(fromUserId) }, to: { ...store.rows.get(toUserId) } };
  };
  const refused = await members.transferOwnership(actor("admin"), { toUserId: ids.planner, version: 1 });
  assert.equal(refused.code, "OWNER_ONLY");
  assert.equal(events.at(-1).decision, "denied");
  assert.equal((await members.transferOwnership(actor("owner"), { toUserId: ids.planner, version: 9 })).code, "STALE_VERSION");

  const done = await members.transferOwnership(actor("owner"), { toUserId: ids.planner, version: 1 });
  assert.equal(done.ok, true);
  assert.equal(done.owner.role, "owner");
  assert.equal(done.previousOwner.role, "organization_admin");
  assert.equal(events.at(-1).action, "organization.ownership.transferred");
  assert.equal(events.at(-1).decision, "allowed");
  assert.equal(events.at(-1).metadata.previousOwnerUserId, ids.owner);
});

test("role changes, deactivations and transfers call the session hooks", async () => {
  const { members, actor, sessionCalls, store } = setup();
  await members.changeRole(actor("admin"), { userId: ids.planner, role: "team_manager", version: 1 });
  await members.deactivate(actor("admin"), { userId: ids.viewer, version: 1 });
  store.transferOwnership = async ({ fromUserId, toUserId }) => ({ from: { ...store.rows.get(fromUserId) }, to: { ...store.rows.get(toUserId) } });
  await members.transferOwnership({ ...actor("owner"), sessionId: "owner-session" }, { toUserId: ids.admin, version: 1 });
  assert.deepEqual(sessionCalls, [
    ["role", ids.planner, undefined],
    ["deactivated", ids.viewer],
    ["role", ids.owner, "owner-session"],
    ["role", ids.admin, "owner-session"],
  ]);
});

test("reassignment goes only to an active member who can own RFPs", () => {
  const code = (d) => (d.ok ? "ok" : d.code);
  const m = (userId, role, status = "active") => ({ userId, roles: [role], status });
  assert.equal(code(policy.decideReassignment({ from: m(ids.planner, "planner", "suspended"), to: m(ids.manager, "team_manager") })), "ok");
  assert.equal(code(policy.decideReassignment({ from: m(ids.planner, "planner"), to: m(ids.viewer, "viewer") })), "REASSIGN_TARGET_INELIGIBLE");
  assert.equal(code(policy.decideReassignment({ from: m(ids.planner, "planner"), to: m(ids.admin, "organization_admin", "suspended") })), "REASSIGN_TARGET_INELIGIBLE");
  assert.equal(code(policy.decideReassignment({ from: m(ids.planner, "planner"), to: m(ids.planner, "planner") })), "REASSIGN_TO_SELF");
  assert.equal(code(policy.decideReassignment({ from: null, to: m(ids.admin, "organization_admin") })), "MEMBER_NOT_FOUND");
});

test("reassignment writes one audit event per RFP and mirrors the new owner", async () => {
  const { members, actor, events, reassignCalls, mirrorCalls, setReassignResult } = setup();
  const done = await members.reassignRfps(actor("admin"), { fromUserId: ids.planner, toUserId: ids.manager });
  assert.equal(done.reassignedCount, 2);
  assert.equal(reassignCalls[0].rfpIds, null);
  const audits = events.filter((e) => e.action === "proposal.owner.reassigned");
  assert.deepEqual(audits.map((e) => [e.targetType, e.targetId, e.decision]), [["proposal", "b".repeat(24), "allowed"], ["proposal", "c".repeat(24), "allowed"]]);
  assert.deepEqual(audits[0].metadata, { fromUserId: ids.planner, toUserId: ids.manager });
  assert.deepEqual(mirrorCalls[0].rfpIds, ["b".repeat(24), "c".repeat(24)]);

  const selected = await members.reassignRfps(actor("admin"), { fromUserId: ids.planner, toUserId: ids.manager, rfpIds: ["b".repeat(24), "b".repeat(24)] });
  assert.equal(selected.ok, true);
  assert.deepEqual(reassignCalls[1].rfpIds, ["b".repeat(24)]);

  assert.equal((await members.reassignRfps(actor("admin"), { fromUserId: ids.planner, toUserId: ids.manager, rfpIds: ["bad"] })).code, "INVALID_RFP_SELECTION");
  assert.equal((await members.reassignRfps(actor("planner"), { fromUserId: ids.planner, toUserId: ids.manager })).status, 403);
  assert.equal((await members.reassignRfps(actor("admin"), { fromUserId: ids.planner, toUserId: ids.viewer })).code, "REASSIGN_TARGET_INELIGIBLE");

  setReassignResult({ notOwnedCount: 1 });
  const notOwned = await members.reassignRfps(actor("admin"), { fromUserId: ids.planner, toUserId: ids.manager, rfpIds: ["b".repeat(24)] });
  assert.equal(notOwned.code, "RFPS_NOT_OWNED_BY_MEMBER");
  setReassignResult("target_ineligible");
  assert.equal((await members.reassignRfps(actor("admin"), { fromUserId: ids.planner, toUserId: ids.manager })).code, "REASSIGN_TARGET_INELIGIBLE");
});
