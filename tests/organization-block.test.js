require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { isOrganizationBlocked, blockedSince, ORGANIZATION_BLOCKED, ORGANIZATION_BLOCK_REVOKE_REASON, OrganizationBlockedError } = require("../src/modules/organizationBlock/domain");
const { createOrganizationBlockGate } = require("../src/modules/organizationBlock/organizationBlockGate");
const Organization = require("../modal/organizationModel").default;

// Owner decision 2026-11-18 (docs/DECISIONS.md): RFPilot staff block and reactivate a customer
// organization. This file covers the one rule (the predicate), the one lookup (the gate) and the
// marker on the model. The enforcement points are in tests/organization-block-enforcement.test.js,
// the staff routes in tests/staff-organization-block.test.js.

const hex = (c) => c.repeat(24);
const at = new Date("2026-11-19T10:00:00Z");
const marker = { at, byStaffOrganizationId: hex("d"), byStaffAccountId: hex("7") };

test("an organization is blocked only when its marker carries a real date", () => {
  assert.equal(isOrganizationBlocked({ blocked: marker }), true);
  assert.equal(blockedSince({ blocked: marker }), at);
  for (const notBlocked of [
    null, undefined, {}, { blocked: null }, { blocked: undefined }, { blocked: {} }, { blocked: { at: null } },
    { blocked: { at: "2026-11-19T10:00:00Z" } }, { blocked: { at: 1 } }, { blocked: { at: true } }, { blocked: { at: new Date("nope") } },
    { blocked: true }, { blocked: "yes" },
  ]) {
    assert.equal(isOrganizationBlocked(notBlocked), false, JSON.stringify(notBlocked));
    assert.equal(blockedSince(notBlocked), null);
  }
});

test("`status` never decides: an inactive organization without the marker is not blocked, an active one with it is", () => {
  assert.equal(isOrganizationBlocked({ status: "inactive" }), false);
  assert.equal(isOrganizationBlocked({ status: "inactive", blocked: null }), false);
  assert.equal(isOrganizationBlocked({ status: "active", blocked: marker }), true);
});

test("the marker has no default: a new organization document, and one hydrated without the field, is not blocked", () => {
  const created = new Organization({ name: "Acme", slug: "acme" });
  assert.equal(created.blocked, undefined);
  assert.equal(isOrganizationBlocked(created), false);
  assert.equal(isOrganizationBlocked(created.toObject()), false);
  assert.equal("blocked" in created.toObject(), false);
  const stored = Organization.hydrate({ _id: hex("a"), name: "Old", slug: "old", status: "inactive" });
  assert.equal(isOrganizationBlocked(stored), false);
  assert.equal(Organization.schema.path("blocked").options.default, undefined);
  // `status` is what it was: two values, default active.
  assert.deepEqual(Organization.schema.path("status").options.enum, ["active", "inactive"]);
  assert.equal(Organization.schema.path("status").options.default, "active");
});

test("the gate: one read by id, the predicate decides, an unknown organization or a non-id is not blocked", async () => {
  const asked = [];
  const rows = { [hex("a")]: { blocked: marker }, [hex("b")]: { blocked: null }, [hex("c")]: {} };
  const gate = createOrganizationBlockGate(async (id) => { asked.push(id); return rows[id] ?? null; });
  assert.equal(await gate.isBlocked(hex("a")), true);
  assert.equal(await gate.isBlocked(hex("b")), false);
  assert.equal(await gate.isBlocked(hex("c")), false);
  assert.equal(await gate.isBlocked(hex("f")), false);
  assert.deepEqual(asked, [hex("a"), hex("b"), hex("c"), hex("f")]);
  for (const bad of [undefined, null, "", "not-an-id", { $ne: null }]) assert.equal(await gate.isBlocked(bad), false);
  assert.equal(asked.length, 4, "nothing is looked up for a value that is not an id");
});

test("the gate is not cached: a block and a reactivation show on the next call", async () => {
  let row = {};
  const gate = createOrganizationBlockGate(async () => row);
  assert.equal(await gate.isBlocked(hex("a")), false);
  row = { blocked: marker };
  assert.equal(await gate.isBlocked(hex("a")), true);
  row = {};
  assert.equal(await gate.isBlocked(hex("a")), false);
});

test("a failed lookup rejects: it never answers blocked and never answers not blocked", async () => {
  const gate = createOrganizationBlockGate(async () => { throw new Error("mongo down"); });
  await assert.rejects(() => gate.isBlocked(hex("a")), /mongo down/);
});

test("what a member is told has a code and never says proposal-request jargon; the error carries it", () => {
  assert.equal(ORGANIZATION_BLOCKED.code, "ORGANIZATION_BLOCKED");
  assert.doesNotMatch(ORGANIZATION_BLOCKED.message, /RFP\b/);
  const error = new OrganizationBlockedError();
  assert.equal(error.code, "ORGANIZATION_BLOCKED");
  assert.equal(error.status, 403);
  assert.equal(ORGANIZATION_BLOCK_REVOKE_REASON, "staff_organization_blocked");
});
