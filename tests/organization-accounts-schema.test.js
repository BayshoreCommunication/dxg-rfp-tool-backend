const assert = require("node:assert/strict");
const test = require("node:test");
const Organization = require("../modal/organizationModel").default;
const {
  default: OrganizationMembership,
  CUSTOMER_ORGANIZATION_ROLES,
  LEGACY_DXG_ROLES,
  ORGANIZATION_ROLES,
} = require("../modal/organizationMembershipModel");

const objectId = "507f191e810c19729de860ea";

const membership = (roles) => new OrganizationMembership({ organizationId: objectId, userId: objectId, roles, status: "active" });

test("organization defaults put new tenants on the free trial as customers", () => {
  const organization = new Organization({ name: "Acme Events", slug: "acme-events" });
  assert.equal(organization.validateSync(), undefined);
  assert.equal(organization.kind, "customer");
  assert.equal(organization.plan, "free_trial");
  assert.equal(organization.billingStatus, "none");
  assert.equal(organization.proposalsCreated, 0);
  assert.deepEqual([...organization.verifiedDomains], []);
  assert.equal(organization.autoApproveDomain, false);
  assert.equal(organization.requireTwoFactor, false);
  assert.equal(organization.allowManagerInvites, false);
  assert.equal(organization.type, null);
});

test("organization accepts complete signup details", () => {
  const organization = new Organization({
    name: "Acme Events",
    slug: "acme-events",
    kind: "legacy_holding",
    type: "association",
    industry: "Medical",
    country: "us",
    timeZone: "America/New_York",
    eventsPerYear: 40,
    verifiedDomains: ["Acme.com", "events.acme.co.uk"],
  });
  assert.equal(organization.validateSync(), undefined);
  assert.equal(organization.country, "US");
  assert.deepEqual([...organization.verifiedDomains], ["acme.com", "events.acme.co.uk"]);
});

test("organization rejects values outside its enums and formats", () => {
  const error = new Organization({
    name: "Acme Events",
    slug: "acme-events",
    kind: "partner",
    type: "nonprofit",
    plan: "enterprise",
    billingStatus: "trialing",
    country: "USA",
    timeZone: "Mars/Olympus",
    eventsPerYear: -1,
    proposalsCreated: -1,
    verifiedDomains: ["not a domain"],
  }).validateSync();
  for (const path of ["kind", "type", "plan", "billingStatus", "country", "timeZone", "eventsPerYear", "proposalsCreated", "verifiedDomains.0"]) {
    assert.ok(error?.errors[path], `expected a validation error on ${path}`);
  }
});

test("organization rejects duplicate verified domains", () => {
  const error = new Organization({ name: "Acme", slug: "acme", verifiedDomains: ["acme.com", "ACME.com"] }).validateSync();
  assert.ok(error?.errors.verifiedDomains);
});

test("existing organization documents still load with defaults", () => {
  const organization = Organization.hydrate({ _id: objectId, name: "Legacy", slug: "legacy", status: "active" });
  assert.equal(organization.kind, "customer");
  assert.equal(organization.plan, "free_trial");
  assert.equal(organization.validateSync(), undefined);
});

test("every customer role is accepted on a new membership", () => {
  assert.deepEqual([...CUSTOMER_ORGANIZATION_ROLES], ["owner", "organization_admin", "team_manager", "planner", "viewer"]);
  for (const role of CUSTOMER_ORGANIZATION_ROLES) assert.equal(membership([role]).validateSync(), undefined, role);
});

test("new memberships refuse legacy DXG roles", () => {
  for (const role of LEGACY_DXG_ROLES) {
    const error = membership(["planner", role]).validateSync();
    assert.match(error?.errors.roles?.message ?? "", /Legacy DXG roles cannot be granted/, role);
  }
});

test("existing memberships with legacy DXG roles still load and can change other fields", () => {
  const existing = OrganizationMembership.hydrate({
    _id: objectId,
    organizationId: objectId,
    userId: objectId,
    roles: ["planner", "organization_admin", "dxg_producer"],
    status: "active",
    version: 1,
  });
  assert.equal(existing.validateSync(), undefined);
  existing.status = "suspended";
  assert.equal(existing.validateSync(), undefined);
});

test("re-granting a legacy DXG role on an existing membership is refused", () => {
  const existing = OrganizationMembership.hydrate({ _id: objectId, organizationId: objectId, userId: objectId, roles: ["planner"], status: "active", version: 1 });
  existing.roles = ["planner", "dxg_admin"];
  assert.ok(existing.validateSync()?.errors.roles);
});

test("legacy DXG roles stay in the readable enum for migration", () => {
  for (const role of LEGACY_DXG_ROLES) assert.ok(ORGANIZATION_ROLES.includes(role));
});

test("a partial unique index allows one active owner per organization", () => {
  const index = OrganizationMembership.schema.indexes().find(([, options]) => options.name === "one_active_owner_per_organization");
  assert.ok(index);
  assert.deepEqual(index[0], { organizationId: 1 });
  assert.equal(index[1].unique, true);
  assert.deepEqual(index[1].partialFilterExpression, { status: "active", roles: "owner" });
});
