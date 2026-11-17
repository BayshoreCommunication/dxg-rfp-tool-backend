require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createOrganizationAccountDetail,
  ORGANIZATION_ACCOUNT_AUDIT,
} = require("../src/modules/entitlements/application/organizationAccountDetail");
const { PlanManagementError } = require("../src/modules/entitlements/application/manageOrganizationPlans");
const { createAdminOrganizationPlansController } = require("../controller/adminOrganizationPlansController");

// Owner decision 2026-11-17: RFPilot staff read account-level information about any organization
// without a support grant, and nothing else. In-memory ports; the real-database proof is
// tests-integration/organization-account-detail.test.ts.

const hex = (c) => c.repeat(24);
const ACME = hex("a");
const HOLDING = hex("c");
const STAFF_ORG = hex("d");
const STAFF = hex("7");
const NOW = new Date("2026-11-17T09:00:00.000Z");
const at = (iso) => new Date(iso);

const staff = (overrides = {}) => ({ adminId: STAFF, organizationId: STAFF_ORG, role: "admin", accountType: "admin", correlationId: "corr-staff", ...overrides });

const row = (overrides) => ({
  status: "active", kind: "customer", plan: "free_trial", proposalsCreated: 0, createdAt: at("2026-09-01T00:00:00.000Z"),
  country: null, requireTwoFactor: false, requireSso: false, allowManagerInvites: false, autoApproveDomain: false, ...overrides,
});
const emptyFacts = () => ({
  owner: null, memberGroups: [], pendingInvitations: 0, teams: { active: 0, archived: 0 },
  proposals: { total: 0, archived: 0, lastUpdatedAt: null }, organizationTemplates: 0, vendors: { active: 0, archived: 0 },
  openSupportTickets: 0, domains: [], ssoStatus: null, staffAccounts: 0, activeGrants: [],
});

// What a careless source could hand back: the view must not pass any of it through.
const LEAKS = {
  password: "$2a$10$hash", clientId: "okta-client-id", clientSecretSealed: "sealed-secret", issuer: "https://acme.okta.example",
  verificationToken: "rfpilot-verify-abc", tokenHash: "deadbeef", members: [{ name: "Pat Planner", email: "pat@acme.example" }],
  proposalTitles: ["Annual Gala 2027"], billingStatus: "none",
};

const setup = ({ env = {}, passwordSignInEnabled } = {}) => {
  const rows = new Map([
    [ACME, row({ id: ACME, name: "Acme Events", slug: "acme-events", plan: "free_trial", proposalsCreated: 2, country: "US", requireTwoFactor: true, requireSso: true, allowManagerInvites: true, autoApproveDomain: true, ...LEAKS })],
    [HOLDING, row({ id: HOLDING, name: "Legacy holding", slug: "legacy-1", kind: "legacy_holding" })],
    [STAFF_ORG, row({ id: STAFF_ORG, name: "DXG", slug: "dxg" })],
  ]);
  const facts = new Map([
    [ACME, {
      ...emptyFacts(),
      owner: { name: "Olive Owner", email: "olive@acme.example", ...LEAKS },
      memberGroups: [
        { status: "active", roles: ["owner"], count: 1, lastSignedInAt: at("2026-11-16T10:00:00.000Z") },
        { status: "active", roles: ["planner"], count: 4, lastSignedInAt: at("2026-11-17T08:30:00.000Z") },
        { status: "active", roles: ["team_manager", "planner"], count: 1, lastSignedInAt: null },
        { status: "active", roles: ["knowledge_editor"], count: 1, lastSignedInAt: null },
        { status: "suspended", roles: ["viewer"], count: 2, lastSignedInAt: at("2026-10-01T00:00:00.000Z") },
      ],
      pendingInvitations: 3,
      teams: { active: 2, archived: 1 },
      proposals: { total: 9, archived: 4, lastUpdatedAt: at("2026-11-15T12:00:00.000Z") },
      organizationTemplates: 5,
      vendors: { active: 12, archived: 2 },
      openSupportTickets: 1,
      domains: [{ domain: "acme.example", status: "verified", ...LEAKS }, { domain: "acme-events.example", status: "pending" }],
      ssoStatus: "active",
      activeGrants: [
        { proposalId: hex("9"), expiresAt: at("2026-12-10T00:00:00.000Z") },
        { proposalId: null, expiresAt: at("2026-11-20T00:00:00.000Z") },
      ],
      ...LEAKS,
    }],
    [HOLDING, emptyFacts()],
    [STAFF_ORG, { ...emptyFacts(), staffAccounts: 2 }],
  ]);
  const planEvents = new Map([[ACME, [{ at: at("2026-11-10T06:00:00.000Z"), actorId: STAFF, fromPlan: "full_access", toPlan: "free_trial", note: "Trial ended" }]]]);
  const audit = [];
  const calls = { find: 0, facts: 0, history: 0, staffNames: 0 };
  const state = { failAudit: false };
  const detail = createOrganizationAccountDetail({
    source: {
      async find(id) { calls.find++; return rows.has(id) ? { ...rows.get(id) } : null; },
      async facts(id, now) { calls.facts++; assert.equal(now, NOW); return facts.get(id); },
    },
    planHistory: {
      async history(id, limit) { calls.history++; assert.equal(limit, 1); return (planEvents.get(id) ?? []).slice(0, limit); },
      async staffNames(ids) { calls.staffNames++; return new Map(ids.filter((id) => id === STAFF).map((id) => [id, "Staff Agent"])); },
    },
    audit: { async append(event) { if (state.failAudit) throw new Error("audit store unavailable"); audit.push(event); } },
    isValidId: (value) => /^[a-f0-9]{24}$/.test(value),
    passwordSignInEnabled,
    clock: () => NOW,
    env,
  });
  return { detail, audit, calls, state, facts, rows };
};

