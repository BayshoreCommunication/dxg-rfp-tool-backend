require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createOrganizationPlanManagement,
  PlanManagementError,
  PLAN_AUDIT,
} = require("../src/modules/entitlements/application/manageOrganizationPlans");
const { createAdminOrganizationPlansController } = require("../controller/adminOrganizationPlansController");
const { ORGANIZATION_PLANS: SELF_SERVICE_PLANS } = require("../src/modules/organizationProfile/domain/organizationDetails");

// ORG-603: plan management by RFPilot staff. In-memory ports; the real-database proof is
// tests-integration/plan-management.test.ts.

const hex = (c) => c.repeat(24);
const ACME = hex("a");
const BETA = hex("b");
const HOLDING = hex("c");
const STAFF_ORG = hex("d");
const STAFF = hex("7");
const START = new Date("2026-11-10T06:00:00.000Z");

const staff = (overrides = {}) => ({ adminId: STAFF, organizationId: STAFF_ORG, role: "admin", accountType: "admin", correlationId: "corr-staff", ...overrides });

const setup = (env = {}) => {
  const rows = new Map([
    [ACME, { id: ACME, name: "Acme Events", slug: "acme-events", status: "active", kind: "customer", plan: "free_trial", proposalsCreated: 2, createdAt: START }],
    // A row from before plans existed: no plan, no counter.
    [BETA, { id: BETA, name: "Beta Travel", slug: "beta-travel", status: "active", kind: "customer", plan: null, proposalsCreated: null, createdAt: START }],
    [HOLDING, { id: HOLDING, name: "Legacy holding", slug: "legacy-1", status: "active", kind: "legacy_holding", plan: "free_trial", proposalsCreated: 0, createdAt: START }],
    [STAFF_ORG, { id: STAFF_ORG, name: "DXG", slug: "dxg", status: "active", kind: "customer", plan: "free_trial", proposalsCreated: 0, createdAt: START }],
  ]);
  const audit = [];
  const state = { raceTo: null, failAudit: false };
  let tick = 0;
  const directory = {
    async list({ search, skip, limit }) {
      const matches = [...rows.values()]
        .filter((row) => row.kind !== "legacy_holding")
        .filter((row) => !search || row.name.toLowerCase().includes(search.toLowerCase()) || row.slug.includes(search.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { organizations: matches.slice(skip, skip + limit).map((row) => ({ ...row })), total: matches.length };
    },
    async find(id) {
      return rows.has(id) ? { ...rows.get(id) } : null;
    },
    async changePlan({ organizationId, expectedPlan, plan, audit: event }) {
      const row = rows.get(organizationId);
      // Simulates another staff member changing the plan between the read and the write.
      if (state.raceTo) row.plan = state.raceTo;
      if (!row || row.kind === "legacy_holding" || row.plan !== expectedPlan) return null;
      // One transaction: an audit failure leaves the plan as it was.
      if (state.failAudit) throw new Error("audit store unavailable");
      row.plan = plan;
      audit.push({ organizationId, targetType: "organization", targetId: organizationId, decision: "allowed", createdAt: new Date(START.getTime() + ++tick * 1000), ...event });
      return { ...row };
    },
    async history(organizationId, limit) {
      return audit.filter((event) => event.organizationId === organizationId && event.action === PLAN_AUDIT.changed)
        .slice().reverse().slice(0, limit)
        .map((event) => ({ at: event.createdAt, actorId: event.actorUserId, fromPlan: event.metadata.fromPlan, toPlan: event.metadata.toPlan, note: event.metadata.note ?? null }));
    },
    async staffNames(ids) {
      return new Map(ids.filter((id) => id === STAFF).map((id) => [id, "Staff Agent"]));
    },
  };
  const management = createOrganizationPlanManagement({ directory, isValidId: (value) => /^[a-f0-9]{24}$/.test(value), env });
  return { management, rows, audit, state };
};

const rejects = (promise, code, status) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof PlanManagementError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });

