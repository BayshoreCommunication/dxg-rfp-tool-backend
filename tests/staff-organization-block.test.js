require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createStaffOrganizationBlock } = require("../src/modules/staffAccess/application/manageOrganizationBlock");
const { STAFF_REASON_MIN, STAFF_REASON_MAX } = require("../src/modules/staffAccess/application/manageOrganizationMembers");
const { StaffAccessError, StaffMemberError, STAFF_ORGANIZATION_AUDIT, unmanageableStanding } = require("../src/modules/staffAccess/domain");
const { createAdminOrganizationBlockController } = require("../controller/adminOrganizationBlockController");
const { isOrganizationBlocked, ORGANIZATION_BLOCK_REVOKE_REASON } = require("../src/modules/organizationBlock/domain");
const { createOrganizationPlanManagement } = require("../src/modules/entitlements/application/manageOrganizationPlans");
const { createOrganizationAccountDetail } = require("../src/modules/entitlements/application/organizationAccountDetail");
const { VISIBLE_ACTIONS, isStaffOnlyAction } = require("../src/modules/auditLog/domain");

// Owner decision 2026-11-18 (docs/DECISIONS.md): RFPilot staff block and reactivate a customer
// organization; the record is on the staff side only. The sibling of
// tests/staff-member-management.test.js and tests/staff-team-management.test.js. The service runs
// here over an in-memory store that commits like the Mongo one; the real-database proof is
// tests-integration/staff-organization-block.test.ts.

const hex = (c) => c.repeat(24);
const ACME = hex("a");
const OTHER = hex("b");
const HOLDING = hex("c");
const STAFF_ORG = hex("d");
const SECOND_STAFF_ORG = hex("e");
const STAFF = hex("7");
const REASON = "Chargeback dispute, ticket 5521";
const NOW = new Date("2026-11-19T10:00:00Z");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

const staff = (overrides = {}) => ({ adminId: STAFF, organizationId: STAFF_ORG, role: "admin", accountType: "admin", correlationId: "corr-staff", ...overrides });

const setup = () => {
  const audit = [];
  const state = { failAudit: false, failStoreAudit: false, vanish: false, becomeHolding: false };
  const organizations = {
    [ACME]: { kind: "customer", staffAccountCount: 0 },
    [OTHER]: { kind: "customer", staffAccountCount: 0 },
    [HOLDING]: { kind: "legacy_holding", staffAccountCount: 0 },
    [STAFF_ORG]: { kind: "customer", staffAccountCount: 2 },
    [SECOND_STAFF_ORG]: { kind: "customer", staffAccountCount: 1 },
  };
  const sessions = [
    { organizationId: ACME, userId: hex("1"), status: "active", revokeReason: null },
    { organizationId: ACME, userId: hex("2"), status: "active", revokeReason: null },
    { organizationId: ACME, userId: hex("2"), status: "revoked", revokeReason: "user_logout" },
    { organizationId: OTHER, userId: hex("3"), status: "active", revokeReason: null },
  ];
  const lookups = [];
  const directory = {
    async organization(id) { lookups.push(id); const o = organizations[id]; return o ? { id, kind: o.kind, staffAccountCount: o.staffAccountCount } : null; },
  };
  // As the Mongo store: the marker, the sessions and the event commit together or not at all.
  const commit = (input, reason, metadata, apply) => {
    if (state.failStoreAudit) throw new Error("audit store down");
    const result = apply();
    audit.push({ ...input.audit, decision: "allowed", reason, metadata: { ...input.audit.metadata, ...metadata, ...(result ?? {}) } });
    return result;
  };
  const precheck = (input) => {
    const o = organizations[input.organizationId];
    if (!o || state.vanish) return "not_found";
    if (o.kind !== "customer" || state.becomeHolding || input.organizationId === input.staffOrganizationId) return "not_manageable";
    return o;
  };
  const store = {
    async block(input) {
      const o = precheck(input);
      if (typeof o === "string") return o;
      const end = () => {
        let ended = 0;
        for (const s of sessions) if (s.organizationId === input.organizationId && s.status !== "revoked") { s.status = "revoked"; s.revokeReason = ORGANIZATION_BLOCK_REVOKE_REASON; ended++; }
        return ended;
      };
      if (isOrganizationBlocked(o)) {
        const sessionsEnded = commit(input, "organization_already_blocked", { changed: false }, () => ({ sessionsEnded: end() })).sessionsEnded;
        return { changed: false, blockedAt: o.blocked.at, sessionsEnded };
      }
      const { sessionsEnded } = commit(input, "organization_blocked", { changed: true, before: { blocked: false }, after: { blocked: true, blockedAt: input.now } }, () => {
        o.blocked = { at: input.now, byStaffOrganizationId: input.staffOrganizationId, byStaffAccountId: input.staffAccountId };
        return { sessionsEnded: end() };
      });
      return { changed: true, blockedAt: input.now, sessionsEnded };
    },
    async reactivate(input) {
      // An organization that carries the marker is reactivated whatever it has become (F9).
      const marked = !state.vanish && isOrganizationBlocked(organizations[input.organizationId]);
      const o = marked ? organizations[input.organizationId] : precheck(input);
      if (typeof o === "string") return o;
      if (!isOrganizationBlocked(o)) {
        if (!input.manageable) return "not_manageable";
        commit(input, "organization_not_blocked", { changed: false }, () => undefined);
        return { changed: false, blockedAt: null, sessionsEnded: 0 };
      }
      commit(input, "organization_reactivated", { changed: true, before: { blocked: true }, after: { blocked: false } }, () => { delete o.blocked; });
      return { changed: true, blockedAt: null, sessionsEnded: 0 };
    },
  };
  const service = createStaffOrganizationBlock({
    directory, store, now: () => NOW,
    audit: { append: async (event) => { if (state.failAudit) throw new Error("audit down"); audit.push(event); } },
  });
  return { service, audit, state, organizations, sessions, lookups };
};

