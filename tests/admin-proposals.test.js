require("ts-node/register/transpile-only");
const assert = require("node:assert/strict");
const test = require("node:test");

const { createGetAdminProposal, createListAdminProposals } = require("../src/modules/admin/application/listAdminProposals");

const counts = { all: 41, draft: 10, published: 30, archived: 1 };

test("proposal list normalizes paging, search and view", async () => {
  let received;
  const list = createListAdminProposals({
    async list(input) { received = input; return { proposals: [{ id: "p1" }], total: 41, counts }; },
  });
  const result = await list({ page: "0", search: "  Gala.*  ", view: "published" });
  assert.deepEqual(received, { page: 1, perPage: 20, search: "Gala.*", view: "published" });
  assert.equal(result.pagination.totalPages, 3);
  assert.equal(result.pagination.hasNextPage, true);
  assert.deepEqual(result.counts, counts);
  assert.deepEqual(result.filters, { search: "Gala.*", view: "published" });
});

test("an unknown view falls back to all proposals", async () => {
  let received;
  const list = createListAdminProposals({
    async list(input) { received = input; return { proposals: [], total: 0, counts }; },
  });
  const result = await list({ view: "everything; drop" });
  assert.equal(received.view, "all");
  assert.equal(result.pagination.totalPages, 1);
  assert.equal(result.pagination.hasPrevPage, false);
});

test("a proposal detail lookup rejects malformed ids before touching the database", async () => {
  const asked = [];
  const get = createGetAdminProposal({
    async findById(id) { asked.push(id); return { proposal: { id }, planner: null }; },
  });
  assert.equal(await get("not-an-id"), null);
  assert.equal(await get({ $ne: null }), null);
  assert.deepEqual(asked, []);
  const found = await get("6adf186c99740ffeab7ac9f6");
  assert.equal(found.proposal.id, "6adf186c99740ffeab7ac9f6");
});
