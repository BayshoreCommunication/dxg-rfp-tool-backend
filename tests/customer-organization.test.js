require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { organizationNameFor, organizationSlugFor } = require("../src/modules/auth/infrastructure/mongo/customerOrganization");
const { legacyAuthorizationRoles } = require("../src/modules/identity/domain/authorizationPolicy");

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

test("a new organization is named after the company, or after the person", () => {
  assert.equal(organizationNameFor({ name: "Ava Chen", company: "  Acme Events " }), "Acme Events");
  assert.equal(organizationNameFor({ name: "Ava Chen", company: "" }), "Ava Chen's organization");
  assert.equal(organizationNameFor({ name: "Ava Chen" }), "Ava Chen's organization");
  assert.equal(organizationNameFor({ name: "x".repeat(300) }).length, 200);
});

test("organization slugs are valid, readable and unique", () => {
  const slugs = new Set();
  for (const name of ["Acme Events", "  Été & Co.!! ", "日本語のみ", "---", "A".repeat(80)]) {
    const slug = organizationSlugFor(name);
    assert.match(slug, SLUG, name);
    assert.ok(slug.length <= 49, name);
    slugs.add(slug);
  }
  assert.equal(slugs.size, 5);
  assert.match(organizationSlugFor("Acme Events"), /^acme-events-[0-9a-f]{8}$/);
  assert.match(organizationSlugFor("日本語のみ"), /^org-[0-9a-f]{8}$/);
  assert.notEqual(organizationSlugFor("Acme"), organizationSlugFor("Acme"));
});

test("a customer route guard no longer grants administrator or producer roles", () => {
  const roles = legacyAuthorizationRoles("customer");
  assert.deepEqual(roles, ["owner", "organization_admin", "team_manager", "planner", "viewer"]);
  assert.equal(roles.includes("dxg_producer"), false);
});