const refusal = async (run) => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
};

test("block: the marker is set, every session of that organization ends, one staff-side event, and no other organization is touched", async () => {
  const w = setup();
  const result = await w.service.block(staff(), ACME, { reason: `  ${REASON}  ` });
  assert.deepEqual(result, { organizationId: ACME, changed: true, blocked: true, blockedAt: NOW, sessionsEnded: 2 });
  assert.equal(isOrganizationBlocked(w.organizations[ACME]), true);
  assert.deepEqual(w.organizations[ACME].blocked, { at: NOW, byStaffOrganizationId: STAFF_ORG, byStaffAccountId: STAFF });
  assert.equal(isOrganizationBlocked(w.organizations[OTHER]), false);
  assert.deepEqual(w.sessions.map((s) => [s.organizationId, s.status, s.revokeReason]), [
    [ACME, "revoked", ORGANIZATION_BLOCK_REVOKE_REASON], [ACME, "revoked", ORGANIZATION_BLOCK_REVOKE_REASON], [ACME, "revoked", "user_logout"], [OTHER, "active", null],
  ]);
  assert.equal(w.audit.length, 1);
  const [event] = w.audit;
  assert.equal(event.organizationId, STAFF_ORG, "recorded in the staff organization");
  assert.equal(event.actorUserId, STAFF);
  assert.equal(event.action, "platform.organization.blocked");
  assert.deepEqual([event.targetType, event.targetId, event.decision, event.reason], ["organization", ACME, "allowed", "organization_blocked"]);
  assert.equal(event.metadata.staffReason, REASON, "trimmed");
  assert.equal(event.metadata.organizationId, ACME);
  assert.equal(event.metadata.changed, true);
  assert.equal(event.metadata.sessionsEnded, 2);
  assert.equal(JSON.stringify(result).includes(REASON), false, "the reason is never returned");
  assert.equal(JSON.stringify(result).includes(STAFF), false, "the answer does not name the staff account");
});

