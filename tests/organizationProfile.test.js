const assert = require("node:assert/strict");
const test = require("node:test");

const { createOrganizationProfile } = require("../src/modules/organizationProfile/application/manageOrganizationProfile");
const {
  normalizeOrganizationName,
  parseOrganizationDetails,
} = require("../src/modules/organizationProfile/domain/organizationDetails");
const { organizationNameFor } = require("../src/modules/auth/infrastructure/mongo/customerOrganization");

const blankProfile = {
  name: "Pat's organization",
  type: null,
  industry: null,
  country: null,
  timeZone: null,
  eventsPerYear: null,
  plan: "free_trial",
  onboardingStep: "details",
};

const setup = (organization = {}) => {
  const store = new Map([["org1", { ...blankProfile, ...organization }]]);
  const audits = [];
  const service = createOrganizationProfile({
    directory: {
      find: async (id) => (store.has(id) ? { ...store.get(id) } : null),
      update: async (id, changes) => store.set(id, { ...store.get(id), ...changes }),
    },
    audit: { append: async (entry) => { audits.push(entry); } },
  });
  return { service, store, audits };
};

const actor = { organizationId: "org1", actorUserId: "u1", correlationId: "c1" };

test("organization name: trimmed, inner whitespace collapsed, 1-200 characters", () => {
  assert.equal(normalizeOrganizationName("  Acme   Events  "), "Acme Events");
  assert.equal(normalizeOrganizationName("x".repeat(200)), "x".repeat(200));
  assert.equal(normalizeOrganizationName("x".repeat(201)), null);
  assert.equal(normalizeOrganizationName("   "), null);
  assert.equal(normalizeOrganizationName(42), null);
  assert.equal(normalizeOrganizationName(undefined), null);
});

test("placeholder organization name comes from the person when no company is given", () => {
  assert.equal(organizationNameFor({ name: "Pat", company: "" }), "Pat's organization");
  assert.equal(organizationNameFor({ name: "Pat", company: " Acme " }), "Acme");
});

test("details: normalized, and fields left out stay out", () => {
  assert.deepEqual(
    parseOrganizationDetails({
      name: " Acme  Events ", type: "agency", industry: "  Live   events ", country: "us", timeZone: "America/New_York", eventsPerYear: "12",
    }),
    { ok: true, details: { name: "Acme Events", type: "agency", industry: "Live events", country: "US", timeZone: "America/New_York", eventsPerYear: 12 } },
  );
  assert.deepEqual(parseOrganizationDetails({ name: "Acme" }), { ok: true, details: { name: "Acme" } });
  assert.deepEqual(
    parseOrganizationDetails({ name: "Acme", type: "", industry: null, eventsPerYear: "" }),
    { ok: true, details: { name: "Acme", type: null, industry: null, eventsPerYear: null } },
  );
});

test("details: each bad field is named", () => {
  const field = (input) => parseOrganizationDetails({ name: "Acme", ...input }).field;
  assert.equal(parseOrganizationDetails({ name: " " }).field, "name");
  assert.equal(field({ type: "school" }), "type");
  assert.equal(field({ industry: "x".repeat(121) }), "industry");
  assert.equal(field({ country: "USA" }), "country");
  assert.equal(field({ timeZone: "Mars/Olympus" }), "timeZone");
  assert.equal(field({ eventsPerYear: -1 }), "eventsPerYear");
  assert.equal(field({ eventsPerYear: 2.5 }), "eventsPerYear");
  assert.equal(field({ eventsPerYear: 100001 }), "eventsPerYear");
  assert.equal(field({ eventsPerYear: "lots" }), "eventsPerYear");
});

