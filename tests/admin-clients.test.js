const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createDeleteAdminClient,
  createListAdminClients,
  createSetClientBlocked,
} = require("../src/modules/admin/application/manageAdminClients");

test("client list normalizes paging and preserves escaped-search boundary", async () => {
  let received;
  const list = createListAdminClients({
    async list(input) { received = input; return { clients: [{ id: "1" }], total: 11 }; },
  });
  const result = await list({ page: "bad", search: "  Acme.*  " });
  assert.deepEqual(received, { page: 1, perPage: 10, search: "Acme.*" });
  assert.equal(result.pagination.totalPages, 2);
  assert.equal(result.pagination.hasNextPage, true);
});

test("client block rejects administrative targets before mutation", async () => {
  let mutated = false;
  const block = createSetClientBlocked({
    async findById() { return { id: "a", role: "super-admin" }; },
    async setBlocked() { mutated = true; },
  });
  assert.deepEqual(await block("a", true), { kind: "admin_target" });
  assert.equal(mutated, false);
});

test("client block returns the persisted status", async () => {
  const block = createSetClientBlocked({
    async findById() { return { id: "c", role: "customer" }; },
    async setBlocked(id, isBlocked) { return { id, role: "customer", isBlocked }; },
  });
  assert.deepEqual(await block("c", true), { kind: "updated", id: "c", isBlocked: true });
});

test("client deletion distinguishes missing, admin, and deleted targets", async () => {
  let target = null;
  let deleted;
  const remove = createDeleteAdminClient({
    async findById() { return target; },
    async deleteById(id) { deleted = id; },
  });
  assert.deepEqual(await remove("x"), { kind: "not_found" });
  target = { id: "x", role: "admin" };
  assert.deepEqual(await remove("x"), { kind: "admin_target" });
  target = { id: "x", role: "customer" };
  assert.deepEqual(await remove("x"), { kind: "deleted", id: "x" });
  assert.equal(deleted, "x");
});
