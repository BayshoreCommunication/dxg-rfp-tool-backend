const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PlanFeatureLockedError,
  PlanLimitReachedError,
  canCreateProposal,
  entitlementsOf,
  hasFeature,
  planIdOf,
  planTable,
} = require("../src/modules/entitlements/domain/plans");
const { createGetEntitlements, createRequirePlanFeature, respondIfPlanError } = require("../src/modules/entitlements/http/planGate");

// ORG-601: the plan table, the two entitlement decisions, the route gate, and a guard that every
// vendor-response read and every RFP intelligence route carries the gate.

const free = (proposalsCreated = 0) => ({ kind: "customer", plan: "free_trial", proposalsCreated });
const full = (proposalsCreated = 0) => ({ kind: "customer", plan: "full_access", proposalsCreated });

test("the free trial allows two RFPs and locks both features", () => {
  assert.deepEqual(planTable({}).free_trial, { proposalLimit: 2, features: { vendorResponses: false, proposalIntelligence: false } });
  assert.equal(canCreateProposal(free(0), {}), true);
  assert.equal(canCreateProposal(free(1), {}), true);
  assert.equal(canCreateProposal(free(2), {}), false);
  assert.equal(canCreateProposal(free(7), {}), false);
  assert.equal(hasFeature(free(), "vendorResponses", {}), false);
  assert.equal(hasFeature(free(), "proposalIntelligence", {}), false);
});

test("full access has no RFP limit and both features", () => {
  assert.equal(canCreateProposal(full(5000), {}), true);
  assert.equal(hasFeature(full(), "vendorResponses", {}), true);
  assert.equal(hasFeature(full(), "proposalIntelligence", {}), true);
});

test("legacy holding tenants are exempt whatever their plan says", () => {
  const holding = { kind: "legacy_holding", plan: "free_trial", proposalsCreated: 40 };
  assert.equal(canCreateProposal(holding, {}), true);
  assert.equal(hasFeature(holding, "vendorResponses", {}), true);
  assert.equal(hasFeature(holding, "proposalIntelligence", {}), true);
  assert.deepEqual(entitlementsOf(holding, {}).proposals, { created: 40, limit: null, remaining: null, canCreate: true });
  assert.equal(entitlementsOf(holding, {}).exempt, true);
});

test("an absent or unknown plan is held to the free trial", () => {
  for (const organization of [{}, { plan: null }, { plan: "enterprise" }, { plan: "FULL_ACCESS" }, { kind: "customer", plan: 7 }]) {
    assert.equal(planIdOf(organization), "free_trial");
    assert.equal(hasFeature(organization, "vendorResponses", {}), false);
    assert.equal(canCreateProposal({ ...organization, proposalsCreated: 2 }, {}), false);
  }
  // A row written before the counter existed has used nothing.
  assert.equal(canCreateProposal({ plan: "free_trial" }, {}), true);
});

test("the free-trial limit is configurable and a bad value fails loudly", () => {
  assert.equal(planTable({ PLAN_FREE_TRIAL_PROPOSAL_LIMIT: "5" }).free_trial.proposalLimit, 5);
  assert.equal(planTable({ PLAN_FREE_TRIAL_PROPOSAL_LIMIT: " " }).free_trial.proposalLimit, 2);
  assert.equal(canCreateProposal(free(4), { PLAN_FREE_TRIAL_PROPOSAL_LIMIT: "5" }), true);
  assert.equal(canCreateProposal(free(0), { PLAN_FREE_TRIAL_PROPOSAL_LIMIT: "0" }), false);
  for (const bad of ["-1", "two", "2.5", "1e3"]) {
    assert.throws(() => planTable({ PLAN_FREE_TRIAL_PROPOSAL_LIMIT: bad }), /PLAN_FREE_TRIAL_PROPOSAL_LIMIT/);
  }
});

test("the entitlement summary reports usage against the limit", () => {
  assert.deepEqual(entitlementsOf(free(1), {}), {
    plan: "free_trial",
    exempt: false,
    proposals: { created: 1, limit: 2, remaining: 1, canCreate: true },
    features: { vendorResponses: false, proposalIntelligence: false },
  });
  assert.deepEqual(entitlementsOf(free(3), {}).proposals, { created: 3, limit: 2, remaining: 0, canCreate: false });
  assert.deepEqual(entitlementsOf(full(9), {}).proposals, { created: 9, limit: null, remaining: null, canCreate: true });
});

test("plan errors say RFP, never proposal, and carry distinct codes", () => {
  const limit = new PlanLimitReachedError("free_trial", 2, 2);
  assert.equal(limit.code, "PLAN_LIMIT_REACHED");
  assert.equal(limit.status, 403);
  assert.match(limit.message, /2 RFPs/);
  for (const feature of ["vendorResponses", "proposalIntelligence"]) {
    const locked = new PlanFeatureLockedError("free_trial", feature);
    assert.equal(locked.code, "PLAN_FEATURE_LOCKED");
    assert.doesNotMatch(`${locked.message}${limit.message}`, /proposal/i);
  }
});