test("AC: staff see each customer organization's plan and RFPs created against the limit", async () => {
  const { management } = setup();
  const result = await management.list(staff(), {});
  assert.deepEqual(result.organizations.map((o) => o.name), ["Acme Events", "Beta Travel", "DXG"], "holding tenants are not listed");
  const [acme, beta] = result.organizations;
  assert.deepEqual({ plan: acme.plan, proposals: acme.proposals, features: acme.features }, {
    plan: "free_trial",
    proposals: { created: 2, limit: 2, remaining: 0, canCreate: false },
    features: { vendorResponses: false, proposalIntelligence: false },
  });
  // No stored plan or counter reads as the free trial with nothing used.
  assert.deepEqual({ plan: beta.plan, proposals: beta.proposals }, { plan: "free_trial", proposals: { created: 0, limit: 2, remaining: 2, canCreate: true } });
  assert.deepEqual(result.plans, [
    { id: "free_trial", proposalLimit: 2, features: { vendorResponses: false, proposalIntelligence: false } },
    { id: "full_access", proposalLimit: null, features: { vendorResponses: true, proposalIntelligence: true } },
  ]);
  assert.deepEqual(result.pagination, { page: 1, perPage: 20, total: 3, totalPages: 1, hasNextPage: false, hasPrevPage: false });

  const searched = await management.list(staff(), { search: "  beta ", page: "0" });
  assert.deepEqual(searched.organizations.map((o) => o.id), [BETA]);
  assert.deepEqual(searched.filters, { search: "beta" });
});

test("the limit shown follows the configured free-trial limit", async () => {
  const { management } = setup({ PLAN_FREE_TRIAL_PROPOSAL_LIMIT: "5" });
  const { organization, plans } = await management.get(staff(), ACME);
  assert.deepEqual(organization.proposals, { created: 2, limit: 5, remaining: 3, canCreate: true });
  assert.equal(plans[0].proposalLimit, 5);
});

test("AC: changing a plan applies it and writes one audit event in that organization", async () => {
  const { management, rows, audit } = setup();
  const result = await management.change(staff(), ACME, { plan: "full_access", note: "  Paid by invoice  " });
  assert.equal(result.changed, true);
  assert.equal(rows.get(ACME).plan, "full_access");
  assert.deepEqual({ plan: result.organization.plan, proposals: result.organization.proposals, features: result.organization.features }, {
    plan: "full_access",
    proposals: { created: 2, limit: null, remaining: null, canCreate: true },
    features: { vendorResponses: true, proposalIntelligence: true },
  });
  assert.equal(audit.length, 1);
  const [event] = audit;
  assert.deepEqual(
    { organizationId: event.organizationId, actorUserId: event.actorUserId, action: event.action, targetId: event.targetId, reason: event.reason, correlationId: event.correlationId, metadata: event.metadata },
    {
      organizationId: ACME, actorUserId: STAFF, action: "organization.plan_changed", targetId: ACME, reason: "staff_plan_change", correlationId: "corr-staff",
      metadata: { fromPlan: "free_trial", toPlan: "full_access", proposalsCreated: 2, actorAccountType: "admin", actorOrganizationId: STAFF_ORG, note: "Paid by invoice" },
    },
  );
  assert.deepEqual(result.history, [{ at: event.createdAt, fromPlan: "free_trial", toPlan: "full_access", note: "Paid by invoice", changedBy: { id: STAFF, name: "Staff Agent" } }]);
});

test("a plan can be lowered again, with its own event, and the RFP count is kept", async () => {
  const { management, rows, audit } = setup();
  await management.change(staff(), ACME, { plan: "full_access" });
  const lowered = await management.change(staff({ role: "super_admin" }), ACME, { plan: "free_trial" });
  assert.equal(lowered.changed, true);
  assert.deepEqual(lowered.organization.proposals, { created: 2, limit: 2, remaining: 0, canCreate: false });
  assert.equal(rows.get(ACME).proposalsCreated, 2);
  assert.deepEqual(audit.map((e) => [e.metadata.fromPlan, e.metadata.toPlan]), [["free_trial", "full_access"], ["full_access", "free_trial"]]);
  assert.ok(!("note" in audit[1].metadata));
  assert.deepEqual(lowered.history.map((h) => h.toPlan), ["free_trial", "full_access"]);
});

test("staff can set their own organization's plan (DXG's organization at launch)", async () => {
  const { management, rows } = setup();
  assert.equal((await management.change(staff(), STAFF_ORG, { plan: "full_access" })).changed, true);
  assert.equal(rows.get(STAFF_ORG).plan, "full_access");
});

