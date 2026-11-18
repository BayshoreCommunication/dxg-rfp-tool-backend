require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createStaffMemberManagement, STAFF_REASON_MIN, STAFF_REASON_MAX } = require("../src/modules/staffAccess/application/manageOrganizationMembers");
const { StaffAccessError, StaffMemberError, STAFF_MEMBER_AUDIT } = require("../src/modules/staffAccess/domain");
const { createAdminOrganizationMembersController } = require("../controller/adminOrganizationMembersController");
const policy = require("../src/modules/organizationMembers/domain/memberPolicy");
const { createMembershipSessionHardening } = require("../src/modules/auth/application/membershipSessionHardening");
const { createAuditLog } = require("../src/modules/auditLog/application/readAuditLog");
const { AUDIT_CATALOG, AUDIT_CATEGORIES, AuditLogError, VISIBLE_ACTIONS, catalogEntry, isStaffOnlyAction } = require("../src/modules/auditLog/domain");

// Owner decision 2026-11-18 (docs/DECISIONS.md): RFPilot staff manage a customer organization's
// members under the customer's own rules; every request is recorded in the STAFF organization
// only. In-memory ports; the real-database proof is tests-integration/staff-member-management.test.ts.

const hex = (c) => c.repeat(24);
const ACME = hex("a");
const OTHER = hex("b");
const STAFF_ORG = hex("d");
const SECOND_STAFF_ORG = hex("e");
const HOLDING = hex("c");
const STAFF = hex("7");
const ids = { owner: hex("1"), admin: hex("2"), manager: hex("3"), planner: hex("4"), viewer: hex("5"), suspended: hex("6"), invited: hex("8"), removed: hex("9") };
const FOREIGN = hex("f"); // a member of OTHER
const REASON = "Customer asked us on the phone, ticket 4471";
const ACTIONS = Object.values(STAFF_MEMBER_AUDIT);

const staff = (overrides = {}) => ({ adminId: STAFF, organizationId: STAFF_ORG, role: "admin", accountType: "admin", correlationId: "corr-staff", ...overrides });
const customerOwner = () => staff({ adminId: ids.owner, organizationId: ACME, role: "customer", accountType: "planner" });
const usersAccountWithStaffRole = () => staff({ adminId: ids.planner, accountType: "planner", role: "super_admin" });

// What a careless directory could hand back. None of it may reach a response.
const SECRETS = { password: "$2a$10$hashhashhash", twoFactorSecret: "JBSWY3DPEHPK3PXP", recoveryCodes: ["aaaa-bbbb"], tokenHash: "deadbeefcafe", refreshToken: "rt_live_abc", googleId: "google-oauth-subject", sessionRevocationClaim: { sessionId: "sess-live-1" }, __v: 3 };
const SECRET_VALUES = ["$2a$10$", "JBSWY3DPEHPK3PXP", "aaaa-bbbb", "deadbeefcafe", "rt_live_abc", "google-oauth-subject", "sess-live-1"];
const noSecrets = (value, label) => {
  const json = JSON.stringify(value);
  for (const secret of SECRET_VALUES) assert.equal(json.includes(secret), false, `${label}: ${secret}`);
  for (const key of Object.keys(SECRETS)) assert.equal(json.includes(`"${key}"`), false, `${label}: key ${key}`);
};

const setup = (options = {}) => {
  const audit = []; // every event written anywhere, with the organization it was written in
  const state = { failAudit: false, failStoreAudit: false, ownedAtCommit: null, revertAfterCommit: null, transferOutcome: null, reassignResult: null };
  const calls = [];
  const owned = { ...(options.owned ?? {}) };
  const row = (organizationId, userId, roles, status = "active") => ({ organizationId, membershipId: `m-${userId}`, userId, name: `Name ${userId[0]}`, email: `${userId[0]}@example.test`, roles, status, version: 1, lastSignedInAt: null, createdAt: new Date("2026-10-01T00:00:00Z") });
  const rows = [
    row(ACME, ids.owner, ["owner"]), row(ACME, ids.admin, ["organization_admin"]), row(ACME, ids.manager, ["team_manager", "knowledge_editor"]),
    row(ACME, ids.planner, ["planner"]), row(ACME, ids.viewer, ["viewer"]), row(ACME, ids.suspended, ["planner"], "suspended"),
    row(ACME, ids.invited, ["planner"], "invited"), row(ACME, ids.removed, ["planner"], "removed"),
    row(OTHER, FOREIGN, ["planner"]), row(OTHER, hex("0"), ["owner"]),
    row(STAFF_ORG, ids.planner, ["planner"]), row(SECOND_STAFF_ORG, ids.planner, ["planner"]), row(HOLDING, ids.planner, ["planner"]),
  ];
  const get = (organizationId, userId) => rows.find((r) => r.organizationId === organizationId && r.userId === userId) ?? null;
  const record = (r) => { const { organizationId: _o, ...rest } = r; return { ...rest, roles: [...rest.roles] }; };
  // The store commits the change and its audit event together, or neither (the Mongo store does
  // this in one transaction; tests-integration proves it against a real database).
  const commit = (r, version, patch, event, extra = {}) => {
    if (!r || r.version !== version) return "stale";
    if (state.failStoreAudit) throw new Error("audit store down");
    Object.assign(r, patch, { version: r.version + 1 });
    if (event) audit.push({ ...event, decision: "allowed", metadata: { ...event.metadata, ...extra } });
    return record(r);
  };
  const store = {
    async list() { throw new Error("the staff service never lists members through the store"); },
    async find(organizationId, userId) { calls.push(["find", organizationId, userId]); const r = get(organizationId, userId); return r ? record(r) : null; },
    async countOwnedRfps(organizationId, userId) { calls.push(["countOwnedRfps", organizationId, userId]); return owned[userId] ?? 0; },
    async setRoles(input) {
      calls.push(["setRoles", input]);
      if (state.ownedAtCommit) return { ownedRfpCount: state.ownedAtCommit };
      return commit(get(input.organizationId, input.userId), input.expectedVersion, { roles: input.roles }, input.audit);
    },
    async deactivate(input) {
      calls.push(["deactivate", input]);
      if (state.ownedAtCommit) return { ownedRfpCount: state.ownedAtCommit };
      const r = get(input.organizationId, input.userId);
      const result = commit(r, input.expectedVersion, { status: "suspended" }, input.audit);
      if (result !== "stale" && state.revertAfterCommit) { Object.assign(r, { status: "active", version: r.version + 1 }); return { ownedRfpCount: state.revertAfterCommit, reverted: true }; }
      return result;
    },
    async reactivate(input) { calls.push(["reactivate", input]); return commit(get(input.organizationId, input.userId), input.expectedVersion, { status: "active" }, input.audit); },
    async bumpVersion() { throw new Error("teams are not managed by staff"); },
    async activeOwner(organizationId) { calls.push(["activeOwner", organizationId]); const r = rows.find((m) => m.organizationId === organizationId && m.status === "active" && m.roles.includes("owner")); return r ? record(r) : null; },
    async transferOwnership(input) {
      calls.push(["transferOwnership", input]);
      if (state.transferOutcome) return state.transferOutcome;
      const from = get(input.organizationId, input.fromUserId);
      const to = get(input.organizationId, input.toUserId);
      if (!from || !from.roles.includes("owner") || from.status !== "active") return "not_owner";
      if (!to || to.status !== "active" || to.version !== input.expectedTargetVersion) return "stale";
      if (state.failStoreAudit) throw new Error("audit store down");
      Object.assign(from, { roles: policy.withCustomerRole(from.roles, "organization_admin"), version: from.version + 1 });
      Object.assign(to, { roles: policy.withCustomerRole(to.roles, "owner"), version: to.version + 1 });
      audit.push({ ...input.audit, decision: "allowed" });
      return { from: record(from), to: record(to) };
    },
  };
  const reassignments = {
    async reassign(input) {
      calls.push(["reassign", input]);
      const result = state.reassignResult ?? { rfpIds: input.rfpIds ?? [hex("b"), hex("c")] };
      if (result !== "target_ineligible" && "rfpIds" in result) {
        if (state.failStoreAudit) throw new Error("audit store down");
        audit.push({ ...input.audit, decision: "allowed", metadata: { ...input.audit.metadata, reassignedCount: result.rfpIds.length, rfpIds: result.rfpIds } });
      }
      return result;
    },
  };
  const standing = {
    [ACME]: { kind: "customer", staffAccountCount: 0 }, [OTHER]: { kind: "customer", staffAccountCount: 0 },
    [STAFF_ORG]: { kind: "customer", staffAccountCount: 3 }, [SECOND_STAFF_ORG]: { kind: "customer", staffAccountCount: 1 },
    [HOLDING]: { kind: "legacy_holding", staffAccountCount: 0 },
  };
  const directory = {
    async organization(id) { calls.push(["organization", id]); return standing[id] ? { id, ...standing[id], ...SECRETS } : null; },
    async member(organizationId, userId) {
      calls.push(["member", organizationId, userId]);
      const r = get(organizationId, userId);
      if (!r) return null;
      return {
        member: { userId: r.userId, name: r.name, email: r.email, roles: [...r.roles], status: r.status, teams: [{ id: hex("8"), name: "West", archived: false, isManager: false, ...SECRETS }], joinedAt: r.createdAt, lastSignedInAt: null, version: r.version, ...SECRETS },
        version: r.version,
      };
    },
  };
  const sessionCalls = [];
  const mirrorCalls = [];
  const members = createStaffMemberManagement({
    directory, store, reassignments,
    ownershipMirror: { async afterReassign(input) { mirrorCalls.push(input); } },
    sessions: {
      async afterRoleChange(change) { sessionCalls.push(["role", change.userId, change.organizationId, change.actorUserId, ...(change.demoted ? ["demoted"] : [])]); },
      async afterDeactivation(change) { sessionCalls.push(["deactivated", change.userId, change.organizationId, change.actorUserId]); },
    },
    audit: { async append(event) { if (state.failAudit) throw new Error("audit store down"); audit.push(event); } },
  });
  const writes = () => calls.filter(([name]) => ["setRoles", "deactivate", "reactivate", "transferOwnership", "reassign"].includes(name));
  return { members, audit, state, calls, rows, get, sessionCalls, mirrorCalls, writes };
};

