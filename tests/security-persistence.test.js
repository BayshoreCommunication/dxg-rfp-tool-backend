const assert = require("node:assert/strict");
const test = require("node:test");
const OrganizationMembership = require("../modal/organizationMembershipModel").default;
const PublicAccessGrant = require("../modal/publicAccessGrantModel").default;
const RefreshSession = require("../modal/refreshSessionModel").default;
const { legacyRoleToMembershipRoles } = require("../src/modules/identity/application/membershipMigration");

const objectId = "507f191e810c19729de860ea";

test("legacy roles map to the approved organization roles", () => {
  assert.deepEqual(legacyRoleToMembershipRoles("customer"), ["planner"]);
  assert.deepEqual(legacyRoleToMembershipRoles("admin"), ["dxg_admin"]);
  assert.deepEqual(legacyRoleToMembershipRoles("superadmin"), ["super_admin"]);
});

test("membership requires at least one unique approved role", () => {
  const membership = new OrganizationMembership({
    organizationId: objectId,
    userId: objectId,
    roles: [],
    status: "active",
  });
  const error = membership.validateSync();
  assert.ok(error?.errors.roles);
});

test("refresh token hashes are hidden from default projections", () => {
  const path = RefreshSession.schema.path("tokenHash");
  assert.equal(path.options.select, false);
  assert.equal(path.options.unique, true);
});

test("public grants reject unsupported purposes and invalid use limits", () => {
  const grant = new PublicAccessGrant({
    organizationId: objectId,
    resourceType: "proposal",
    resourceId: objectId,
    purpose: "admin:all",
    tokenHash: "hash",
    createdByUserId: objectId,
    expiresAt: new Date(Date.now() + 60_000),
    maxUses: 0,
  });
  const error = grant.validateSync();
  assert.ok(error?.errors.purpose);
  assert.ok(error?.errors.maxUses);
});