const fakeResponse = () => {
  const res = { statusCode: 0, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};
const run = async (gate, req) => {
  const res = fakeResponse();
  let nexted = false;
  let nextError;
  await gate(req, res, (error) => { nexted = true; nextError = error; });
  return { res, nexted, nextError };
};

test("the route gate refuses a locked feature with PLAN_FEATURE_LOCKED and lets an unlocked one through", async () => {
  const asked = [];
  const organizations = { free: free(), full: full() };
  const gateFor = createRequirePlanFeature(async (id) => { asked.push(id); return organizations[id] ?? null; });

  const locked = await run(gateFor("vendorResponses"), { user: { organizationId: "free" }, params: { id: "full" }, query: { organizationId: "full" }, body: { organizationId: "full" } });
  assert.equal(locked.nexted, false);
  assert.equal(locked.res.statusCode, 403);
  assert.deepEqual(locked.res.body, {
    success: false, code: "PLAN_FEATURE_LOCKED", status: 403,
    title: "Vendor responses aren't included in your plan. Contact us to upgrade.",
    message: "Vendor responses aren't included in your plan. Contact us to upgrade.",
    plan: "free_trial", feature: "vendorResponses",
  });
  // Only the session's organization is ever looked up, whatever the request names.
  assert.deepEqual(asked, ["free"]);

  const open = await run(gateFor("vendorResponses", "proposalIntelligence"), { user: { organizationId: "full" } });
  assert.equal(open.nexted, true);
  assert.equal(open.nextError, undefined);
  assert.equal(open.res.statusCode, 0);
});

test("a gate needing several features names the first one that is locked", async () => {
  const gateFor = createRequirePlanFeature(async () => free());
  const gate = gateFor("vendorResponses", "proposalIntelligence");
  assert.deepEqual(gate.planFeatures, ["vendorResponses", "proposalIntelligence"]);
  assert.equal((await run(gate, { user: { organizationId: "x" } })).res.body.feature, "vendorResponses");
});

test("the gate fails closed without a session organization, an organization, or a working lookup", async () => {
  const gateFor = createRequirePlanFeature(async (id) => { if (id === "boom") throw new Error("mongo down"); return null; });
  const anonymous = await run(gateFor("proposalIntelligence"), {});
  assert.equal(anonymous.res.statusCode, 401);
  assert.equal(anonymous.nexted, false);
  const missing = await run(gateFor("proposalIntelligence"), { user: { organizationId: "gone" } });
  assert.equal(missing.res.statusCode, 403);
  assert.equal(missing.nexted, false);
  const failed = await run(gateFor("proposalIntelligence"), { user: { organizationId: "boom" } });
  assert.equal(failed.nexted, true);
  assert.match(String(failed.nextError), /mongo down/);
});

test("respondIfPlanError answers plan refusals only", () => {
  const res = fakeResponse();
  assert.equal(respondIfPlanError(res, new Error("other")), false);
  assert.equal(res.statusCode, 0);
  assert.equal(respondIfPlanError(res, new PlanLimitReachedError("free_trial", 2, 2)), true);
  assert.equal(res.statusCode, 403);
  assert.deepEqual({ code: res.body.code, plan: res.body.plan, limit: res.body.limit, created: res.body.created }, { code: "PLAN_LIMIT_REACHED", plan: "free_trial", limit: 2, created: 2 });
});

test("the entitlements endpoint reports the session organization's plan", async () => {
  const read = createGetEntitlements(async (id) => (id === "org" ? free(2) : null));
  const found = fakeResponse();
  await read({ user: { organizationId: "org" } }, found);
  assert.equal(found.statusCode, 200);
  assert.deepEqual(found.body.data.proposals, { created: 2, limit: 2, remaining: 0, canCreate: false });
  const missing = fakeResponse();
  await read({ user: { organizationId: "other" } }, missing);
  assert.equal(missing.statusCode, 404);
});

// ── Route guard ──────────────────────────────────────────────────────────────────────────────
// Every route of these routers is listed with the plan features it must require. A route added
// later fails this test until it is classified, so a new read can't ship ungated by accident.

const featuresOf = (route) => {
  const gates = route.stack.map((layer) => layer.handle.planFeatures).filter(Boolean);
  return gates.flat().sort().join("+") || "open";
};
const routesOf = (modulePath) =>
  require(modulePath).default.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((method) => [`${method.toUpperCase()} ${layer.route.path}`, featuresOf(layer.route), layer.route]));

