require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { hasOrganizationAction, legacyAuthorizationRoles } = require("../src/modules/identity/domain/authorizationPolicy");

test("planner can create proposals but cannot administer security", () => {
  assert.equal(hasOrganizationAction(["planner"], "proposal:write"), true);
  assert.equal(hasOrganizationAction(["planner"], "security:admin"), false);
});

test("knowledge duties remain separable", () => {
  assert.equal(hasOrganizationAction(["knowledge_editor"], "knowledge:write"), true);
  assert.equal(hasOrganizationAction(["knowledge_editor"], "knowledge:approve"), false);
  assert.equal(hasOrganizationAction(["knowledge_approver"], "knowledge:approve"), true);
});

test("legacy route guards map to membership roles during transition", () => {
  assert.deepEqual(legacyAuthorizationRoles("admin"), ["dxg_admin", "super_admin"]);
  assert.deepEqual(legacyAuthorizationRoles("superadmin"), ["super_admin"]);
});
