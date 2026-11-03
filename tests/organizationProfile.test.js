const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createOrganizationProfile,
  normalizeOrganizationName,
} = require("../src/modules/organizationProfile/application/manageOrganizationProfile");
const { organizationNameFor } = require("../src/modules/auth/infrastructure/mongo/customerOrganization");

const setup = (organization = { name: "Pat's organization", needsName: true }) => {
  const store = new Map([["org1", { ...organization }]]);
  const audits = [];
  const service = createOrganizationProfile({
    directory: {
      find: async (id) => (store.has(id) ? { ...store.get(id) } : null),
      rename: async (id, name) => store.set(id, { name, needsName: false }),
    },
    audit: { append: async (entry) => { audits.push(entry); } },
  });
  return { service, store, audits };
};

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

test("profile reports the name and whether it still needs one", async () => {
  const { service } = setup();
  assert.deepEqual(await service.profile("org1"), { name: "Pat's organization", needsName: true });
  assert.equal(await service.profile("missing"), null);
});

test("naming the organization clears needsName and is audited", async () => {
  const { service, store, audits } = setup();
  const result = await service.rename({ organizationId: "org1", actorUserId: "u1", name: " Acme Events ", correlationId: "c1" });
  assert.deepEqual(result, { kind: "updated", name: "Acme Events", needsName: false });
  assert.deepEqual(store.get("org1"), { name: "Acme Events", needsName: false });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].reason, "organization_named");
  assert.equal(audits[0].actorUserId, "u1");
  assert.deepEqual(audits[0].metadata, { setting: "name" });
});

test("a later rename is audited as a rename", async () => {
  const { service, audits } = setup({ name: "Acme", needsName: false });
  await service.rename({ organizationId: "org1", actorUserId: "u1", name: "Acme Inc", correlationId: "c1" });
  assert.equal(audits[0].reason, "organization_renamed");
});

test("invalid names and unknown organizations change nothing", async () => {
  const { service, store, audits } = setup();
  assert.deepEqual(await service.rename({ organizationId: "org1", actorUserId: "u1", name: "  ", correlationId: "c" }), { kind: "validation" });
  assert.deepEqual(await service.rename({ organizationId: "nope", actorUserId: "u1", name: "Acme", correlationId: "c" }), { kind: "not_found" });
  assert.deepEqual(store.get("org1"), { name: "Pat's organization", needsName: true });
  assert.equal(audits.length, 0);
});