const rejects = (promise, code, status) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof PlanManagementError, String(error));
    assert.deepEqual([error.code, error.status], [code, status]);
    return true;
  });

test("staff read an organization's account: identity, Owner, plan, counts, security, activity and support access", async () => {
  const { detail } = setup();
  assert.deepEqual(await detail.get(staff(), ACME), {
    organization: { id: ACME, name: "Acme Events", slug: "acme-events", createdAt: at("2026-09-01T00:00:00.000Z"), country: "US", status: "active", kind: "customer", standing: "active" },
    owner: { name: "Olive Owner", email: "olive@acme.example" },
    plan: {
      plan: "free_trial", exempt: false,
      proposals: { created: 2, limit: 2, remaining: 0, canCreate: false },
      features: { vendorResponses: false, proposalIntelligence: false },
      lastChange: { at: at("2026-11-10T06:00:00.000Z"), fromPlan: "full_access", toPlan: "free_trial", changedBy: { id: STAFF, name: "Staff Agent" } },
    },
    counts: {
      members: {
        active: 7, deactivated: 2, pendingInvitations: 3,
        // A member with two roles counts under each; one with no customer role counts under `other`.
        byRole: { owner: 1, organization_admin: 0, team_manager: 1, planner: 5, viewer: 0, other: 1 },
      },
      teams: { active: 2, archived: 1 },
      proposals: { total: 9, archived: 4 },
      organizationTemplates: 5,
      vendorListEntries: { active: 12, archived: 2 },
      openSupportTickets: 1,
    },
    security: {
      signInMethods: ["password", "google", "microsoft", "company_sso"],
      requireTwoFactor: true,
      companySso: { configured: true, enabled: true, required: true, type: "oidc" },
      domains: [{ domain: "acme.example", status: "verified" }, { domain: "acme-events.example", status: "pending" }],
      autoApproveDomain: true,
      allowManagerInvites: true,
    },
    activity: { lastSignInAt: at("2026-11-17T08:30:00.000Z"), lastProposalUpdateAt: at("2026-11-15T12:00:00.000Z") },
    // An organization-wide grant decides the scope and the expiry, even when an RFP grant lasts longer.
    supportAccess: { active: true, scope: "organization", activeGrants: 2, expiresAt: at("2026-11-20T00:00:00.000Z") },
  });
});

