const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createCreateAdminUser,
  createDeleteAdminUser,
  createUpdateAdminUser,
} = require("../src/modules/admin/application/manageAdminUsers");

test("admin creation validates and normalizes before persistence", async () => {
  let existsEmail;
  let created;
  const create = createCreateAdminUser({
    async emailExists(email) { existsEmail = email; return false; },
    async create(input) { created = input; return { id: "a", ...input, password: undefined }; },
  });
  assert.deepEqual(await create({ name: " ", email: "x", password: "12345678", role: "admin" }), {
    kind: "validation", code: "required",
  });
  const result = await create({
    name: "  Admin One ", email: " ADMIN@EXAMPLE.COM ", password: " secret-01 ", role: "admin",
  });
  assert.equal(result.kind, "created");
  assert.equal(existsEmail, "admin@example.com");
  assert.deepEqual(created, {
    name: "Admin One", email: "admin@example.com", password: "secret-01", role: "admin",
  });
});

test("admin creation reports normalized email conflicts", async () => {
  const create = createCreateAdminUser({
    async emailExists(email) { assert.equal(email, "used@example.com"); return true; },
  });
  assert.deepEqual(await create({
    name: "Admin", email: " USED@example.com ", password: "12345678", role: "super_admin",
  }), { kind: "email_conflict" });
});

test("admin update rejects non-admin targets and invalid changes", async () => {
  let updates = 0;
  const update = createUpdateAdminUser({
    async findById() { return { id: "u", role: "customer" }; },
    async update() { updates += 1; },
  }, { async hash() { throw new Error("must not hash"); } });
  assert.deepEqual(await update("u", { password: "12345678" }), { kind: "non_admin_target" });
  assert.equal(updates, 0);
});

test("admin password update hashes once at the application security port", async () => {
  let hashes = 0;
  let patch;
  const update = createUpdateAdminUser({
    async findById() { return { id: "a", role: "admin" }; },
    async update(_id, value) { patch = value; return { id: "a" }; },
  }, {
    async hash(password) { hashes += 1; assert.equal(password, "newpass-1"); return "hashed-once"; },
  });
  assert.deepEqual(await update("a", { password: " newpass-1 ", phone: " 123 " }), {
    kind: "updated", user: { id: "a" },
  });
  assert.equal(hashes, 1);
  assert.deepEqual(patch, { phone: "123", passwordHash: "hashed-once" });
});

test("admin deletion protects the actor before repository access", async () => {
  let reads = 0;
  const remove = createDeleteAdminUser({
    async findById() { reads += 1; return null; },
  });
  assert.deepEqual(await remove("same", "same"), { kind: "self_delete" });
  assert.equal(reads, 0);
});
