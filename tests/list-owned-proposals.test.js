const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createListOwnedProposals,
} = require("../src/modules/proposals/application/listOwnedProposals");

const counts = {
  all: 8,
  draft: 2,
  live: 3,
  favorite: 1,
  expired: 1,
  archive: 1,
  saved: 1,
};

const createDependencies = (capture, overrides = {}) => ({
  proposals: {
    findOwnedById: async () => null,
    listOwned: async (input) => {
      capture.input = input;
      return {
        proposals: [
          {
            _id: "proposal-001",
            createdAt: "2026-07-15T00:00:00.000Z",
            isActive: true,
          },
        ],
        total: 1,
        counts: input.includeCounts ? counts : undefined,
      };
    },
  },
  settings: {
    findByUserId: async (userId) => {
      capture.settingsUserId = userId;
      return {
        branding: { brandName: "DXG" },
        proposals: { expiryDate: "30 days" },
      };
    },
  },
  ...overrides,
});

test("proposal list always scopes persistence by authenticated owner", async () => {
  const capture = {};
  const list = createListOwnedProposals(createDependencies(capture));

  await list({ ownerUserId: "user-123", query: {} });

  assert.equal(capture.input.ownerUserId, "user-123");
  assert.equal(capture.settingsUserId, "user-123");
});

test("list request normalizes filters, paging, search, and sort allowlist", async () => {
  const capture = {};
  const list = createListOwnedProposals(createDependencies(capture));

  await list({
    ownerUserId: "user-123",
    query: {
      favorite: "true",
      isActive: "false",
      archived: "true",
      isCopy: "true",
      isDraft: "false",
      includeCounts: "true",
      search: "  Annual Summit  ",
      page: "3",
      limit: "500",
      sortBy: "$where",
      sortOrder: "asc",
    },
  });

  assert.deepEqual(capture.input, {
    ownerUserId: "user-123",
    status: undefined,
    favorite: true,
    isActive: false,
    archived: true,
    isCopy: true,
    isDraft: false,
    includeCounts: true,
    search: "Annual Summit",
    page: 3,
    limit: 100,
    sortBy: "createdAt",
    sortOrder: "asc",
    expiryDays: 30,
  });
});

test("list response preserves pagination, counts, and settings presentation", async () => {
  const capture = {};
  const list = createListOwnedProposals(createDependencies(capture));

  const result = await list({
    ownerUserId: "user-123",
    query: { includeCounts: "true", page: "1", limit: "20" },
  });

  assert.deepEqual(result.pagination, {
    total: 1,
    page: 1,
    limit: 20,
    totalPages: 1,
  });
  assert.deepEqual(result.counts, counts);
  assert.equal(result.proposals[0].proposalSetting.branding.brandName, "DXG");
});

test("invalid boolean and paging values fall back without widening ownership", async () => {
  const capture = {};
  const list = createListOwnedProposals(createDependencies(capture));

  await list({
    ownerUserId: "user-safe",
    query: {
      favorite: "yes",
      isDraft: "sometimes",
      page: "-2",
      limit: "0",
      sortOrder: "sideways",
    },
  });

  assert.equal(capture.input.ownerUserId, "user-safe");
  assert.equal(capture.input.favorite, undefined);
  assert.equal(capture.input.isDraft, undefined);
  assert.equal(capture.input.page, 1);
  assert.equal(capture.input.limit, 20);
  assert.equal(capture.input.sortOrder, "desc");
});