test("allowlist: nothing a source returns beyond the listed fields reaches the response", async () => {
  const { detail } = setup();
  const json = JSON.stringify(await detail.get(staff(), ACME));
  for (const leaked of ["$2a$10$hash", "okta-client-id", "sealed-secret", "okta.example", "rfpilot-verify-abc", "deadbeef", "Pat Planner", "pat@acme.example", "Annual Gala 2027", "billingStatus", "note", "Trial ended", hex("9")]) {
    assert.ok(!json.includes(leaked), leaked);
  }
  // The Owner's is the only email address in the response.
  assert.deepEqual(json.match(/[\w.+-]+@[\w.-]+/g), ["olive@acme.example"]);
});

test("an organization with nothing yet: zero counts, no Owner, no plan change, no grant", async () => {
  const { detail, facts, rows } = setup({ passwordSignInEnabled: () => false });
  rows.set(ACME, row({ id: ACME, name: "Acme Events", slug: "acme-events", plan: null, proposalsCreated: null, createdAt: null }));
  facts.set(ACME, { ...emptyFacts(), ssoStatus: "draft", activeGrants: [{ proposalId: hex("9"), expiresAt: at("2026-11-18T00:00:00.000Z") }, { proposalId: hex("8"), expiresAt: at("2026-11-25T00:00:00.000Z") }] });
  const result = await detail.get(staff({ role: "super_admin" }), ACME);
  assert.equal(result.owner, null);
  assert.deepEqual(result.organization, { id: ACME, name: "Acme Events", slug: "acme-events", createdAt: null, country: null, status: "active", kind: "customer", standing: "active" });
  assert.deepEqual(result.counts.members, { active: 0, deactivated: 0, pendingInvitations: 0, byRole: { owner: 0, organization_admin: 0, team_manager: 0, planner: 0, viewer: 0, other: 0 } });
  assert.deepEqual(result.activity, { lastSignInAt: null, lastProposalUpdateAt: null });
  // A draft connection is configured but not a way to sign in; password sign-in is off platform-wide here.
  assert.deepEqual(result.security.signInMethods, ["google", "microsoft"]);
  assert.deepEqual(result.security.companySso, { configured: true, enabled: false, required: false, type: "oidc" });
  // RFP grants only: the scope says so and the latest expiry is shown.
  assert.deepEqual(result.supportAccess, { active: true, scope: "rfp", activeGrants: 2, expiresAt: at("2026-11-25T00:00:00.000Z") });
});

test("standing: a legacy holding tenant awaits placement, RFPilot's own organization is the platform, an inactive one says so", async () => {
  const { detail, rows } = setup();
  const holding = await detail.get(staff(), HOLDING);
  assert.deepEqual([holding.organization.kind, holding.organization.standing], ["legacy_holding", "awaiting_placement"]);
  // Holding tenants are exempt from plans: no limit, every feature.
  assert.deepEqual(holding.plan, {
    plan: "free_trial", exempt: true, proposals: { created: 0, limit: null, remaining: null, canCreate: true },
    features: { vendorResponses: true, proposalIntelligence: true }, lastChange: null,
  });
  assert.deepEqual(holding.security.companySso, { configured: false, enabled: false, required: false, type: null });
  assert.deepEqual(holding.supportAccess, { active: false, scope: null, activeGrants: 0, expiresAt: null });

  assert.equal((await detail.get(staff(), STAFF_ORG)).organization.standing, "platform");

  rows.get(ACME).status = "inactive";
  const inactive = await detail.get(staff(), ACME);
  assert.deepEqual([inactive.organization.status, inactive.organization.standing], ["inactive", "inactive"]);
});

test("the plan limit follows the configured plan table", async () => {
  const { detail } = setup({ env: { PLAN_FREE_TRIAL_PROPOSAL_LIMIT: "5" } });
  assert.deepEqual((await detail.get(staff(), ACME)).plan.proposals, { created: 2, limit: 5, remaining: 3, canCreate: true });
});

test("staff only: a customer Owner and a `users` account holding a staff role are refused before anything is read", async () => {
  const { detail, audit, calls } = setup();
  for (const caller of [
    staff({ role: "customer", accountType: "planner" }),
    staff({ role: "admin", accountType: "planner" }),
    staff({ role: "super_admin", accountType: "user" }),
    staff({ role: "planner", accountType: "admin" }),
    staff({ role: undefined, accountType: undefined }),
  ]) {
    await rejects(detail.get(caller, ACME), "PLAN_MANAGEMENT_FORBIDDEN", 403);
  }
  assert.deepEqual(calls, { find: 0, facts: 0, history: 0, staffNames: 0 });
  assert.deepEqual(audit, []);
});