test("block and reactivate are idempotent, and a request that changes nothing is still recorded", async () => {
  const w = setup();
  await w.service.block(staff(), ACME, { reason: REASON });
  w.sessions.push({ organizationId: ACME, userId: hex("1"), status: "active", revokeReason: null }); // slipped in while the block committed
  const again = await w.service.block(staff(), ACME, { reason: REASON });
  assert.deepEqual(again, { organizationId: ACME, changed: false, blocked: true, blockedAt: NOW, sessionsEnded: 1 });
  assert.equal(w.sessions.at(-1).status, "revoked", "asking again closes a session that slipped in");

  const opened = await w.service.reactivate(staff(), ACME, { reason: REASON });
  assert.deepEqual(opened, { organizationId: ACME, changed: true, blocked: false, blockedAt: null });
  assert.equal("blocked" in w.organizations[ACME], false, "the marker is removed, not set to a value");
  assert.deepEqual(w.sessions.filter((s) => s.organizationId === ACME).map((s) => s.status), ["revoked", "revoked", "revoked", "revoked"], "ended sessions stay ended");
  const openedAgain = await w.service.reactivate(staff(), ACME, { reason: REASON });
  assert.deepEqual(openedAgain, { organizationId: ACME, changed: false, blocked: false, blockedAt: null });

  assert.deepEqual(w.audit.map((e) => [e.action, e.decision, e.reason, e.metadata.changed]), [
    ["platform.organization.blocked", "allowed", "organization_blocked", true],
    ["platform.organization.blocked", "allowed", "organization_already_blocked", false],
    ["platform.organization.reactivated", "allowed", "organization_reactivated", true],
    ["platform.organization.reactivated", "allowed", "organization_not_blocked", false],
  ]);
  assert.ok(w.audit.every((e) => e.organizationId === STAFF_ORG), "nothing is written to the customer organization");
});

test("the staff organization, any organization holding admins accounts, and a holding tenant can never be blocked, nor reactivated while they carry no marker", async () => {
  const w = setup();
  for (const [organizationId, standing] of [[STAFF_ORG, "platform"], [SECOND_STAFF_ORG, "platform"], [HOLDING, "legacy_holding"]]) {
    for (const call of ["block", "reactivate"]) {
      const error = await refusal(() => w.service[call](staff(), organizationId, { reason: REASON }));
      assert.ok(error instanceof StaffMemberError);
      assert.deepEqual([error.status, error.code, error.details.standing], [409, "ORGANIZATION_NOT_MANAGEABLE", standing], `${call} ${organizationId}`);
      assert.equal(isOrganizationBlocked(w.organizations[organizationId]), false);
    }
  }
  assert.equal(w.audit.length, 6);
  assert.ok(w.audit.every((e) => e.decision === "denied" && e.reason === "organization_not_manageable" && e.organizationId === STAFF_ORG));
  // The rule is the one the member and team routes use.
  assert.equal(unmanageableStanding({ id: ACME, kind: "customer", staffAccountCount: 0 }, STAFF_ORG), null);
});

test("the store's own check inside the transaction is honoured: gone is 404, no longer a customer organization is 409", async () => {
  const w = setup();
  w.state.vanish = true;
  const gone = await refusal(() => w.service.block(staff(), ACME, { reason: REASON }));
  assert.deepEqual([gone.status, gone.code], [404, "ORGANIZATION_NOT_FOUND"]);
  w.state.vanish = false;
  w.state.becomeHolding = true;
  const changed = await refusal(() => w.service.block(staff(), ACME, { reason: REASON }));
  assert.deepEqual([changed.status, changed.code], [409, "ORGANIZATION_NOT_MANAGEABLE"]);
  assert.equal(isOrganizationBlocked(w.organizations[ACME]), false);
});