test("setting the plan an organization already has changes nothing and writes no event", async () => {
  const { management, rows, audit } = setup();
  assert.equal((await management.change(staff(), ACME, { plan: "free_trial" })).changed, false);
  // No stored plan is already the free trial.
  assert.equal((await management.change(staff(), BETA, { plan: "free_trial" })).changed, false);
  assert.equal(rows.get(BETA).plan, null);
  assert.equal(audit.length, 0);
  // Raising a row with no stored plan works and records where it came from.
  assert.equal((await management.change(staff(), BETA, { plan: "full_access" })).changed, true);
  assert.deepEqual(audit[0].metadata.fromPlan, "free_trial");
});

test("an unknown plan or a bad note is refused before anything is read or written", async () => {
  const { management, rows, audit } = setup();
  for (const plan of ["enterprise", "", null, undefined, 1, ["full_access"], "FULL_ACCESS"]) {
    await rejects(management.change(staff(), ACME, { plan }), "INVALID_PLAN", 400);
  }
  await rejects(management.change(staff(), ACME, { plan: "full_access", note: 7 }), "INVALID_PLAN_NOTE", 400);
  await rejects(management.change(staff(), ACME, { plan: "full_access", note: "x".repeat(501) }), "INVALID_PLAN_NOTE", 400);
  assert.equal(rows.get(ACME).plan, "free_trial");
  assert.equal(audit.length, 0);
});

test("a missing organization, a malformed id and a legacy holding tenant all read as not found", async () => {
  const { management, rows, audit } = setup();
  for (const id of [hex("e"), "not-an-id", "", HOLDING]) {
    await rejects(management.get(staff(), id), "ORGANIZATION_NOT_FOUND", 404);
    await rejects(management.change(staff(), id, { plan: "full_access" }), "ORGANIZATION_NOT_FOUND", 404);
  }
  assert.equal(rows.get(HOLDING).plan, "free_trial");
  assert.equal(audit.length, 0);
});

test("trust boundary: only an admin-app account with a staff role can list, read or change plans", async () => {
  const { management, rows, audit } = setup();
  const callers = [
    // A customer Owner, even of the organization itself.
    staff({ adminId: hex("1"), organizationId: ACME, role: "customer", accountType: "planner" }),
    // A `users` account that holds a staff membership role or a staff-looking account role.
    staff({ accountType: "planner" }),
    staff({ accountType: "planner", role: "super_admin" }),
    staff({ accountType: undefined }),
    // An admin-app account without a staff role.
    staff({ role: "customer" }),
    staff({ role: undefined }),
  ];
  for (const caller of callers) {
    await rejects(management.list(caller, {}), "PLAN_MANAGEMENT_FORBIDDEN", 403);
    await rejects(management.get(caller, ACME), "PLAN_MANAGEMENT_FORBIDDEN", 403);
    await rejects(management.change(caller, ACME, { plan: "full_access" }), "PLAN_MANAGEMENT_FORBIDDEN", 403);
    // Refused before the organization is looked up: a missing id says the same thing.
    await rejects(management.change(caller, hex("e"), { plan: "full_access" }), "PLAN_MANAGEMENT_FORBIDDEN", 403);
  }
  assert.equal(rows.get(ACME).plan, "free_trial");
  assert.equal(audit.length, 0);
  for (const role of ["admin", "super_admin", "superadmin", "Super-Admin"]) {
    assert.equal((await management.get(staff({ role }), ACME)).organization.id, ACME);
  }
});

test("trust boundary: full_access is not a plan an Owner can choose for themselves", () => {
  assert.deepEqual([...SELF_SERVICE_PLANS], ["free_trial"]);
});

test("a plan changed by someone else in the meantime is a conflict, and nothing is written", async () => {
  const { management, rows, audit, state } = setup();
  state.raceTo = "full_access";
  await rejects(management.change(staff(), ACME, { plan: "full_access" }), "PLAN_CHANGE_CONFLICT", 409);
  assert.equal(audit.length, 0);
  assert.equal(rows.get(ACME).plan, "full_access");
});

test("if the audit event can't be written the change fails", async () => {
  const { management, rows, state } = setup();
  state.failAudit = true;
  await assert.rejects(management.change(staff(), ACME, { plan: "full_access" }), /audit store unavailable/);
  assert.equal(rows.get(ACME).plan, "free_trial");
});

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────

