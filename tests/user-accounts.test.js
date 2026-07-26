const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createDeleteUser,
  createGetPrimaryAdmin,
  createGetUser,
  createListUsers,
  createUpdatePrimaryAdmin,
  createUpdateUserProfile,
} = require("../src/modules/users/application/manageUserAccounts");

test("user directory is restricted to privileged roles", async () => {
  let reads = 0;
  const list = createListUsers({ async list() { reads += 1; return []; } });
  assert.deepEqual(await list("customer"), { kind: "forbidden" });
  assert.equal(reads, 0);
  assert.deepEqual(await list("super-admin"), { kind: "found", users: [] });
  assert.equal(reads, 1);
});

test("user read enforces self-or-admin access before persistence", async () => {
  let reads = 0;
  const get = createGetUser({ async findById() { reads += 1; return null; } });
  assert.deepEqual(await get("a", "customer", "b"), { kind: "forbidden" });
  assert.equal(reads, 0);
  assert.deepEqual(await get("a", "admin", "b"), { kind: "not_found" });
  assert.equal(reads, 1);
});

test("primary-admin read supports configured target and privileged access", async () => {
  let configured;
  const get = createGetPrimaryAdmin({
    async findPrimaryAdmin(email) {
      configured = email;
      return { id: "primary", email, role: "admin", data: { id: "primary" } };
    },
  });
  assert.deepEqual(await get("other", "customer", "admin@example.com"), { kind: "forbidden" });
  assert.equal(configured, "admin@example.com");
  assert.deepEqual(await get("other", "super_admin", "admin@example.com"), {
    kind: "found", user: { id: "primary" },
  });
});

test("profile update checks normalized email conflict before password hashing", async () => {
  let hashes = 0;
  let conflictEmail;
  const update = createUpdateUserProfile({
    async findById() { return { id: "u", email: "old@example.com", data: {} }; },
    async emailBelongsToOther(email) { conflictEmail = email; return true; },
  }, { async hash() { hashes += 1; return "hash"; } });
  assert.deepEqual(await update("u", "customer", "u", {
    email: " USED@EXAMPLE.COM ", password: "new-password",
  }), { kind: "email_conflict" });
  assert.equal(conflictEmail, "used@example.com");
  assert.equal(hashes, 0);
});

test("profile password update persists exactly one application hash", async () => {
  let hashes = 0;
  let persisted;
  const update = createUpdateUserProfile({
    async findById() { return { id: "u", email: "old@example.com", data: {} }; },
    async update(_id, patch) { persisted = patch; return { id: "u" }; },
  }, { async hash(password) { hashes += 1; assert.equal(password, "new-password"); return "one-hash"; } });
  assert.deepEqual(await update("u", "customer", "u", {
    password: "new-password", phone: "123", role: "admin", isBlocked: true,
  }), { kind: "updated", user: { id: "u" } });
  assert.equal(hashes, 1);
  assert.deepEqual(persisted, { phone: "123", passwordHash: "one-hash" });
});

test("profile update rejects a short password before hashing or persistence", async () => {
  let hashes = 0;
  let writes = 0;
  const update = createUpdateUserProfile({
    async findById() { return { id: "u", email: "old@example.com", data: {} }; },
    async update() { writes += 1; },
  }, { async hash() { hashes += 1; return "hash"; } });
  assert.deepEqual(await update("u", "customer", "u", { password: "123" }), {
    kind: "invalid_password",
  });
  assert.equal(hashes, 0);
  assert.equal(writes, 0);
});

test("primary-admin update is restricted to the primary account", async () => {
  let writes = 0;
  const update = createUpdatePrimaryAdmin({
    async findPrimaryAdmin() { return { id: "primary", email: "a@b.com", data: {} }; },
    async update() { writes += 1; return {}; },
  }, { async hash() { return "hash"; } });
  assert.deepEqual(await update("other", "a@b.com", { name: "No" }), { kind: "forbidden" });
  assert.equal(writes, 0);
});

test("user deletion protects self and requires a privileged actor", async () => {
  let deletes = 0;
  const remove = createDeleteUser({ async deleteById() { deletes += 1; return true; } });
  assert.deepEqual(await remove("a", "admin", "a"), { kind: "self_delete" });
  assert.deepEqual(await remove("a", "customer", "b"), { kind: "forbidden" });
  assert.equal(deletes, 0);
  assert.deepEqual(await remove("a", "admin", "b"), { kind: "deleted" });
  assert.equal(deletes, 1);
});
