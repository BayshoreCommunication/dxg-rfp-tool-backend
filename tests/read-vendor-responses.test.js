const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createGetOwnedVendorResponse,
  createListOwnedVendorResponses,
} = require("../src/modules/vendorResponses/application/readVendorResponses");

test("vendor-response list normalizes filters and carries planner ownership", async () => {
  let repositoryInput;
  const list = createListOwnedVendorResponses({
    listOwned: async (input) => {
      repositoryInput = input;
      return { responses: [{ _id: "response-001" }], total: 45, unreadCount: 3 };
    },
  });

  const result = await list({
    ownerUserId: "planner-001",
    query: {
      page: "2",
      limit: "500",
      unreadOnly: "true",
      proposalId: "proposal-001",
      campaignId: "campaign-001",
    },
  });

  assert.deepEqual(repositoryInput, {
    ownerUserId: "planner-001",
    unreadOnly: true,
    proposalId: "proposal-001",
    campaignId: "campaign-001",
    page: 2,
    limit: 100,
  });
  assert.deepEqual(result.pagination, {
    total: 45,
    page: 2,
    limit: 100,
    totalPages: 1,
  });
  assert.equal(result.unreadCount, 3);
});

test("invalid vendor-response paging uses safe defaults", async () => {
  let repositoryInput;
  const list = createListOwnedVendorResponses({
    listOwned: async (input) => {
      repositoryInput = input;
      return { responses: [], total: 0, unreadCount: 0 };
    },
  });

  await list({
    ownerUserId: "planner-001",
    query: { page: "-3", limit: "0", unreadOnly: "yes" },
  });

  assert.equal(repositoryInput.ownerUserId, "planner-001");
  assert.equal(repositoryInput.page, 1);
  assert.equal(repositoryInput.limit, 20);
  assert.equal(repositoryInput.unreadOnly, false);
});

test("vendor-response detail read is owner-scoped and hides cross-owner records", async () => {
  let repositoryInput;
  const getResponse = createGetOwnedVendorResponse({
    markOwnedRead: async (input) => {
      repositoryInput = input;
      return null;
    },
  });

  const result = await getResponse({
    responseId: "response-other-owner",
    ownerUserId: "planner-001",
  });

  assert.deepEqual(repositoryInput, {
    responseId: "response-other-owner",
    ownerUserId: "planner-001",
  });
  assert.deepEqual(result, { kind: "not_found" });
});