test("a malformed id is a 400 and an unknown organization a 404; neither reads facts or writes an event", async () => {
  const { detail, audit, calls } = setup();
  for (const id of ["not-an-id", "", "../support", `${ACME}0`, "{\"$ne\":null}"]) {
    await rejects(detail.get(staff(), id), "INVALID_ORGANIZATION_ID", 400);
  }
  assert.equal(calls.find, 0);
  await rejects(detail.get(staff(), hex("e")), "ORGANIZATION_NOT_FOUND", 404);
  assert.deepEqual([calls.facts, calls.history], [0, 0]);
  assert.deepEqual(audit, []);
});

test("audit: each read writes one event in the staff organization, none in the customer's, and fails closed", async () => {
  const { detail, audit, calls, state } = setup();
  await detail.get(staff(), ACME);
  assert.deepEqual(audit, [{
    organizationId: STAFF_ORG, actorUserId: STAFF, action: ORGANIZATION_ACCOUNT_AUDIT.read, targetType: "organization", targetId: ACME,
    decision: "allowed", reason: "organization_account_detail", correlationId: "corr-staff", metadata: { agentAccountType: "admin" },
  }]);
  assert.equal(ORGANIZATION_ACCOUNT_AUDIT.read, "platform.organization_account.read");

  state.failAudit = true;
  const factsBefore = calls.facts;
  await assert.rejects(detail.get(staff(), ACME), /audit store unavailable/);
  assert.equal(calls.facts, factsBefore, "nothing is read once the event can't be written");
});

test("the read is not in the customer audit catalog, so it can never appear in an organization's audit log", () => {
  const { AUDIT_CATALOG } = require("../src/modules/auditLog/domain");
  assert.ok(!JSON.stringify(AUDIT_CATALOG).includes(ORGANIZATION_ACCOUNT_AUDIT.read));
});

// ── Mongo source ─────────────────────────────────────────────────────────────────────────────