test("validation: the organization only from the path as 24 lowercase hex, and a reason of 10 to 500 characters, before anything is looked up", async () => {
  const w = setup();
  for (const bad of ["", "abc", ACME.toUpperCase(), `${ACME}0`, { $ne: null }, null, undefined]) {
    const error = await refusal(() => w.service.block(staff(), bad, { reason: REASON }));
    assert.deepEqual([error.status, error.code], [400, "INVALID_ORGANIZATION_ID"], String(bad));
  }
  for (const bad of [undefined, null, 5, "", "too short", " ".repeat(40), "x".repeat(STAFF_REASON_MAX + 1)]) {
    for (const call of ["block", "reactivate"]) {
      const error = await refusal(() => w.service[call](staff(), ACME, { reason: bad }));
      assert.deepEqual([error.status, error.code], [400, "INVALID_REASON"], String(bad));
    }
  }
  await w.service.block(staff(), ACME, { reason: "x".repeat(STAFF_REASON_MIN) });
  assert.deepEqual(w.lookups, [ACME], "nothing was looked up for a malformed id or reason");
  const unknown = await refusal(() => w.service.block(staff(), hex("9"), { reason: REASON }));
  assert.deepEqual([unknown.status, unknown.code], [404, "ORGANIZATION_NOT_FOUND"]);
  const denied = w.audit.filter((e) => e.decision === "denied");
  assert.ok(denied.every((e) => e.organizationId === STAFF_ORG));
  assert.ok(denied.filter((e) => e.reason === "invalid_organization_id").every((e) => !("targetId" in e)), "a malformed id is never stored as a target");
});

test("only RFPilot staff accounts: a customer, and a users account holding a staff role, are refused before anything is read or recorded", async () => {
  const w = setup();
  const callers = [
    staff({ adminId: hex("1"), organizationId: ACME, role: "customer", accountType: "planner" }),
    staff({ accountType: "planner", role: "super_admin" }),
    staff({ role: "customer" }),
  ];
  for (const caller of callers) {
    for (const call of ["block", "reactivate"]) {
      const error = await refusal(() => w.service[call](caller, ACME, { reason: REASON }));
      assert.ok(error instanceof StaffAccessError && !(error instanceof StaffMemberError));
      assert.deepEqual([error.status, error.code], [403, "STAFF_ACCESS_FORBIDDEN"]);
    }
  }
  const noSession = await refusal(() => w.service.block(staff({ adminId: "" }), ACME, { reason: REASON }));
  assert.equal(noSession.status, 401);
  assert.deepEqual([w.lookups, w.audit], [[], []]);
  for (const role of ["admin", "super_admin", "superadmin"]) await w.service.block(staff({ role }), ACME, { reason: REASON });
});

test("the change and its record commit together: when the event cannot be written the organization is not blocked", async () => {
  const w = setup();
  w.state.failStoreAudit = true;
  await assert.rejects(() => w.service.block(staff(), ACME, { reason: REASON }), /audit store down/);
  assert.equal(isOrganizationBlocked(w.organizations[ACME]), false);
  assert.deepEqual(w.sessions.filter((s) => s.organizationId === ACME && s.status === "active").length, 2, "no session was ended");
  assert.equal(w.audit.length, 0);
  // A refusal is returned even when its record cannot be written: nothing changed.
  w.state.failStoreAudit = false;
  w.state.failAudit = true;
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const error = await refusal(() => w.service.block(staff(), HOLDING, { reason: REASON }));
    assert.equal(error.code, "ORGANIZATION_NOT_MANAGEABLE");
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
});

