require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { hasOrganizationAction, legacyAuthorizationRoles } = require("../src/modules/identity/domain/authorizationPolicy");

test("planner can create proposals but cannot administer security", () => {
  assert.equal(hasOrganizationAction(["planner"], "proposal:write"), true);
  assert.equal(hasOrganizationAction(["planner"], "assistant:use"), true);
  assert.equal(hasOrganizationAction(["planner"], "security:admin"), false);
});

test("knowledge duties remain separable", () => {
  assert.equal(hasOrganizationAction(["knowledge_editor"], "knowledge:write"), true);
  assert.equal(hasOrganizationAction(["knowledge_editor"], "knowledge:approve"), false);
  assert.equal(hasOrganizationAction(["knowledge_editor"], "assistant:use"), false);
  assert.equal(hasOrganizationAction(["knowledge_approver"], "knowledge:approve"), true);
});

test("customer and administrator roles receive the assistant permission", () => {
  for (const role of ["planner", "organization_admin", "dxg_producer", "dxg_admin", "super_admin"]) {
    assert.equal(hasOrganizationAction([role], "assistant:use"), true, role);
  }
});

test("legacy route guards map to membership roles during transition", () => {
  assert.deepEqual(legacyAuthorizationRoles("admin"), ["dxg_admin", "super_admin"]);
  assert.deepEqual(legacyAuthorizationRoles("superadmin"), ["super_admin"]);
});

test("planner roles may record a vendor response, knowledge roles may not", () => {
  for (const role of ["planner", "organization_admin", "dxg_producer", "dxg_admin", "super_admin"]) {
    assert.equal(hasOrganizationAction([role], "vendor-response:write"), true, role);
  }
  for (const role of ["knowledge_editor", "knowledge_approver"]) {
    assert.equal(hasOrganizationAction([role], "vendor-response:write"), false, role);
  }
});