test("the Mongo source names the organization in every query and selects no customer content", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/entitlements/infrastructure/mongoOrganizationAccountSource.ts"), "utf8");
  const calls = [...source.matchAll(/\b([A-Z]\w+)\.(find|findOne|countDocuments|aggregate)(?:<[^(]*>)?\(/g)];
  // 14 queries: the organization row, then thirteen for the facts (the Owner takes two). With the
  // last plan change (one, plus one for the staff name) a request runs at most 16 reads.
  assert.equal(calls.length, 14);
  for (const call of calls) {
    const rest = source.slice(call.index, call.index + 420);
    const scoped = /organizationId: id\b/.test(rest) || (call[1] === "Organization" && /_id: oid\(organizationId\)/.test(rest)) || (call[1] === "User" && /_id: membership\.userId/.test(rest));
    assert.ok(scoped, `${call[1]}.${call[2]} must name the organization`);
  }
  // Rows are selected from four collections only, each with an explicit field list.
  const selects = [...source.matchAll(/\.select\(("[^"]+"|FIELDS)\)/g)].map((match) => match[1]);
  assert.deepEqual(selects, ['"userId"', '"name email"', "FIELDS", '"domain status"', '"status"', '"proposalId expiresAt"']);
  for (const forbidden of ["clientId", "clientSecretSealed", "issuer", "verificationToken", "tokenHash", "password", "contacts", "content", "subject", "eventName", "reason"]) {
    assert.ok(!new RegExp(`["\\s.]${forbidden}\\b`).test(source.replace(/\/\*[\s\S]*?\*\//g, "")), forbidden);
  }
  for (const model of ["Proposal", "ProposalTemplate", "OrganizationVendor", "SupportTicket", "Team", "Invitation"]) {
    assert.ok(!new RegExp(`\\b${model}\\.(find|findOne)\\(`).test(source), `${model} is only counted`);
  }
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
const unusedManagement = { list: async () => assert.fail("unused"), get: async () => assert.fail("unused"), change: async () => assert.fail("unused") };

test("controller: answers the detail for `admins` staff and maps refusals to their status and code", async () => {
  const { detail, audit } = setup();
  const controller = createAdminOrganizationPlansController(unusedManagement, detail);

  const ok = fakeResponse();
  await controller.account(request({ params: { organizationId: ACME }, query: { organizationId: HOLDING }, body: { organizationId: HOLDING } }), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.success, true);
  assert.equal(ok.body.data.organization.id, ACME, "the organization comes from the path");
  assert.deepEqual(Object.keys(ok.body.data), ["organization", "owner", "plan", "counts", "security", "activity", "supportAccess"]);
  assert.deepEqual([audit[0].organizationId, audit[0].actorUserId, audit[0].correlationId], [STAFF_ORG, STAFF, "corr-http"]);

  const invalid = fakeResponse();
  await controller.account(request({ params: { organizationId: "nope" } }), invalid);
  assert.deepEqual([invalid.statusCode, invalid.body], [400, { success: false, code: "INVALID_ORGANIZATION_ID", message: "That is not an organization id." }]);

  const missing = fakeResponse();
  await controller.account(request({ params: { organizationId: hex("e") } }), missing);
  assert.deepEqual([missing.statusCode, missing.body], [404, { success: false, code: "ORGANIZATION_NOT_FOUND", message: "Organization not found." }]);

  // A customer Owner asking about their own organization.
  const owner = fakeResponse();
  await controller.account(request({ user: { userId: hex("1"), organizationId: ACME, role: "customer", accountType: "planner", roles: ["owner"] }, params: { organizationId: ACME } }), owner);
  assert.deepEqual([owner.statusCode, owner.body.code, owner.body.data], [403, "PLAN_MANAGEMENT_FORBIDDEN", undefined]);

  // A `users` account that holds a staff membership role and an administrative account role.
  const impostor = fakeResponse();
  await controller.account(request({ user: { userId: hex("2"), organizationId: STAFF_ORG, role: "admin", accountType: "planner", roles: ["dxg_admin"] }, params: { organizationId: ACME } }), impostor);
  assert.deepEqual([impostor.statusCode, impostor.body.code, impostor.body.data], [403, "PLAN_MANAGEMENT_FORBIDDEN", undefined]);

  const anonymous = fakeResponse();
  await controller.account(request({ user: undefined, params: { organizationId: ACME } }), anonymous);
  assert.equal(anonymous.statusCode, 401);
  assert.equal(audit.length, 1);

  const broken = createAdminOrganizationPlansController(unusedManagement, { get: async () => { throw new Error("mongo exploded: secret detail"); } });
  const failed = fakeResponse();
  const originalError = console.error;
  console.error = () => {};
  try { await broken.account(request({ params: { organizationId: ACME } }), failed); } finally { console.error = originalError; }
  assert.equal(failed.statusCode, 500);
  assert.ok(!JSON.stringify(failed.body).includes("secret detail"));
});

test("route: the detail sits behind authenticate and the staff role guard, and is read-only", async () => {
  const router = require("../routes/adminOrganizationPlansRoute").default;
  const { authenticate } = require("../middleware/auth");
  const routes = router.stack.filter((layer) => layer.route).map((layer) => layer.route).filter((route) => route.path.startsWith("/admin/organizations"));
  assert.deepEqual(routes.map((route) => `${Object.keys(route.methods).join(",").toUpperCase()} ${route.path}`), ["GET /admin/organizations/:organizationId"]);
  const [route] = routes;
  assert.equal(route.stack[0].handle, authenticate);
  const guard = route.stack[1].handle;
  for (const roles of [["owner"], ["organization_admin"], ["team_manager"], ["planner"], ["viewer"], ["knowledge_approver"], []]) {
    const res = fakeResponse();
    let passed = false;
    guard({ user: { roles } }, res, () => { passed = true; });
    assert.equal(passed, false, `as ${roles}`);
    assert.equal(res.statusCode, 403);
  }
  for (const roles of [["dxg_admin"], ["super_admin"]]) {
    let passed = false;
    guard({ user: { roles } }, fakeResponse(), () => { passed = true; });
    assert.equal(passed, true, `as ${roles}`);
  }
});