test("the Mongo store: one transaction, the marker written and removed only here, scoped to the path's customer organization", () => {
  const store = read("src/modules/staffAccess/infrastructure/mongoOrganizationBlockStore.ts");
  assert.match(store, /session\.withTransaction\(/);
  assert.match(store, /\{ _id: oid\(organizationId\), kind: "customer" \}/);
  assert.match(store, /organization\.kind !== "customer" \|\| organizationId === staffOrganizationId/);
  // Reactivation of an organization that carries the marker: by its id and the marker, whatever its kind.
  assert.match(store, /if \(allowMarked && isOrganizationBlocked\(organization\)\) \{\s+outcome = await work\(organization, \{ _id: oid\(organizationId\), "blocked\.at": \{ \$type: "date" \} \}, session\);/);
  assert.match(store, /if \(!input\.manageable\) return "not_manageable";/);
  assert.match(store, /\{ \$set: \{ blocked: marker \} \}, \{ session \}/);
  assert.match(store, /\{ \$unset: \{ blocked: "" \} \}, \{ session \}/);
  assert.match(store, /RefreshSession\.updateMany\(\s*\{ organizationId, status: \{ \$ne: "revoked" \} \}/);
  assert.match(store, /SecurityAuditEvent\.create\(\[\{\s*organizationId: oid\(audit\.organizationId\)/, "the event goes to the staff organization the service named");
  assert.equal((store.match(/SecurityAuditEvent\.create/g) ?? []).length, 1);
  assert.match(store, /\}\], \{ session \}\);/);
  assert.doesNotMatch(store, /status: "(in)?active"/, "`Organization.status` is never read or written");
  // Nobody else writes the marker.
  const walk = (dir) => fs.readdirSync(path.join(__dirname, "..", dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(file);
    return /\.ts$/.test(entry.name) ? [file] : [];
  });
  const writers = ["src", "controller", "routes", "middleware", "utils", "scripts"].flatMap(walk)
    .filter((file) => /\$(set|unset): \{[^}]*\bblocked\b/.test(read(file)) || /\.blocked\s*=[^=]/.test(read(file)));
  assert.deepEqual(writers, ["src/modules/staffAccess/infrastructure/mongoOrganizationBlockStore.ts"]);
});

test("routes: POST block and reactivate under the staff guard and the shared staff write limit; controller answers from the service only", async () => {
  const router = require("../routes/adminOrganizationBlockRoute").default;
  const members = require("../routes/adminOrganizationMembersRoute");
  const routes = router.stack.filter((layer) => layer.route).map((layer) => layer.route);
  assert.deepEqual(routes.map((route) => `${Object.keys(route.methods)[0].toUpperCase()} ${route.path}`), [
    "POST /admin/organizations/:organizationId/block",
    "POST /admin/organizations/:organizationId/reactivate",
  ]);
  for (const route of routes) {
    assert.equal(route.stack.length, 4, "authenticate, authorize, write limit, handler");
    assert.equal(route.stack[2].handle, members.staffMemberWrites, "one write budget for member, team and block writes");
  }
  const source = read("routes/adminOrganizationBlockRoute.ts");
  assert.match(source, /\[authenticate, authorize\("admin", "super_admin", "superadmin"\), staffMemberWrites\]/);
  assert.match(read("server.ts"), /app\.use\("\/api\/v1", adminOrganizationBlockRoutes\);/);

  const w = setup();
  const controller = createAdminOrganizationBlockController(w.service);
  const call = async (handler, req) => {
    const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler(req, res);
    return res;
  };
  const user = { userId: STAFF, organizationId: STAFF_ORG, role: "admin", accountType: "admin" };
  // The organization comes from the path; one in the body or the query is ignored.
  const ok = await call(controller.block, { user, params: { organizationId: ACME }, body: { reason: REASON, organizationId: OTHER }, query: { organizationId: OTHER }, correlationId: "c1" });
  assert.deepEqual([ok.statusCode, ok.body], [200, { success: true, data: { organizationId: ACME, changed: true, blocked: true, blockedAt: NOW, sessionsEnded: 2 } }]);
  assert.equal(isOrganizationBlocked(w.organizations[OTHER]), false);
  const reopened = await call(controller.reactivate, { user, params: { organizationId: ACME }, body: { reason: REASON } });
  assert.deepEqual(reopened.body, { success: true, data: { organizationId: ACME, changed: true, blocked: false, blockedAt: null } });
  const noReason = await call(controller.block, { user, params: { organizationId: ACME }, body: [] });
  assert.deepEqual([noReason.statusCode, noReason.body.code], [400, "INVALID_REASON"]);
  const holding = await call(controller.block, { user, params: { organizationId: HOLDING }, body: { reason: REASON } });
  assert.deepEqual([holding.statusCode, holding.body.code, holding.body.standing], [409, "ORGANIZATION_NOT_MANAGEABLE", "legacy_holding"]);
  const customer = await call(controller.block, { user: { userId: hex("1"), organizationId: ACME, role: "customer", accountType: "planner" }, params: { organizationId: ACME }, body: { reason: REASON } });
  assert.deepEqual([customer.statusCode, customer.body.code], [403, "STAFF_ACCESS_FORBIDDEN"]);
  const anonymous = await call(controller.block, { params: { organizationId: ACME }, body: { reason: REASON } });
  assert.equal(anonymous.statusCode, 401);
  // An unexpected failure answers a fixed 500 and says nothing of what failed.
  const broken = createAdminOrganizationBlockController({ block: async () => { throw new Error("mongo: secret detail"); }, reactivate: async () => ({}) });
  const original = console.error;
  console.error = () => undefined;
  try {
    const failed = await call(broken.block, { user, params: { organizationId: ACME }, body: { reason: REASON } });
    assert.deepEqual([failed.statusCode, failed.body], [500, { success: false, code: "STAFF_ORGANIZATION_BLOCK_INTERNAL_ERROR", message: "The organization could not be changed." }]);
  } finally {
    console.error = original;
  }
});

test("customers never see it: the block's actions are staff-only and outside the customer audit catalog", () => {
  for (const action of Object.values(STAFF_ORGANIZATION_AUDIT)) {
    assert.match(action, /^platform\.organization\.(blocked|reactivated)$/);
    assert.equal(isStaffOnlyAction(action), true);
    assert.equal(VISIBLE_ACTIONS.includes(action), false);
  }
});

test("staff reads: the organization list, plan view and account detail say blocked and since when, only while blocked", async () => {
  const blockedAt = new Date("2026-11-19T09:00:00Z");
  const rows = [
    { id: ACME, name: "Acme", slug: "acme", status: "active", kind: "customer", plan: "free_trial", proposalsCreated: 0, createdAt: null, blockedAt },
    { id: OTHER, name: "Beta", slug: "beta", status: "active", kind: "customer", plan: "free_trial", proposalsCreated: 0, createdAt: null },
  ];
  const plans = createOrganizationPlanManagement({
    directory: {
      list: async () => ({ organizations: rows, total: rows.length }),
      find: async (id) => rows.find((r) => r.id === id) ?? null,
      history: async () => [], staffNames: async () => new Map(), changePlan: async () => null,
    },
    audit: { append: async () => undefined },
    isValidId: (v) => /^[a-f0-9]{24}$/.test(v),
    env: {},
  });
  const listed = await plans.list(staff(), {});
  assert.deepEqual(listed.organizations.map((o) => [o.id, o.blocked, o.blockedAt]), [[ACME, true, blockedAt], [OTHER, undefined, undefined]]);
  assert.deepEqual(Object.keys(listed.organizations[1]), ["id", "name", "slug", "status", "createdAt", "plan", "proposals", "features"], "an organization that is not blocked is listed as before");
  assert.equal(JSON.stringify(listed).includes("byStaff"), false, "who blocked it is not in the list");

  const detailOf = (record) => createOrganizationAccountDetail({
    source: {
      find: async () => ({ ...record, country: null, requireTwoFactor: false, requireSso: false, allowManagerInvites: false, autoApproveDomain: false }),
      facts: async () => ({ owner: null, memberGroups: [], pendingInvitations: 0, teams: 0, proposals: 0, domains: [], ssoStatus: null, staffAccounts: 0, activeSupportGrants: 0, twoFactorEnrolled: 0 }),
    },
    planHistory: { history: async () => [], staffNames: async () => new Map() },
    audit: { append: async () => undefined },
    isValidId: (v) => /^[a-f0-9]{24}$/.test(v),
    env: {},
  });
  const blocked = (await detailOf(rows[0]).get(staff(), ACME)).organization;
  assert.deepEqual([blocked.blocked, blocked.blockedAt], [true, blockedAt]);
  const open = (await detailOf(rows[1]).get(staff(), OTHER)).organization;
  assert.equal("blocked" in open, false);
  assert.equal("blockedAt" in open, false);
  assert.deepEqual(Object.keys(open), ["id", "name", "slug", "createdAt", "country", "status", "kind", "standing"], "an organization that is not blocked answers as before");
  // The reads take the marker through the one rule.
  for (const file of ["src/modules/entitlements/infrastructure/mongoOrganizationPlanDirectory.ts", "src/modules/entitlements/infrastructure/mongoOrganizationAccountSource.ts"]) {
    assert.match(read(file), /blockedAt: blockedSince\(doc\)/);
  }
});
