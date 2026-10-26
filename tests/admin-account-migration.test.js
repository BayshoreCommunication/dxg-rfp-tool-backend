const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isLegacyAdminRole,
  planAdminAccountMigration,
} = require("../src/modules/identity/application/adminAccountMigration");

const candidate = (overrides = {}) => ({
  id: "u1",
  email: "Admin@Example.com",
  role: "admin",
  ownedProposals: 0,
  requestedTickets: 0,
  hasGoogleId: false,
  ...overrides,
});

test("legacy admin roles are recognized in every historical spelling", () => {
  for (const role of ["admin", "super_admin", "superadmin", "Super-Admin"]) assert.equal(isLegacyAdminRole(role), true);
  for (const role of ["customer", "", undefined]) assert.equal(isLegacyAdminRole(role), false);
});

test("a pure admin moves with its id and a normalized email", () => {
  assert.deepEqual(planAdminAccountMigration({ candidates: [candidate()], existingAdminEmails: new Set() }), [
    { kind: "move", id: "u1", email: "admin@example.com", role: "admin" },
  ]);
});

test("an account with any planner footprint is split and says why", () => {
  const [action] = planAdminAccountMigration({
    candidates: [candidate({ role: "superadmin", ownedProposals: 3, requestedTickets: 1, hasGoogleId: true })],
    existingAdminEmails: new Set(),
  });
  assert.deepEqual(action, {
    kind: "split",
    id: "u1",
    email: "admin@example.com",
    role: "superadmin",
    reasons: ["owns_proposals", "requested_support_tickets", "google_sign_in"],
  });
});

test("an operator can force a split by email", () => {
  const [action] = planAdminAccountMigration({
    candidates: [candidate()],
    existingAdminEmails: new Set(),
    forceSplitEmails: new Set(["admin@example.com"]),
  });
  assert.equal(action.kind, "split");
  assert.deepEqual(action.reasons, ["requested_split"]);
});

test("an email already in admins is skipped rather than overwritten", () => {
  assert.deepEqual(
    planAdminAccountMigration({ candidates: [candidate()], existingAdminEmails: new Set(["admin@example.com"]) }),
    [{ kind: "skip", id: "u1", email: "admin@example.com", reason: "admin_email_exists" }],
  );
});

test("planner accounts are never part of the plan", () => {
  assert.deepEqual(
    planAdminAccountMigration({ candidates: [candidate({ role: "customer", ownedProposals: 9 })], existingAdminEmails: new Set() }),
    [],
  );
});