const refusedWith = (status, code) => (error) => {
  assert.ok(error instanceof StaffMemberError, `${code}: ${error && error.message}`);
  assert.equal(error.status, status, code);
  assert.equal(error.code, code);
  return true;
};

// Exactly one event, in the staff organization, naming the customer organization and member.
const oneStaffEvent = (audit, expected) => {
  assert.equal(audit.length, 1, JSON.stringify(audit.map((e) => [e.action, e.decision, e.reason])));
  const [event] = audit;
  assert.equal(event.organizationId, STAFF_ORG);
  assert.equal(event.actorUserId, STAFF);
  assert.equal(event.targetType, "organization_membership");
  assert.equal(event.correlationId, "corr-staff");
  assert.equal(event.metadata.agentAccountType, "admin");
  assert.match(event.action, /^platform\.organization_member\./);
  for (const [key, value] of Object.entries(expected)) {
    if (key === "metadata") for (const [k, v] of Object.entries(value)) assert.deepEqual(event.metadata[k], v, `metadata.${k}`);
    else assert.deepEqual(event[key], value, key);
  }
  return event;
};

// Every write, with a valid body for the planner in Acme. `member` is who the request names.
const WRITES = [
  ["changeRole", STAFF_MEMBER_AUDIT.roleChanged, (m, s, org = ACME, user = ids.planner, body = {}) => m.changeRole(s, org, user, { role: "team_manager", version: 1, reason: REASON, ...body })],
  ["deactivate", STAFF_MEMBER_AUDIT.deactivated, (m, s, org = ACME, user = ids.planner, body = {}) => m.deactivate(s, org, user, { version: 1, reason: REASON, ...body })],
  ["reactivate", STAFF_MEMBER_AUDIT.reactivated, (m, s, org = ACME, user = ids.suspended, body = {}) => m.reactivate(s, org, user, { version: 1, reason: REASON, ...body })],
  ["reassignRfps", STAFF_MEMBER_AUDIT.proposalsReassigned, (m, s, org = ACME, user = ids.planner, body = {}) => m.reassignRfps(s, org, user, { toUserId: ids.manager, reason: REASON, ...body })],
  ["transferOwnership", STAFF_MEMBER_AUDIT.ownershipTransferred, (m, s, org = ACME, user = ids.admin, body = {}) => m.transferOwnership(s, org, { toUserId: user, version: 1, reason: REASON, ...body })],
];
const ALL = [...WRITES, ["member", STAFF_MEMBER_AUDIT.read, (m, s, org = ACME, user = ids.planner) => m.member(s, org, user)]];

// ── Who ──────────────────────────────────────────────────────────────────────────────────────