test("onboarding walks details → plan → team → done, each step audited", async () => {
  const { service, store, audits } = setup();
  const details = await service.updateDetails({ ...actor, details: { name: "Acme Events", type: "agency", country: "gb" } });
  assert.equal(details.kind, "updated");
  assert.equal(details.profile.onboardingStep, "plan");
  assert.equal(store.get("org1").country, "GB");
  assert.equal(audits[0].reason, "organization_onboarding_details");
  assert.deepEqual(audits[0].metadata, { setting: "details", fields: ["name", "type", "country"] });

  const plan = await service.choosePlan({ ...actor, plan: "free_trial" });
  assert.equal(plan.profile.onboardingStep, "team");
  assert.equal(audits[1].reason, "organization_onboarding_plan");

  const done = await service.completeOnboarding(actor);
  assert.equal(done.profile.onboardingStep, "done");
  assert.equal(store.get("org1").onboardingStep, "done");
  assert.equal(audits[2].reason, "organization_onboarding_completed");
  assert.equal(audits.every((entry) => entry.action === "organization.settings.updated" && entry.actorUserId === "u1"), true);

  // Completing again is a no-op and not audited again.
  assert.equal((await service.completeOnboarding(actor)).kind, "updated");
  assert.equal(audits.length, 3);
});

test("steps cannot be skipped", async () => {
  const { service, store, audits } = setup();
  assert.deepEqual(await service.choosePlan({ ...actor, plan: "free_trial" }), { kind: "wrong_step", onboardingStep: "details" });
  assert.deepEqual(await service.completeOnboarding(actor), { kind: "wrong_step", onboardingStep: "details" });
  store.set("org1", { ...store.get("org1"), onboardingStep: "plan" });
  assert.deepEqual(await service.completeOnboarding(actor), { kind: "wrong_step", onboardingStep: "plan" });
  assert.equal(audits.length, 0);
});

test("ORG-603: choosing a plan at onboarding never replaces a plan assigned by RFPilot staff", async () => {
  const { service, store, audits } = setup({ onboardingStep: "plan", plan: "full_access" });
  const result = await service.choosePlan({ ...actor, plan: "free_trial" });
  assert.equal(result.kind, "updated");
  assert.equal(result.profile.plan, "full_access");
  assert.deepEqual({ plan: store.get("org1").plan, onboardingStep: store.get("org1").onboardingStep }, { plan: "full_access", onboardingStep: "team" });
  assert.deepEqual(audits[0].metadata, { setting: "plan", plan: "full_access", kept: true });
  // Choosing the plan already stored writes only the step, so it can't undo a staff change that
  // lands between the read and the write.
  const writes = [];
  const racing = createOrganizationProfile({
    directory: { find: async () => ({ ...blankProfile, onboardingStep: "plan" }), update: async (_id, changes) => { writes.push(changes); } },
    audit: { append: async () => {} },
  });
  await racing.choosePlan({ ...actor, plan: "free_trial" });
  assert.deepEqual(writes, [{ onboardingStep: "team" }]);
  // And an Owner still can't pick it for themselves.
  assert.deepEqual(await setup({ onboardingStep: "plan" }).service.choosePlan({ ...actor, plan: "full_access" }), { kind: "validation" });
});

test("the plan can be changed from the team step but not after onboarding", async () => {
  const team = setup({ onboardingStep: "team" });
  assert.equal((await team.service.choosePlan({ ...actor, plan: "free_trial" })).kind, "updated");
  const done = setup({ onboardingStep: "done" });
  assert.deepEqual(await done.service.choosePlan({ ...actor, plan: "free_trial" }), { kind: "wrong_step", onboardingStep: "done" });
  assert.deepEqual(await done.service.choosePlan({ ...actor, plan: "enterprise" }), { kind: "validation" });
});

test("editing details after onboarding keeps the step and is audited as an update", async () => {
  const { service, store, audits } = setup({ name: "Acme", onboardingStep: "done", industry: "Events" });
  const result = await service.updateDetails({ ...actor, details: { name: "Acme Inc" } });
  assert.equal(result.profile.onboardingStep, "done");
  assert.equal(store.get("org1").industry, "Events");
  assert.equal(audits[0].reason, "organization_details_updated");
});

test("invalid details and unknown organizations change nothing", async () => {
  const { service, store, audits } = setup();
  assert.deepEqual(await service.updateDetails({ ...actor, details: { name: "  " } }), { kind: "validation", field: "name" });
  assert.deepEqual(await service.updateDetails({ ...actor, organizationId: "nope", details: { name: "Acme" } }), { kind: "not_found" });
  assert.deepEqual(await service.completeOnboarding({ ...actor, organizationId: "nope" }), { kind: "not_found" });
  assert.deepEqual(store.get("org1"), blankProfile);
  assert.equal(audits.length, 0);
});