const fakeResponse = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};
const request = (overrides = {}) => ({
  user: { userId: STAFF, organizationId: STAFF_ORG, role: "admin", accountType: "admin", roles: ["dxg_admin"] },
  correlationId: "corr-http", params: {}, query: {}, body: {}, ...overrides,
});

test("controller: answers data, maps errors to their status and code, and hides unexpected errors", async () => {
  const { management, audit } = setup();
  const controller = createAdminOrganizationPlansController(management);

  const listed = fakeResponse();
  await controller.list(request({ query: { search: "acme" } }), listed);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.success, true);
  assert.deepEqual(listed.body.data.organizations.map((o) => o.id), [ACME]);

  const changed = fakeResponse();
  await controller.change(request({ params: { organizationId: ACME }, body: { plan: "full_access", note: "Launch customer", organizationId: BETA, proposalsCreated: 0 } }), changed);
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.body.data.changed, true);
  assert.equal(changed.body.data.organization.id, ACME, "the organization comes from the path, not the body");
  assert.equal(changed.body.data.organization.proposals.created, 2, "the RFP count can't be set through this route");
  assert.equal(audit[0].correlationId, "corr-http");

  const invalid = fakeResponse();
  await controller.change(request({ params: { organizationId: ACME }, body: "full_access" }), invalid);
  assert.deepEqual([invalid.statusCode, invalid.body], [400, { success: false, code: "INVALID_PLAN", message: "Choose one of these plans: free_trial, full_access." }]);

  const missing = fakeResponse();
  await controller.get(request({ params: { organizationId: hex("e") } }), missing);
  assert.deepEqual([missing.statusCode, missing.body], [404, { success: false, code: "ORGANIZATION_NOT_FOUND", message: "Organization not found." }]);

  const customer = fakeResponse();
  await controller.change(request({ user: { userId: hex("1"), organizationId: ACME, role: "customer", accountType: "planner", roles: ["owner"] }, params: { organizationId: ACME }, body: { plan: "full_access" } }), customer);
  assert.equal(customer.statusCode, 403);
  assert.equal(customer.body.code, "PLAN_MANAGEMENT_FORBIDDEN");

  const anonymous = fakeResponse();
  await controller.list(request({ user: undefined }), anonymous);
  assert.equal(anonymous.statusCode, 401);

  const broken = createAdminOrganizationPlansController({ list: async () => { throw new Error("mongo exploded: secret detail"); } });
  const failed = fakeResponse();
  const originalError = console.error;
  console.error = () => {};
  try { await broken.list(request(), failed); } finally { console.error = originalError; }
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(failed.body, { success: false, code: "PLAN_MANAGEMENT_INTERNAL_ERROR", message: "The plan request could not be completed." });
});

test("routes: every plan-management route sits behind authenticate and the staff role guard", async () => {
  const router = require("../routes/adminOrganizationPlansRoute").default;
  const { authenticate } = require("../middleware/auth");
  const routes = router.stack.filter((layer) => layer.route).map((layer) => layer.route);
  assert.deepEqual(routes.map((route) => `${Object.keys(route.methods)[0].toUpperCase()} ${route.path}`), [
    "GET /admin/organization-plans",
    "GET /admin/organization-plans/:organizationId",
    "PUT /admin/organization-plans/:organizationId",
  ]);
  for (const route of routes) {
    assert.equal(route.stack[0].handle, authenticate, route.path);
    // The second layer is the role guard: it refuses every customer role and passes staff roles.
    const guard = route.stack[1].handle;
    for (const roles of [["owner"], ["organization_admin"], ["team_manager"], ["planner"], ["viewer"], ["knowledge_approver"], []]) {
      const res = fakeResponse();
      let passed = false;
      guard({ user: { roles } }, res, () => { passed = true; });
      assert.equal(passed, false, `${route.path} as ${roles}`);
      assert.equal(res.statusCode, 403);
    }
    for (const roles of [["dxg_admin"], ["super_admin"]]) {
      let passed = false;
      guard({ user: { roles } }, fakeResponse(), () => { passed = true; });
      assert.equal(passed, true, `${route.path} as ${roles}`);
    }
  }
});