test("only an `admins` account with an admin role passes: a customer session and a `users` account holding a staff role are refused, and nothing is read, written or recorded", async () => {
  for (const [name, , run] of ALL) {
    for (const caller of [customerOwner(), usersAccountWithStaffRole(), staff({ role: "planner" }), staff({ accountType: undefined })]) {
      const { members, audit, calls } = setup();
      await assert.rejects(run(members, caller), (error) => error instanceof StaffAccessError && !(error instanceof StaffMemberError) && error.status === 403 && error.code === "STAFF_ACCESS_FORBIDDEN", name);
      assert.deepEqual(calls, [], name);
      assert.deepEqual(audit, [], name);
    }
    const { members, audit, calls } = setup();
    await assert.rejects(run(members, staff({ organizationId: "" })), (error) => error.status === 401, name);
    assert.deepEqual([calls, audit], [[], []]);
  }
  for (const role of ["admin", "super_admin", "superadmin", "Super Admin"]) {
    const { members } = setup();
    assert.equal((await members.member(staff({ role }), ACME, ids.planner)).organizationId, ACME, role);
  }
  // The existing staff-account helper, not a variant of its own.
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/staffAccess/application/manageOrganizationMembers.ts"), "utf8");
  assert.match(source, /if \(!isPlanStaff\(staff\)\) throw new StaffAccessError\("STAFF_ACCESS_FORBIDDEN"/);
  assert.doesNotMatch(source, /STAFF_ROLES|accountType ===/);
});

// ── Ids, reason ──────────────────────────────────────────────────────────────────────────────

test("ids must be 24 lower-case hex characters: a malformed organization, member or target id is a 400, looks nothing up, and is recorded once as denied", async () => {
  const bad = ["", "not-an-id", "A".repeat(24), hex("a").slice(1), `${hex("a")}0`, "aaaaaaaaaaaaaaaaaaaaaaa$", { $ne: null }, null];
  for (const [name, action, run] of ALL) {
    for (const value of bad) {
      const forOrganization = setup();
      await assert.rejects(run(forOrganization.members, staff(), value), refusedWith(400, "INVALID_ORGANIZATION_ID"), `${name} org ${JSON.stringify(value)}`);
      assert.deepEqual(forOrganization.calls, []);
      const event = oneStaffEvent(forOrganization.audit, { action, decision: "denied", reason: "invalid_organization_id" });
      assert.equal("targetId" in event && !/^[a-f0-9]{24}$/.test(event.targetId), false);

      const forMember = setup();
      await assert.rejects(run(forMember.members, staff(), ACME, value), refusedWith(400, name === "transferOwnership" ? "MEMBER_REQUIRED" : "INVALID_MEMBER_ID"), `${name} member ${JSON.stringify(value)}`);
      assert.deepEqual(forMember.calls, []);
      const denied = oneStaffEvent(forMember.audit, { action, decision: "denied" });
      assert.equal("targetId" in denied, false, "a malformed id is never stored as the target");
      assert.equal(denied.metadata.organizationId, ACME);
    }
  }
  for (const value of bad) {
    const { members, audit, writes } = setup();
    await assert.rejects(members.reassignRfps(staff(), ACME, ids.planner, { toUserId: value, reason: REASON }), refusedWith(400, "REASSIGN_TARGET_REQUIRED"));
    assert.deepEqual(writes(), []);
    oneStaffEvent(audit, { decision: "denied", reason: "reassign_target_required", targetId: ids.planner });
  }
  for (const rfpIds of [[], ["nope"], [hex("A")], "some", 5, Array.from({ length: 1001 }, (_, i) => i.toString(16).padStart(24, "0"))]) {
    const { members, audit, writes } = setup();
    await assert.rejects(members.reassignRfps(staff(), ACME, ids.planner, { toUserId: ids.manager, rfpIds, reason: REASON }), refusedWith(400, "INVALID_RFP_SELECTION"));
    assert.deepEqual(writes(), []);
    oneStaffEvent(audit, { decision: "denied", reason: "invalid_rfp_selection" });
  }
});

test("reason is required on every write: trimmed, 10 to 500 characters, else 400 with a field error and nothing looked up", async () => {
  assert.deepEqual([STAFF_REASON_MIN, STAFF_REASON_MAX], [10, 500]);
  for (const [name, action, run] of WRITES) {
    for (const reason of [undefined, null, "", "   ", "too short", `  ${"x".repeat(9)}  `, "x".repeat(501), 1234567890, ["a reason in a list"], { text: REASON }]) {
      const { members, audit, calls } = setup();
      await assert.rejects(run(members, staff(), undefined, undefined, { reason }), (error) => {
        refusedWith(400, "INVALID_REASON")(error);
        assert.deepEqual(error.details, { fields: { reason: "Give a reason of 10 to 500 characters." } });
        return true;
      }, `${name} ${JSON.stringify(reason)}`);
      assert.deepEqual(calls, [], name);
      const event = oneStaffEvent(audit, { action, decision: "denied", reason: "invalid_reason" });
      assert.equal("staffReason" in event.metadata, false);
      assert.equal("fields" in event.metadata, false);
    }
    for (const reason of ["x".repeat(10), "x".repeat(500), `   ${"y".repeat(500)}   `, `  ${REASON}\n`]) {
      const { members, audit } = setup();
      await run(members, staff(), undefined, undefined, { reason });
      oneStaffEvent(audit, { action, decision: "allowed", metadata: { staffReason: reason.trim() } });
    }
  }
});

test("the reason is stored on the staff-side event only: never in an answer, never in the event's machine-readable reason", async () => {
  for (const [name, , run] of WRITES) {
    const { members, audit } = setup();
    const answer = await run(members, staff());
    assert.equal(JSON.stringify(answer).includes(REASON), false, name);
    assert.equal(audit[0].metadata.staffReason, REASON);
    assert.match(audit[0].reason, /^[a-z_]+$/);
  }
});

// ── Organizations ────────────────────────────────────────────────────────────────────────────

test("an unknown organization is 404; RFPilot's own organization, any organization holding `admins` accounts, and a legacy holding tenant are 409 ORGANIZATION_NOT_MANAGEABLE; none is changed", async () => {
  for (const [name, action, run] of ALL) {
    const unknown = setup();
    await assert.rejects(run(unknown.members, staff(), hex("0")), refusedWith(404, "ORGANIZATION_NOT_FOUND"), name);
    assert.deepEqual(unknown.calls, [["organization", hex("0")]]);
    oneStaffEvent(unknown.audit, { action, decision: "denied", reason: "organization_not_found", metadata: { organizationId: hex("0") } });

    for (const [organization, standing] of [[STAFF_ORG, "platform"], [SECOND_STAFF_ORG, "platform"], [HOLDING, "legacy_holding"]]) {
      const { members, audit, calls, rows } = setup();
      const before = JSON.stringify(rows);
      await assert.rejects(run(members, staff(), organization, ids.planner), refusedWith(409, "ORGANIZATION_NOT_MANAGEABLE"), `${name} ${organization}`);
      assert.deepEqual(calls, [["organization", organization]], "refused before any member is read");
      assert.equal(JSON.stringify(rows), before);
      oneStaffEvent(audit, { action, decision: "denied", reason: "organization_not_manageable", metadata: { organizationId: organization, standing } });
    }
    // The caller's own organization is refused even if no `admins` count came back for it.
    const own = setup();
    await assert.rejects(run(own.members, staff({ organizationId: ACME }), ACME), refusedWith(409, "ORGANIZATION_NOT_MANAGEABLE"), name);
    assert.equal(own.audit[0].organizationId, ACME, "the staff member's own organization receives the event");
  }
});

test("tenant scope: every store and directory call names the path's organization and the member; the session's organization is never used", async () => {
  for (const [name, , run] of ALL) {
    const { members, calls } = setup();
    await run(members, staff());
    for (const call of calls) {
      const organizationId = typeof call[1] === "string" ? call[1] : call[1].organizationId;
      assert.equal(organizationId, ACME, `${name} ${call[0]}`);
      assert.equal(JSON.stringify(call).includes(STAFF_ORG), call[0] !== "organization" && typeof call[1] !== "string", `${name} ${call[0]}: only the audit event names the staff organization`);
    }
  }
});

test("a member of another organization is 404 on every route, the same answer as a member that doesn't exist, and nothing is written in either organization", async () => {
  for (const [name, action, run] of ALL) {
    for (const user of [FOREIGN, hex("0")]) {
      const { members, audit, rows, writes, sessionCalls } = setup();
      const before = JSON.stringify(rows);
      await assert.rejects(run(members, staff(), ACME, user), refusedWith(404, "MEMBER_NOT_FOUND"), `${name} ${user}`);
      assert.deepEqual(writes(), [], name);
      assert.equal(JSON.stringify(rows), before);
      assert.deepEqual(sessionCalls, []);
      oneStaffEvent(audit, { action, decision: "denied", reason: "member_not_found", targetId: user, metadata: { organizationId: ACME, memberUserId: user } });
    }
  }
  // The reassignment target must be a member of the same organization.
  const { members, audit, writes } = setup();
  await assert.rejects(members.reassignRfps(staff(), ACME, ids.planner, { toUserId: FOREIGN, reason: REASON }), refusedWith(404, "REASSIGN_TARGET_NOT_FOUND"));
  assert.deepEqual(writes(), []);
  oneStaffEvent(audit, { decision: "denied", reason: "reassign_target_not_found" });
});

// ── Role ─────────────────────────────────────────────────────────────────────────────────────

test("role change: applies the customer's rule, records before and after once in the staff organization, and ends the member's sessions as the customer flow does", async () => {
  const { members, audit, get, sessionCalls, calls } = setup();
  const promoted = await members.changeRole(staff(), ACME, ids.planner, { role: "team_manager", version: 1, reason: REASON });
  assert.deepEqual([promoted.organizationId, promoted.changed, promoted.version, promoted.member.roles], [ACME, true, 2, ["team_manager"]]);
  assert.deepEqual(get(ACME, ids.planner).roles, ["team_manager"]);
  oneStaffEvent(audit, {
    action: "platform.organization_member.role_changed", decision: "allowed", reason: "role_changed", targetId: ids.planner,
    metadata: {
      organizationId: ACME, memberUserId: ids.planner, changed: true, staffReason: REASON, sessions: "revoked_on_next_request",
      before: { role: "planner", roles: ["planner"], status: "active" }, after: { role: "team_manager", roles: ["team_manager"], status: "active" },
    },
  });
  // The event travelled with the write: the service appended nothing itself.
  assert.equal(calls.find(([n]) => n === "setRoles")[1].audit.organizationId, STAFF_ORG);
  assert.deepEqual(sessionCalls, [["role", ids.planner, ACME, STAFF]]);

  // A demotion ends every session now; knowledge roles are kept, as in the customer flow.
  const demotion = setup();
  const demoted = await demotion.members.changeRole(staff(), ACME, ids.manager, { role: "viewer", version: 1, reason: REASON });
  assert.deepEqual(demoted.member.roles, ["viewer", "knowledge_editor"]);
  assert.deepEqual(demotion.sessionCalls, [["role", ids.manager, ACME, STAFF, "demoted"]]);
  assert.equal(demotion.audit[0].metadata.sessions, "revoked");
});

test("role change never moves a member to or from Owner: `owner` as the new role and the Owner as the member are both refused, for every role", async () => {
  for (const member of ["admin", "manager", "planner", "viewer", "suspended"]) {
    const { members, audit, writes, get } = setup();
    await assert.rejects(members.changeRole(staff(), ACME, ids[member], { role: "owner", version: 1, reason: REASON }), refusedWith(409, "OWNERSHIP_TRANSFER_REQUIRED"), member);
    assert.deepEqual(writes(), []);
    assert.equal(get(ACME, ids[member]).roles.includes("owner"), false);
    oneStaffEvent(audit, { decision: "denied", reason: "ownership_transfer_required", targetId: ids[member] });
  }
  for (const role of ["owner", "organization_admin", "team_manager", "planner", "viewer"]) {
    const { members, audit, writes, get, sessionCalls } = setup();
    await assert.rejects(members.changeRole(staff(), ACME, ids.owner, { role, version: 1, reason: REASON }), refusedWith(409, "OWNERSHIP_TRANSFER_REQUIRED"), role);
    assert.deepEqual(writes(), []);
    assert.deepEqual(get(ACME, ids.owner).roles, ["owner"]);
    assert.deepEqual(sessionCalls, []);
    oneStaffEvent(audit, { decision: "denied", reason: "ownership_transfer_required", targetId: ids.owner });
  }
});

test("role change refusals: INVALID_ROLE, VERSION_REQUIRED, STALE_VERSION, MEMBER_REMOVED, OWNER_HAS_RFPS (before the write and when it commits); each recorded once, nothing changed", async () => {
  for (const role of [undefined, "", "dxg_admin", "super_admin", "knowledge_approver", "Owner", ["planner"]]) {
    const { members, audit, calls } = setup();
    await assert.rejects(members.changeRole(staff(), ACME, ids.planner, { role, version: 1, reason: REASON }), refusedWith(400, "INVALID_ROLE"), String(role));
    assert.deepEqual(calls, []);
    oneStaffEvent(audit, { decision: "denied", reason: "invalid_role" });
  }
  for (const version of [undefined, null, 0, -1, 1.5, "1"]) {
    const { members, audit, calls } = setup();
    await assert.rejects(members.changeRole(staff(), ACME, ids.planner, { role: "viewer", version, reason: REASON }), refusedWith(400, "VERSION_REQUIRED"));
    assert.deepEqual(calls, []);
    oneStaffEvent(audit, { decision: "denied", reason: "version_required" });
  }
  const staleRead = setup();
  await assert.rejects(staleRead.members.changeRole(staff(), ACME, ids.planner, { role: "viewer", version: 7, reason: REASON }), (error) => refusedWith(409, "STALE_VERSION")(error) && error.details.currentVersion === 1);
  assert.deepEqual(staleRead.writes(), []);
  oneStaffEvent(staleRead.audit, { decision: "denied", reason: "stale_version", metadata: { currentVersion: 1, staffReason: REASON } });

  const owning = setup({ owned: { [ids.planner]: 2 } });
  await assert.rejects(owning.members.changeRole(staff(), ACME, ids.planner, { role: "viewer", version: 1, reason: REASON }), (error) => refusedWith(409, "OWNER_HAS_RFPS")(error) && error.details.ownedRfpCount === 2 && /2 proposals/.test(error.message));
  assert.deepEqual(owning.writes(), []);
  oneStaffEvent(owning.audit, { decision: "denied", reason: "owner_has_rfps", metadata: { ownedRfpCount: 2 } });

  const atCommit = setup();
  atCommit.state.ownedAtCommit = 1;
  await assert.rejects(atCommit.members.changeRole(staff(), ACME, ids.planner, { role: "viewer", version: 1, reason: REASON }), refusedWith(409, "OWNER_HAS_RFPS"));
  assert.deepEqual(atCommit.get(ACME, ids.planner).roles, ["planner"]);
  assert.deepEqual(atCommit.sessionCalls, []);
  oneStaffEvent(atCommit.audit, { decision: "denied", reason: "owner_has_rfps" });

  const removed = setup();
  await assert.rejects(removed.members.changeRole(staff(), ACME, ids.removed, { role: "viewer", version: 1, reason: REASON }), refusedWith(409, "MEMBER_REMOVED"));
  oneStaffEvent(removed.audit, { decision: "denied", reason: "member_removed" });
});

test("a version that moves between the read and the write is 409 STALE_VERSION with the current version, on every versioned write", async () => {
  const cases = [
    ["changeRole", (m) => m.changeRole(staff(), ACME, ids.planner, { role: "viewer", version: 1, reason: REASON }), ids.planner, "countOwnedRfps"],
    ["deactivate", (m) => m.deactivate(staff(), ACME, ids.planner, { version: 1, reason: REASON }), ids.planner, "countOwnedRfps"],
    ["reactivate", (m) => m.reactivate(staff(), ACME, ids.suspended, { version: 1, reason: REASON }), ids.suspended, "find"],
    ["transferOwnership", (m) => m.transferOwnership(staff(), ACME, { toUserId: ids.admin, version: 1, reason: REASON }), ids.admin, "activeOwner"],
  ];
  for (const [name, run, user, hook] of cases) {
    const context = setup();
    // Someone else changes the member after the service's read of it.
    const push = context.calls.push.bind(context.calls);
    let moved = false;
    context.calls.push = (call) => {
      if (!moved && call[0] === hook) { moved = true; queueMicrotask(() => { context.get(ACME, user).version = 5; }); }
      return push(call);
    };
    await assert.rejects(run(context.members), (error) => refusedWith(409, "STALE_VERSION")(error) && error.details.currentVersion === 5, name);
    assert.equal(context.writes().length, 1, `${name}: the write was attempted and lost`);
    assert.deepEqual(context.sessionCalls, [], name);
    oneStaffEvent(context.audit, { decision: "denied", reason: "stale_version", metadata: { currentVersion: 5 } });
  }
  // And a version that is already stale when read, without attempting the write.
  for (const [name, , run] of WRITES.filter(([n]) => n !== "reassignRfps")) {
    const { members, audit, writes } = setup();
    await assert.rejects(run(members, staff(), undefined, undefined, { version: 9 }), refusedWith(409, "STALE_VERSION"), name);
    assert.deepEqual(writes(), [], name);
    oneStaffEvent(audit, { decision: "denied", reason: "stale_version" });
  }
});

test("a request that finds nothing to change writes nothing to the member and still leaves one allowed event (changed: false)", async () => {
  const cases = [
    ["role_unchanged", (m) => m.changeRole(staff(), ACME, ids.planner, { role: "planner", version: 1, reason: REASON }), ids.planner],
    ["member_already_deactivated", (m) => m.deactivate(staff(), ACME, ids.suspended, { version: 1, reason: REASON }), ids.suspended],
    ["member_already_active", (m) => m.reactivate(staff(), ACME, ids.planner, { version: 1, reason: REASON }), ids.planner],
  ];
  for (const [reason, run, user] of cases) {
    const { members, audit, writes, sessionCalls, get } = setup();
    const answer = await run(members);
    assert.deepEqual([answer.changed, answer.version], [false, 1], reason);
    assert.deepEqual(writes(), []);
    assert.deepEqual(sessionCalls, []);
    assert.equal(get(ACME, user).version, 1);
    oneStaffEvent(audit, { decision: "allowed", reason, targetId: user, metadata: { changed: false, staffReason: REASON } });
    // That event is awaited: if it can't be written the request fails.
    const failing = setup();
    failing.state.failAudit = true;
    await assert.rejects(run(failing.members), /audit store down/, reason);
  }
});

// ── Deactivate, reactivate ───────────────────────────────────────────────────────────────────

test("deactivate: suspends the member, ends every session, one event; the Owner is refused (LAST_OWNER) and so is a member who still owns proposals", async () => {
  const { members, audit, get, sessionCalls } = setup();
  const answer = await members.deactivate(staff(), ACME, ids.planner, { version: 1, reason: REASON });
  assert.deepEqual([answer.changed, answer.member.status, answer.version], [true, "suspended", 2]);
  assert.equal(get(ACME, ids.planner).status, "suspended");
  assert.deepEqual(sessionCalls, [["deactivated", ids.planner, ACME, STAFF]]);
  oneStaffEvent(audit, {
    action: "platform.organization_member.deactivated", decision: "allowed", reason: "member_deactivated", targetId: ids.planner,
    metadata: { changed: true, sessions: "revoked", before: { role: "planner", roles: ["planner"], status: "active" }, after: { role: "planner", roles: ["planner"], status: "suspended" } },
  });

  const owner = setup();
  await assert.rejects(owner.members.deactivate(staff(), ACME, ids.owner, { version: 1, reason: REASON }), (error) => refusedWith(409, "LAST_OWNER")(error) && /Transfer ownership/.test(error.message));
  assert.deepEqual(owner.writes(), []);
  assert.equal(owner.get(ACME, ids.owner).status, "active");
  assert.deepEqual(owner.sessionCalls, []);
  oneStaffEvent(owner.audit, { decision: "denied", reason: "last_owner", targetId: ids.owner });

  const owning = setup({ owned: { [ids.planner]: 1 } });
  await assert.rejects(owning.members.deactivate(staff(), ACME, ids.planner, { version: 1, reason: REASON }), (error) => refusedWith(409, "OWNER_HAS_RFPS")(error) && /1 proposal\./.test(error.message));
  assert.deepEqual(owning.writes(), []);
  oneStaffEvent(owning.audit, { decision: "denied", reason: "owner_has_rfps", metadata: { ownedRfpCount: 1 } });

  // The store's own check, in the transaction of the write.
  const atCommit = setup();
  atCommit.state.ownedAtCommit = 3;
  await assert.rejects(atCommit.members.deactivate(staff(), ACME, ids.planner, { version: 1, reason: REASON }), refusedWith(409, "OWNER_HAS_RFPS"));
  assert.equal(atCommit.get(ACME, ids.planner).status, "active");
  assert.deepEqual(atCommit.sessionCalls, []);
  oneStaffEvent(atCommit.audit, { decision: "denied", reason: "owner_has_rfps", metadata: { ownedRfpCount: 3 } });

  const removed = setup();
  await assert.rejects(removed.members.deactivate(staff(), ACME, ids.removed, { version: 1, reason: REASON }), refusedWith(409, "MEMBER_REMOVED"));
  oneStaffEvent(removed.audit, { decision: "denied", reason: "member_removed" });
});

test("deactivate put back after it committed (a proposal created meanwhile): refused, sessions kept, and the staff trail holds the allowed event followed by a denied one marked reverted", async () => {
  const { members, audit, state, get, sessionCalls } = setup();
  state.revertAfterCommit = 1;
  await assert.rejects(members.deactivate(staff(), ACME, ids.planner, { version: 1, reason: REASON }), (error) => refusedWith(409, "OWNER_HAS_RFPS")(error) && error.details.reverted === true);
  assert.equal(get(ACME, ids.planner).status, "active");
  assert.deepEqual(sessionCalls, []);
  assert.deepEqual(audit.map((e) => [e.organizationId, e.action, e.decision, e.reason, e.metadata.reverted]), [
    [STAFF_ORG, "platform.organization_member.deactivated", "allowed", "member_deactivated", undefined],
    [STAFF_ORG, "platform.organization_member.deactivated", "denied", "owner_has_rfps", true],
  ]);
});

test("reactivate: a deactivated member becomes active, one event; an invited or removed member is refused", async () => {
  const { members, audit, get, sessionCalls } = setup();
  const answer = await members.reactivate(staff(), ACME, ids.suspended, { version: 1, reason: REASON });
  assert.deepEqual([answer.changed, answer.member.status, answer.version], [true, "active", 2]);
  assert.equal(get(ACME, ids.suspended).status, "active");
  assert.deepEqual(sessionCalls, []);
  oneStaffEvent(audit, { action: "platform.organization_member.reactivated", decision: "allowed", reason: "member_reactivated", targetId: ids.suspended, metadata: { changed: true, before: { role: "planner", roles: ["planner"], status: "suspended" }, after: { role: "planner", roles: ["planner"], status: "active" } } });
  for (const member of ["invited", "removed"]) {
    const refused = setup();
    await assert.rejects(refused.members.reactivate(staff(), ACME, ids[member], { version: 1, reason: REASON }), refusedWith(409, "MEMBER_NOT_DEACTIVATED"), member);
    assert.deepEqual(refused.writes(), []);
    oneStaffEvent(refused.audit, { decision: "denied", reason: "member_not_deactivated" });
  }
});

// ── Ownership ────────────────────────────────────────────────────────────────────────────────

const owners = (rows, organizationId) => rows.filter((r) => r.organizationId === organizationId && r.roles.includes("owner")).map((r) => r.userId);

test("ownership transfer: staff need not be the Owner; the current Owner becomes an Admin and the target the Owner in one store call, leaving exactly one Owner", async () => {
  for (const target of ["admin", "manager", "planner", "viewer"]) {
    const { members, audit, rows, get, sessionCalls, calls } = setup();
    const answer = await members.transferOwnership(staff(), ACME, { toUserId: ids[target], version: 1, reason: REASON });
    assert.deepEqual(owners(rows, ACME), [ids[target]], target);
    assert.deepEqual(get(ACME, ids.owner).roles, ["organization_admin"]);
    assert.deepEqual([answer.organizationId, answer.previousOwner.member.userId, answer.previousOwner.member.roles, answer.previousOwner.version], [ACME, ids.owner, ["organization_admin"], 2]);
    assert.deepEqual([answer.owner.member.userId, answer.owner.member.roles[0], answer.owner.version], [ids[target], "owner", 2]);
    const transfers = calls.filter(([n]) => n === "transferOwnership");
    assert.equal(transfers.length, 1, "one transaction");
    assert.deepEqual([transfers[0][1].organizationId, transfers[0][1].fromUserId, transfers[0][1].toUserId, transfers[0][1].expectedTargetVersion], [ACME, ids.owner, ids[target], 1]);
    // The previous Owner lost rights by someone else's hand: every session ends. The new Owner's others end on their next request.
    assert.deepEqual(sessionCalls, [["role", ids.owner, ACME, STAFF, "demoted"], ["role", ids[target], ACME, STAFF]]);
    oneStaffEvent(audit, {
      action: "platform.organization_member.ownership_transferred", decision: "allowed", reason: "ownership_transferred", targetId: ids[target],
      metadata: {
        organizationId: ACME, memberUserId: ids[target], previousOwnerUserId: ids.owner, staffReason: REASON,
        before: { ownerUserId: ids.owner, newOwnerRole: get(ACME, ids[target]).roles.includes("knowledge_editor") ? "team_manager" : target === "admin" ? "organization_admin" : target === "manager" ? "team_manager" : target, previousOwnerRole: "owner" },
        after: { ownerUserId: ids[target], newOwnerRole: "owner", previousOwnerRole: "organization_admin" },
      },
    });
    // The other organization's Owner is untouched.
    assert.deepEqual(owners(rows, OTHER), [hex("0")]);
  }
});

test("ownership transfer refusals leave the one Owner in place: MEMBER_NOT_FOUND (incl. another organization's member), MEMBER_INACTIVE, ALREADY_OWNER, VERSION_REQUIRED, STALE_VERSION, OWNER_NOT_FOUND, OWNER_CHANGED", async () => {
  const cases = [
    [{ toUserId: FOREIGN }, 404, "MEMBER_NOT_FOUND"],
    [{ toUserId: hex("0") }, 404, "MEMBER_NOT_FOUND"],
    [{ toUserId: ids.suspended }, 409, "MEMBER_INACTIVE"],
    [{ toUserId: ids.invited }, 409, "MEMBER_INACTIVE"],
    [{ toUserId: ids.removed }, 409, "MEMBER_INACTIVE"],
    [{ toUserId: ids.owner }, 400, "ALREADY_OWNER"],
    [{ version: undefined }, 400, "VERSION_REQUIRED"],
    [{ version: 4 }, 409, "STALE_VERSION"],
  ];
  for (const [body, status, code] of cases) {
    const { members, audit, rows, writes, sessionCalls } = setup();
    await assert.rejects(members.transferOwnership(staff(), ACME, { toUserId: ids.admin, version: 1, reason: REASON, ...body }), refusedWith(status, code), code);
    assert.deepEqual(writes(), [], code);
    assert.deepEqual(owners(rows, ACME), [ids.owner], code);
    assert.deepEqual(sessionCalls, []);
    oneStaffEvent(audit, { action: STAFF_MEMBER_AUDIT.ownershipTransferred, decision: "denied", reason: code.toLowerCase() });
  }
  const noOwner = setup();
  noOwner.get(ACME, ids.owner).roles = ["organization_admin"];
  await assert.rejects(noOwner.members.transferOwnership(staff(), ACME, { toUserId: ids.admin, version: 1, reason: REASON }), refusedWith(409, "OWNER_NOT_FOUND"));
  assert.deepEqual(noOwner.writes(), []);
  assert.deepEqual(owners(noOwner.rows, ACME), [], "staff do not appoint an Owner where there is none");
  oneStaffEvent(noOwner.audit, { decision: "denied", reason: "owner_not_found" });

  for (const [outcome, code] of [["not_owner", "OWNER_CHANGED"], ["stale", "STALE_VERSION"]]) {
    const raced = setup();
    raced.state.transferOutcome = outcome;
    await assert.rejects(raced.members.transferOwnership(staff(), ACME, { toUserId: ids.admin, version: 1, reason: REASON }), refusedWith(409, code));
    assert.deepEqual(owners(raced.rows, ACME), [ids.owner]);
    assert.deepEqual(raced.sessionCalls, []);
    oneStaffEvent(raced.audit, { decision: "denied", reason: code.toLowerCase() });
  }
});

// ── Reassignment ─────────────────────────────────────────────────────────────────────────────

test("reassign proposals: moves all or the selected ones inside the organization, mirrors the owner, and writes ONE staff-side event instead of the customer's per-proposal events", async () => {
  const { members, audit, calls, mirrorCalls, sessionCalls } = setup();
  const all = await members.reassignRfps(staff(), ACME, ids.planner, { toUserId: ids.manager, reason: REASON });
  assert.deepEqual(all, { organizationId: ACME, reassignedCount: 2, rfpIds: [hex("b"), hex("c")] });
  const call = calls.find(([n]) => n === "reassign")[1];
  assert.deepEqual([call.organizationId, call.fromUserId, call.toUserId, call.rfpIds], [ACME, ids.planner, ids.manager, null]);
  assert.deepEqual(mirrorCalls, [{ organizationId: ACME, rfpIds: [hex("b"), hex("c")], toUserId: ids.manager }]);
  assert.deepEqual(sessionCalls, []);
  oneStaffEvent(audit, {
    action: "platform.organization_member.proposals_reassigned", decision: "allowed", reason: "proposals_reassigned", targetId: ids.planner,
    metadata: { organizationId: ACME, memberUserId: ids.planner, toUserId: ids.manager, selection: "all", reassignedCount: 2, rfpIds: [hex("b"), hex("c")], before: { ownerUserId: ids.planner }, after: { ownerUserId: ids.manager }, staffReason: REASON },
  });

  const selected = setup();
  await selected.members.reassignRfps(staff(), ACME, ids.planner, { toUserId: ids.owner, rfpIds: [hex("b"), hex("b")], reason: REASON });
  assert.deepEqual(selected.calls.find(([n]) => n === "reassign")[1].rfpIds, [hex("b")]);
  assert.equal(selected.audit[0].metadata.selection, "selected");

  const whole = setup();
  await whole.members.reassignRfps(staff(), ACME, ids.suspended, { toUserId: ids.admin, rfpIds: "all", reason: REASON });
  assert.equal(whole.calls.find(([n]) => n === "reassign")[1].rfpIds, null);

  // Nothing to move: still one event, and no mirror call.
  const none = setup();
  none.state.reassignResult = { rfpIds: [] };
  assert.equal((await none.members.reassignRfps(staff(), ACME, ids.planner, { toUserId: ids.manager, reason: REASON })).reassignedCount, 0);
  assert.deepEqual(none.mirrorCalls, []);
  oneStaffEvent(none.audit, { decision: "allowed", metadata: { reassignedCount: 0 } });
});

test("reassign refusals: REASSIGN_TO_SELF, REASSIGN_TARGET_INELIGIBLE (a Viewer, an inactive member, or one who became ineligible when it committed), RFPS_NOT_OWNED_BY_MEMBER", async () => {
  const self = setup();
  await assert.rejects(self.members.reassignRfps(staff(), ACME, ids.planner, { toUserId: ids.planner, reason: REASON }), refusedWith(400, "REASSIGN_TO_SELF"));
  assert.deepEqual(self.writes(), []);
  oneStaffEvent(self.audit, { decision: "denied", reason: "reassign_to_self" });

  for (const target of ["viewer", "suspended", "invited", "removed"]) {
    const { members, audit, writes, mirrorCalls } = setup();
    await assert.rejects(members.reassignRfps(staff(), ACME, ids.planner, { toUserId: ids[target], reason: REASON }), (error) => refusedWith(409, "REASSIGN_TARGET_INELIGIBLE")(error) && /^Proposals can only go/.test(error.message), target);
    assert.deepEqual(writes(), [], target);
    assert.deepEqual(mirrorCalls, []);
    oneStaffEvent(audit, { decision: "denied", reason: "reassign_target_ineligible" });
  }
  for (const [result, code, detail] of [["target_ineligible", "REASSIGN_TARGET_INELIGIBLE", undefined], [{ notOwnedCount: 2 }, "RFPS_NOT_OWNED_BY_MEMBER", 2]]) {
    const { members, audit, state, mirrorCalls } = setup();
    state.reassignResult = result;
    await assert.rejects(members.reassignRfps(staff(), ACME, ids.planner, { toUserId: ids.manager, rfpIds: [hex("b")], reason: REASON }), (error) => refusedWith(409, code)(error) && error.details?.notOwnedCount === detail);
    assert.deepEqual(mirrorCalls, []);
    oneStaffEvent(audit, { decision: "denied", reason: code.toLowerCase() });
  }
});

// ── Audit ────────────────────────────────────────────────────────────────────────────────────

test("audit: every request leaves exactly one event in the STAFF organization and none in the customer organization, allowed or refused", async () => {
  for (const [name, action, run] of ALL) {
    const allowed = setup();
    await run(allowed.members, staff());
    oneStaffEvent(allowed.audit, { action, decision: "allowed", metadata: { organizationId: ACME } });
    const refused = setup();
    await assert.rejects(run(refused.members, staff(), ACME, hex("0")));
    oneStaffEvent(refused.audit, { action, decision: "denied" });
    for (const event of [...allowed.audit, ...refused.audit]) {
      assert.notEqual(event.organizationId, ACME, name);
      assert.doesNotMatch(event.action, /^(organization\.|proposal\.|auth\.)/, name);
      assert.equal(ACTIONS.includes(event.action), true);
    }
  }
});

test("audit: an applied change's event is handed to the store to commit with the change; if it cannot be written nothing is applied, no session is ended and nothing is returned", async () => {
  for (const [name, action, run] of WRITES) {
    const { members, audit, state, rows, sessionCalls, mirrorCalls, calls } = setup();
    const before = JSON.stringify(rows);
    state.failStoreAudit = true;
    await assert.rejects(run(members, staff()), /audit store down/, name);
    assert.equal(JSON.stringify(rows), before, `${name}: nothing applied`);
    assert.deepEqual([audit, sessionCalls, mirrorCalls], [[], [], []], name);
    const write = calls.find(([n]) => ["setRoles", "deactivate", "reactivate", "transferOwnership", "reassign"].includes(n))[1];
    assert.deepEqual([write.audit.organizationId, write.audit.actorUserId, write.audit.action, write.audit.targetType], [STAFF_ORG, STAFF, action, "organization_membership"], name);
    assert.equal(write.audit.metadata.organizationId, ACME);
  }
  // A refusal is returned even when its event cannot be written (nothing was changed).
  const refused = setup();
  refused.state.failAudit = true;
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    await assert.rejects(refused.members.deactivate(staff(), ACME, ids.owner, { version: 1, reason: REASON }), refusedWith(409, "LAST_OWNER"));
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /could not be recorded/);
});