const INTELLIGENCE_ROUTERS = ["requirementRegistry", "evidenceExtraction", "vendorIntelligence", "evaluationEngine", "comparisonOrchestration"];

test("every RFP intelligence route requires the proposalIntelligence feature", () => {
  let count = 0;
  for (const name of INTELLIGENCE_ROUTERS) {
    for (const [route, features] of routesOf(`../routes/${name}Route`)) {
      assert.match(route, /\/proposals\/:proposalId\/intelligence\//, route);
      assert.equal(features, "proposalIntelligence", `${name}: ${route}`);
      count++;
    }
  }
  assert.equal(count, 48);
});

test("vendor analysis needs both features", () => {
  const routes = routesOf("../routes/vendorAnalysisRoute");
  assert.equal(routes.length, 4);
  for (const [route, features] of routes) assert.equal(features, "proposalIntelligence+vendorResponses", route);
});

test("every planner vendor-response route is classified, and reads and export are gated", () => {
  const classified = Object.fromEntries(routesOf("../routes/vendorResponseRoute").map(([route, features]) => [route, features]));
  assert.deepEqual(classified, {
    // The vendor's own submission flow, by grant: accepted and stored on every plan.
    "GET /workspace": "open",
    "GET /receipt/:versionId": "open",
    "POST /drafts": "open",
    "GET /drafts/:draftId": "open",
    "PATCH /drafts/:draftId": "open",
    "POST /drafts/:draftId/finalize": "open",
    "POST /drafts/:draftId/documents": "open",
    "DELETE /drafts/:draftId/documents/:documentId": "open",
    "DELETE /drafts/:draftId": "open",
    "POST /:submissionId/revision-drafts": "open",
    // The planner's send side, and removing stored data by id.
    "POST /questionnaires/publish": "open",
    "PATCH /questionnaires/capability": "open",
    "POST /manual": "open",
    "DELETE /": "open",
    "DELETE /:id": "open",
    // Reads and export.
    "GET /": "vendorResponses",
    "GET /proposals": "vendorResponses",
    "GET /:id/submission-detail": "vendorResponses",
    "GET /:id/submission-export": "vendorResponses",
    "GET /:id": "vendorResponses",
    "PATCH /:id/read": "vendorResponses",
  });
});

// ORG-407: the audit log is part of every plan, the free trial included.
test("every audit log route is classified as open on every plan", () => {
  assert.deepEqual(Object.fromEntries(routesOf("../routes/auditLogRoute").map(([route, features]) => [route, features])), {
    "GET /organization/audit-events": "open",
    "GET /organization/audit-events/filters": "open",
    "GET /organization/audit-events/export": "open",
  });
});

test("the gate runs after authentication and authorization on every gated route", () => {
  for (const name of [...INTELLIGENCE_ROUTERS, "vendorAnalysis", "vendorResponse"]) {
    for (const [route, features, definition] of routesOf(`../routes/${name}Route`)) {
      if (features === "open") continue;
      const handlers = definition.stack.map((layer) => layer.handle);
      const gateAt = handlers.findIndex((handle) => handle.planFeatures);
      const authAt = handlers.findIndex((handle) => handle === require("../middleware/auth").authenticate);
      assert.ok(authAt >= 0 && authAt < gateAt, `${name}: ${route} gates before authenticating`);
      assert.ok(gateAt < handlers.length - 1, `${name}: ${route} gates after its handler`);
    }
  }
});

// ORG-604: templates are not a plan feature, so no template route carries a feature gate. Starting
// an RFP from a template is limited by the RFP slot instead (createOwned), and its controller
// answers the refusal with respondIfPlanError.
test("every template route is classified: open, with the RFP limit on create-from-template", () => {
  const classified = Object.fromEntries(routesOf("../routes/proposalTemplatesRoute").map(([route, features]) => [route, features]));
  assert.deepEqual(classified, {
    "GET /proposal-templates": "open",
    "POST /proposal-templates": "open",
    "GET /proposal-templates/:templateId": "open",
    "PATCH /proposal-templates/:templateId": "open",
    "POST /proposal-templates/:templateId/publish": "open",
    "POST /proposal-templates/:templateId/unpublish": "open",
    "POST /proposal-templates/:templateId/archive": "open",
    "POST /proposal-templates/:templateId/restore": "open",
    "POST /proposal-templates/:templateId/proposals": "open",
  });
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  assert.match(read("controller/proposalTemplatesController.ts"), /respondIfPlanError\(res, error\)/);
  // The RFP is inserted by the proposals module's createOwned, which takes the plan slot.
  const author = read("src/modules/proposals/application/authorOwnedProposal.ts");
  const fromTemplate = author.slice(author.indexOf("export const createCreateProposalFromTemplate"));
  assert.match(fromTemplate, /dependencies\.proposals\.createOwned\(/);
});