test("audit: no code path of the staff member service writes into the customer organization, and none of the customer-side member events is written", () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const service = read("src/modules/staffAccess/application/manageOrganizationMembers.ts");
  const code = service.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // One place builds every event, and its organization is the staff member's.
  assert.equal((code.match(/\borganizationId: attempt\.staff\.organizationId,/g) ?? []).length, 1);
  assert.equal((code.match(/audit\.append\(/g) ?? []).length, 2);
  for (const append of code.match(/audit\.append\(\{[^\n]*/g)) assert.match(append, /audit\.append\(\{ \.\.\.(eventOf\(|event,)/);
  assert.doesNotMatch(code, /organization\.member\.|organization\.ownership\.|proposal\.owner\.reassigned|auth\.sessions/);
  // The customer service and its composition are not used: its audit writer and session hook write customer-side events.
  assert.doesNotMatch(service, /createMemberManagement|organizationMembers\/composition|membershipSessions\b/);
  const composition = read("src/modules/staffAccess/composition.ts");
  assert.match(composition, /sessions: staffMembershipSessions,/);
  assert.doesNotMatch(composition, /[^f]membershipSessions|\bmemberManagement\b[^,]*organizationMembers\/composition/);
  // The staff session hook ends sessions through the repository, not through the session manager that audits in the member's organization.
  const auth = read("src/modules/auth/composition.ts");
  const hook = auth.slice(auth.indexOf("export const staffMembershipSessions"));
  assert.match(hook, /mongoRefreshSessionRepository\.revokeAll\(/);
  assert.doesNotMatch(hook, /authenticationSessions|audit/);
  // The directory performs no write.
  const directory = read("src/modules/staffAccess/infrastructure/mongoStaffMemberDirectory.ts");
  assert.doesNotMatch(directory, /\.(create|insertMany|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|deleteOne|deleteMany|findOneAndDelete|replaceOne|bulkWrite|save)\(/);
  assert.doesNotMatch(directory, /securityAuditEventModel|SecurityAuditEvent/);
  assert.match(directory, /OrganizationMembership\.findOne\(\{ organizationId: organization, userId: user \}\)/);
  assert.match(directory, /TeamMembership\.find\(\{ organizationId: organization, userId: user \}\)/);
  assert.match(directory, /Team\.find\(\{ organizationId: organization, _id:/);
});

test("the Mongo store writes a change's audit event inside the transaction of the change, in the event's own organization", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/organizationMembers/infrastructure/mongoMembershipStore.ts"), "utf8");
  assert.match(source, /await SecurityAuditEvent\.create\(\[\{\s+organizationId: objectId\(audit\.organizationId\),[\s\S]*?\}\], \{ session \}\);/);
  // Every use passes the transaction's session, and each sits inside a withTransaction callback.
  const uses = [...source.matchAll(/await appendAudit\(input\.audit, session[,)]/g)];
  assert.equal(uses.length, 5, "setRoles, deactivate, reactivate, transferOwnership, reassign");
  for (const use of uses) {
    const before = source.slice(0, use.index);
    assert.ok(before.lastIndexOf("session.withTransaction(async () => {") > before.lastIndexOf("} finally {"), "inside the transaction");
  }
  assert.equal((source.match(/appendAudit\(/g) ?? []).length, 5, "no use outside those five");
  // Without an event the customer's fast paths are unchanged.
  assert.match(source, /if \(mayOwnRfps && !input\.audit\) \{/);
  assert.match(source, /if \(!input\.audit\) \{\s+const row = await updateVersioned\(input, \{ status: "suspended" \}, update\);/);
});

test("the staff session hook follows the customer's session rules and writes no audit event", async () => {
  const revoked = [];
  const pending = [];
  const hook = createMembershipSessionHardening({
    revokeOtherSessions: async (input) => { revoked.push([input.userId, input.organizationId, input.reason, input.exceptSessionId]); return 2; },
    markRevocationPending: async (input) => { pending.push([input.userId, input.organizationId]); },
    claimRevocationPending: async () => false, completeRevocationPending: async () => {}, releaseRevocationClaim: async () => {},
  });
  const change = { organizationId: ACME, actorUserId: STAFF, correlationId: "c" };
  await hook.afterRoleChange({ ...change, userId: ids.planner });
  await hook.afterRoleChange({ ...change, userId: ids.manager, demoted: true });
  await hook.afterDeactivation({ ...change, userId: ids.viewer });
  assert.deepEqual(pending, [[ids.planner, ACME]]);
  assert.deepEqual(revoked, [[ids.manager, ACME, "membership_role_demoted", undefined], [ids.viewer, ACME, "membership_deactivated", undefined]]);
});

// ── The customer's audit log ─────────────────────────────────────────────────────────────────

let seq = 0;
const stored = (overrides) => {
  seq += 1;
  return { id: seq.toString(16).padStart(24, "0"), organizationId: ACME, actorUserId: STAFF, targetType: "organization_membership", targetId: ids.planner, decision: "allowed", reason: "role_changed", metadata: { staffReason: REASON, previousRole: "planner", role: "viewer", before: { role: "planner" } }, createdAt: new Date(Date.UTC(2026, 10, 18, 0, 0, seq)), ...overrides };
};
const fakeEvents = (rows, leaky = false) => {
  const calls = [];
  const nameLookups = [];
  return {
    calls, nameLookups,
    isValidId: (value) => /^[0-9a-f]{24}$/i.test(value),
    async list(organizationId, filter, limit) {
      calls.push({ organizationId, filter });
      return rows.filter((row) => row.organizationId === organizationId && (leaky || filter.actions.includes(row.action)))
        .filter((row) => leaky || !filter.actorUserId || row.actorUserId === filter.actorUserId)
        .slice(0, limit).map(({ organizationId: _o, ...row }) => row);
    },
    async memberNames(_organizationId, userIds) { nameLookups.push(...userIds); return new Map(userIds.map((id) => [id, id === STAFF ? { name: "Staff Name", email: "staff@example.test" } : { name: "Olive Owner", email: "olive@example.test" }])); },
  };
};
const owner = { organizationId: ACME, userId: ids.owner, roles: ["owner"] };

test("the customer audit log cannot return a staff member action: not in the catalog, not by default, not as a stored row, not in the CSV", async () => {
  for (const action of ACTIONS) {
    assert.match(action, /^platform\.organization_member\.[a-z_]+$/);
    assert.equal(Object.prototype.hasOwnProperty.call(AUDIT_CATALOG, action), false, action);
    assert.equal(catalogEntry(action), undefined, action);
    assert.equal(isStaffOnlyAction(action), true, action);
    assert.equal(VISIBLE_ACTIONS.includes(action), false, action);
  }
  assert.equal(JSON.stringify(AUDIT_CATALOG).includes("platform."), false);
  // Rows that should never exist: the staff actions stored in the CUSTOMER organization. Even
  // then, and even with a reader that ignores the action filter, none is returned.
  const visible = stored({ action: "organization.member.role_changed", actorUserId: ids.owner, metadata: { previousRole: "planner", role: "viewer" } });
  const rows = [...ACTIONS.flatMap((action) => [stored({ action }), stored({ action, decision: "denied", reason: "last_owner" })]), visible];
  for (const leaky of [false, true]) {
    const events = fakeEvents(rows, leaky);
    const log = createAuditLog({ events });
    for (const role of ["owner", "organization_admin"]) {
      const page = await log.list({ ...owner, roles: [role] }, {});
      assert.deepEqual(page.events.map((e) => e.id), [visible.id]);
      const exported = await log.exportCsv({ ...owner, roles: [role] }, {});
      assert.equal(exported.rows, 1);
      for (const hidden of ["platform.", "organization_member.", REASON, "Staff Name", STAFF, "staffReason"]) {
        assert.equal(JSON.stringify(page).includes(hidden), false, hidden);
        assert.equal(exported.csv.includes(hidden), false, hidden);
      }
    }
    assert.equal(events.nameLookups.includes(STAFF), false, "the staff account is never looked up as a member");
  }
});

test("a staff member action cannot be asked for by action, by category or by the staff account as actor, in the list or the CSV; the filter options do not offer one", async () => {
  const events = fakeEvents(ACTIONS.map((action) => stored({ action })));
  const log = createAuditLog({ events });
  const invalid = (error) => error instanceof AuditLogError && error.status === 400 && error.code === "AUDIT_FILTER_INVALID";
  for (const action of ACTIONS) {
    await assert.rejects(() => log.list(owner, { action }), invalid, action);
    await assert.rejects(() => log.exportCsv(owner, { action }), invalid, action);
  }
  for (const category of AUDIT_CATEGORIES.map((c) => c.key)) {
    for (const query of [{ category }, { category, actor: STAFF }, { actor: STAFF }, { actor: "support" }]) {
      assert.deepEqual((await log.list(owner, query)).events, [], JSON.stringify(query));
      assert.equal((await log.exportCsv(owner, query)).rows, 0, JSON.stringify(query));
    }
  }
  for (const category of ["platform", "staff", "organization_member"]) await assert.rejects(() => log.list(owner, { category }), invalid, category);
  for (const call of events.calls) for (const action of call.filter.actions) assert.equal(isStaffOnlyAction(action), false, action);
  const offered = log.filters(owner).categories.flatMap((category) => category.actions.map((action) => action.value));
  assert.deepEqual(offered.filter((action) => ACTIONS.includes(action) || action.startsWith("platform.")), []);
  assert.equal(JSON.stringify(log.filters(owner)).includes("platform"), false);
});

// ── Answers ──────────────────────────────────────────────────────────────────────────────────

const MEMBER_KEYS = ["userId", "name", "email", "roles", "status", "teams", "joinedAt", "lastSignedInAt"];

test("answers are built from the staff members read's allowlist: no token, hash, session data or stored document, whatever the directory hands back", async () => {
  const { staffMemberView } = require("../src/modules/staffAccess/application/readOrganizationContent");
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/staffAccess/application/manageOrganizationMembers.ts"), "utf8");
  assert.equal((source.match(/member: staffMemberView\(found\.member\)/g) ?? []).length, 2, "the read and the write answers");
  assert.deepEqual(Object.keys(staffMemberView({ userId: "u", name: null, email: null, roles: [], status: "active", teams: [], joinedAt: null, lastSignedInAt: null, ...SECRETS })), MEMBER_KEYS);
  const memberShaped = (member, label) => {
    assert.deepEqual(Object.keys(member), MEMBER_KEYS, label);
    for (const team of member.teams) assert.deepEqual(Object.keys(team), ["id", "name", "archived", "isManager"], label);
  };
  for (const [name, , run] of ALL) {
    const { members } = setup();
    const answer = await run(members, staff());
    noSecrets(answer, name);
    assert.equal(answer.organizationId, ACME);
    if (name === "transferOwnership") {
      assert.deepEqual(Object.keys(answer), ["organizationId", "previousOwner", "owner"]);
      for (const side of [answer.previousOwner, answer.owner]) { assert.deepEqual(Object.keys(side), ["member", "version"]); memberShaped(side.member, name); }
    } else if (name === "reassignRfps") {
      assert.deepEqual(Object.keys(answer), ["organizationId", "reassignedCount", "rfpIds"]);
    } else {
      assert.deepEqual(Object.keys(answer), name === "member" ? ["organizationId", "member", "version"] : ["organizationId", "changed", "member", "version"]);
      memberShaped(answer.member, name);
      assert.equal(typeof answer.version, "number");
    }
  }
});

test("member read: one member of the path's organization with the version the writes need, recorded once; it fails if the event cannot be written", async () => {
  const { members, audit, calls } = setup();
  const answer = await members.member(staff(), ACME, ids.manager);
  assert.deepEqual([answer.member.userId, answer.member.roles, answer.version], [ids.manager, ["team_manager", "knowledge_editor"], 1]);
  assert.deepEqual(calls, [["organization", ACME], ["member", ACME, ids.manager]]);
  oneStaffEvent(audit, { action: "platform.organization_member.read", decision: "allowed", reason: "member", targetId: ids.manager, metadata: { organizationId: ACME, resource: "member" } });
  const failing = setup();
  failing.state.failAudit = true;
  await assert.rejects(failing.members.member(staff(), ACME, ids.manager), /audit store down/);
});

test("user-facing text says proposal, never RFP", async () => {
  const messages = [];
  const collect = async (run) => { try { await run(); } catch (error) { messages.push(error.message, JSON.stringify(error.details ?? {})); } };
  const owning = setup({ owned: { [ids.planner]: 2 } });
  await collect(() => owning.members.deactivate(staff(), ACME, ids.planner, { version: 1, reason: REASON }));
  const { members, state } = setup();
  await collect(() => members.reassignRfps(staff(), ACME, ids.planner, { toUserId: ids.viewer, reason: REASON }));
  await collect(() => members.reassignRfps(staff(), ACME, ids.planner, { toUserId: "x", reason: REASON }));
  await collect(() => members.reassignRfps(staff(), ACME, ids.planner, { toUserId: ids.manager, rfpIds: [], reason: REASON }));
  state.reassignResult = { notOwnedCount: 1 };
  await collect(() => members.reassignRfps(staff(), ACME, ids.planner, { toUserId: ids.manager, rfpIds: [hex("b")], reason: REASON }));
  assert.equal(messages.length, 10);
  for (const message of messages) assert.doesNotMatch(message.replace(/rfpIds|ownedRfpCount/g, ""), /\brfps?\b/i, message);
  for (const file of ["src/modules/staffAccess/application/manageOrganizationMembers.ts", "controller/adminOrganizationMembersController.ts"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    for (const literal of source.match(/"[^"\n]*"|`[^`\n]*`/g) ?? []) {
      if (/^["`][A-Z_]+["`]$/.test(literal) || /rfpIds/.test(literal)) continue;
      assert.doesNotMatch(literal, /\bRFPs?\b/, `${file}: ${literal}`);
    }
  }
});

// ── Member policy: the staff manager ─────────────────────────────────────────────────────────

test("policy: a staff manager is not a member; the customer's decisions are otherwise unchanged", () => {
  const { STAFF_MANAGER, isStaffManager, decideRoleChange, decideDeactivation, decideOwnershipTransfer } = policy;
  assert.deepEqual(STAFF_MANAGER, { staff: true });
  assert.equal(isStaffManager(STAFF_MANAGER), true);
  for (const member of [{ userId: "u", roles: ["owner"] }, { userId: "u", roles: ["dxg_admin"] }, { userId: "u", roles: [], staff: false }]) assert.equal(isStaffManager(member), false);
  const target = (roles, status = "active") => ({ userId: "t", roles, status });
  // Ordinary changes are allowed with no role in the organization.
  assert.deepEqual(decideRoleChange({ actor: STAFF_MANAGER, target: target(["planner"]), role: "organization_admin", ownedRfpCount: 0 }), { ok: true });
  assert.equal(decideRoleChange({ actor: STAFF_MANAGER, target: target(["planner"]), role: "viewer", ownedRfpCount: 1 }).code, "OWNER_HAS_RFPS");
  assert.equal(decideRoleChange({ actor: STAFF_MANAGER, target: target(["planner"]), role: "owner", ownedRfpCount: 0 }).code, "OWNERSHIP_TRANSFER_REQUIRED");
  assert.equal(decideRoleChange({ actor: STAFF_MANAGER, target: target(["owner"]), role: "planner", ownedRfpCount: 0 }).code, "OWNERSHIP_TRANSFER_REQUIRED");
  assert.equal(decideRoleChange({ actor: STAFF_MANAGER, target: target(["owner"]), role: "owner", ownedRfpCount: 0 }).code, "OWNERSHIP_TRANSFER_REQUIRED");
  assert.equal(decideRoleChange({ actor: STAFF_MANAGER, target: target(["planner"], "removed"), role: "viewer", ownedRfpCount: 0 }).code, "MEMBER_REMOVED");
  assert.deepEqual(decideDeactivation({ actor: STAFF_MANAGER, target: target(["planner"]), ownedRfpCount: 0 }), { ok: true });
  assert.equal(decideDeactivation({ actor: STAFF_MANAGER, target: target(["owner"]), ownedRfpCount: 0 }).code, "LAST_OWNER");
  assert.equal(decideDeactivation({ actor: STAFF_MANAGER, target: target(["planner"]), ownedRfpCount: 2 }).code, "OWNER_HAS_RFPS");
  assert.deepEqual(decideOwnershipTransfer({ actor: STAFF_MANAGER, target: target(["viewer"]) }), { ok: true });
  assert.equal(decideOwnershipTransfer({ actor: STAFF_MANAGER, target: null }).code, "MEMBER_NOT_FOUND");
  assert.equal(decideOwnershipTransfer({ actor: STAFF_MANAGER, target: target(["owner"]) }).code, "ALREADY_OWNER");
  assert.equal(decideOwnershipTransfer({ actor: STAFF_MANAGER, target: target(["planner"], "suspended") }).code, "MEMBER_INACTIVE");
  // A member is still held to the customer's rules.
  assert.equal(decideOwnershipTransfer({ actor: { userId: "a", roles: ["organization_admin"] }, target: target(["planner"]) }).code, "OWNER_ONLY");
  assert.equal(decideDeactivation({ actor: { userId: "a", roles: ["organization_admin"] }, target: target(["owner"]), ownedRfpCount: 0 }).code, "OWNER_ONLY");
  assert.equal(decideRoleChange({ actor: { userId: "a", roles: ["organization_admin"] }, target: target(["owner"]), role: "planner", ownedRfpCount: 0 }).code, "OWNER_ONLY");
});

// ── Controller ───────────────────────────────────────────────────────────────────────────────

const fakeResponse = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const request = (overrides = {}) => ({
  user: { userId: STAFF, organizationId: STAFF_ORG, role: "admin", accountType: "admin", roles: ["dxg_admin"] },
  params: { organizationId: ACME, userId: ids.planner }, query: {}, body: { version: 1, reason: REASON }, correlationId: "corr-staff", ...overrides,
});

test("controller: the organization and member come from the path only; refusals carry code, message and details; an unexpected error is a plain 500", async () => {
  const { members, audit, get, calls } = setup();
  const controller = createAdminOrganizationMembersController(members);
  // A body or query that names another organization or member is ignored.
  const res = fakeResponse();
  await controller.deactivate(request({ body: { version: 1, reason: REASON, organizationId: OTHER, userId: FOREIGN }, query: { organizationId: OTHER } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual([res.body.success, res.body.data.organizationId, res.body.data.member.userId, res.body.data.member.status], [true, ACME, ids.planner, "suspended"]);
  assert.equal(get(OTHER, FOREIGN).status, "active");
  assert.equal(calls.some((call) => JSON.stringify(call).includes(OTHER)), false);
  assert.equal(audit.length, 1);

  const cases = [
    ["changeRole", request({ body: { role: "owner", version: 1, reason: REASON } }), 409, "OWNERSHIP_TRANSFER_REQUIRED"],
    ["changeRole", request({ body: { role: "viewer", version: 9, reason: REASON } }), 409, "STALE_VERSION"],
    ["deactivate", request({ params: { organizationId: ACME, userId: ids.owner } }), 409, "LAST_OWNER"],
    ["reactivate", request({ body: { version: 1 } }), 400, "INVALID_REASON"],
    ["reassignRfps", request({ body: { toUserId: FOREIGN, reason: REASON } }), 404, "REASSIGN_TARGET_NOT_FOUND"],
    ["transferOwnership", request({ params: { organizationId: ACME }, body: { toUserId: FOREIGN, version: 1, reason: REASON } }), 404, "MEMBER_NOT_FOUND"],
    ["member", request({ params: { organizationId: HOLDING, userId: ids.planner } }), 409, "ORGANIZATION_NOT_MANAGEABLE"],
    ["member", request({ user: { userId: ids.owner, organizationId: ACME, role: "customer", accountType: "planner", roles: ["owner"] } }), 403, "STAFF_ACCESS_FORBIDDEN"],
    ["member", request({ user: undefined }), 401, "AUTHENTICATION_REQUIRED"],
    ["deactivate", request({ body: "not an object" }), 400, "INVALID_REASON"],
    ["deactivate", request({ body: [{ version: 1, reason: REASON }] }), 400, "INVALID_REASON"],
  ];
  for (const [handler, req, status, code] of cases) {
    const response = fakeResponse();
    await createAdminOrganizationMembersController(setup().members)[handler](req, response);
    assert.deepEqual([response.statusCode, response.body.success, response.body.code], [status, false, code], `${handler} ${code}`);
    assert.equal(typeof response.body.message, "string");
    assert.equal("data" in response.body, false);
  }
  const staleResponse = fakeResponse();
  await controller.changeRole(request({ body: { role: "viewer", version: 9, reason: REASON } }), staleResponse);
  assert.equal(staleResponse.body.currentVersion, 2, "the planner was deactivated above");
  assert.equal(staleResponse.body.code, "STALE_VERSION", "details sit beside code and message, as on the customer routes");
  const reasonResponse = fakeResponse();
  await controller.reactivate(request({ body: { version: 1, reason: "short" } }), reasonResponse);
  assert.deepEqual(reasonResponse.body.fields, { reason: "Give a reason of 10 to 500 characters." });

  const broken = createAdminOrganizationMembersController({ deactivate: async () => { throw new Error("mongo exploded: secret detail"); } });
  const failed = fakeResponse();
  const original = console.error;
  console.error = () => {};
  try { await broken.deactivate(request(), failed); } finally { console.error = original; }
  assert.deepEqual([failed.statusCode, failed.body.code], [500, "STAFF_MEMBERS_INTERNAL_ERROR"]);
  assert.equal(JSON.stringify(failed.body).includes("secret detail"), false);
});

// ── Routes ───────────────────────────────────────────────────────────────────────────────────

const guardRefusesCustomers = (guard, label) => {
  for (const roles of [["owner"], ["organization_admin"], ["team_manager"], ["planner"], ["viewer"], ["knowledge_approver"], []]) {
    const res = fakeResponse();
    let passed = false;
    guard({ user: { roles } }, res, () => { passed = true; });
    assert.equal(passed, false, `${label} as ${roles}`);
    assert.equal(res.statusCode, 403);
  }
  for (const roles of [["dxg_admin"], ["super_admin"]]) {
    let passed = false;
    guard({ user: { roles } }, fakeResponse(), () => { passed = true; });
    assert.equal(passed, true, `${label} as ${roles}`);
  }
  const res = fakeResponse();
  guard({}, res, () => { throw new Error("no session must not pass"); });
  assert.equal(res.statusCode, 401);
};

test("routes: every route sits behind authenticate, the staff role guard and a per-staff limit; every write carries the write limit, stricter than the read limit; members only", () => {
  const router = require("../routes/adminOrganizationMembersRoute").default;
  const { staffMemberWrites } = require("../routes/adminOrganizationMembersRoute");
  const { staffContentReads } = require("../routes/adminOrganizationContentRoute");
  const { authenticate } = require("../middleware/auth");
  const { adminOrganizationMembersController: controller } = require("../controller/adminOrganizationMembersController");
  const routes = router.stack.filter((layer) => layer.route).map((layer) => layer.route);
  const describe = (route) => `${Object.keys(route.methods).join(",").toUpperCase()} ${route.path}`;
  assert.deepEqual(routes.map(describe), [
    "GET /admin/organizations/:organizationId/members/:userId",
    "PATCH /admin/organizations/:organizationId/members/:userId/role",
    "POST /admin/organizations/:organizationId/members/:userId/deactivate",
    "POST /admin/organizations/:organizationId/members/:userId/reactivate",
    "POST /admin/organizations/:organizationId/members/:userId/reassign-rfps",
    "POST /admin/organizations/:organizationId/ownership/transfer",
  ]);
  assert.equal(router.stack.every((layer) => layer.route), true, "no router-level middleware that could skip the guard");
  const handlers = [controller.member, controller.changeRole, controller.deactivate, controller.reactivate, controller.reassignRfps, controller.transferOwnership];
  routes.forEach((route, index) => {
    assert.equal(route.stack.length, 4, route.path);
    assert.equal(route.stack[0].handle, authenticate, route.path);
    guardRefusesCustomers(route.stack[1].handle, route.path);
    const isWrite = !route.methods.get;
    assert.equal(route.stack[2].handle, isWrite ? staffMemberWrites : staffContentReads, route.path);
    assert.equal(route.stack[3].handle, handlers[index], route.path);
  });
  assert.equal(routes.filter((route) => !route.methods.get).length, 5);
  assert.notEqual(staffMemberWrites, staffContentReads);

  const source = fs.readFileSync(path.join(__dirname, "../routes/adminOrganizationMembersRoute.ts"), "utf8");
  // A limit of its own, per staff account, stricter than the 300 reads and the 120 plan writes.
  assert.match(source, /name: "organization-member-write",\s+limit: 60,\s+windowMs: 15 \* 60_000,\s+identity: \(req: Request\) => \(req as AuthRequest\)\.user\?\.userId/);
  assert.match(source, /const staff = \[authenticate, authorize\("admin", "super_admin", "superadmin"\)\];\nconst write = \[\.\.\.staff, staffMemberWrites\];/);
  // Members and ownership only: no route on a proposal's content, templates, vendors, teams or invitations, and no delete.
  const lines = source.split("\n").filter((line) => /^router\./.test(line));
  assert.equal(lines.length, 6);
  for (const line of lines) {
    assert.match(line, /^router\.(get|patch|post)\("\/admin\/organizations\/:organizationId\/(members\/:userId(\/(role|deactivate|reactivate|reassign-rfps))?|ownership\/transfer)", \.\.\.(write|staff), /, line);
    assert.doesNotMatch(line, /proposals|templates|vendors|teams|invitations|two-factor|block/, line);
  }
  assert.doesNotMatch(source, /router\.(put|delete|all|use)\(/);
  for (const file of ["routes/adminOrganizationMembersRoute.ts", "controller/adminOrganizationMembersController.ts", "src/modules/staffAccess/application/manageOrganizationMembers.ts", "src/modules/staffAccess/infrastructure/mongoStaffMemberDirectory.ts"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), /proposalTemplate|ProposalTemplate|organizationVendor|OrganizationVendor|proposalsModel|invitationModel|Invitation\b/, file);
  }
  assert.match(fs.readFileSync(path.join(__dirname, "../server.ts"), "utf8"), /app\.use\("\/api\/v1", adminOrganizationMembersRoutes\);/);
});

test("routes: the write limit refuses the 61st write in a window with 429, per staff account, before the handler runs", async () => {
  const { staffMemberWrites } = require("../routes/adminOrganizationMembersRoute");
  const hit = (userId) => new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, set(name, value) { this.headers[name] = value; return this; }, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ passed: false, status: this.statusCode, body }); return this; } };
    staffMemberWrites({ user: { userId }, ip: "203.0.113.9", headers: {} }, res, () => resolve({ passed: true }));
  });
  const first = hex("1").replace(/1$/, "a");
  for (let i = 0; i < 60; i++) assert.equal((await hit(first)).passed, true, `write ${i + 1}`);
  const refused = await hit(first);
  assert.deepEqual([refused.passed, refused.status], [false, 429]);
  assert.equal((await hit(hex("2").replace(/2$/, "b"))).passed, true, "another staff account has its own count");
});
