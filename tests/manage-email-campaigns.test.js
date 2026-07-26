const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createDeleteOwnedEmailCampaignById,
  createDeleteOwnedEmailCampaignsByProposal,
  createGetOwnedEmailStats,
  createListOwnedEmailCampaigns,
} = require("../src/modules/email/application/manageEmailCampaigns");

test("campaign list normalizes pagination and carries owner filters", async () => {
  let repositoryInput;
  const list = createListOwnedEmailCampaigns({
    listOwned: async (input) => {
      repositoryInput = input;
      return { campaigns: [{ _id: "campaign-001" }], total: 205 };
    },
  });

  const result = await list({
    ownerUserId: "user-001",
    query: { proposalId: "proposal-001", page: "2", limit: "500" },
  });

  assert.deepEqual(repositoryInput, {
    ownerUserId: "user-001",
    proposalId: "proposal-001",
    page: 2,
    limit: 100,
  });
  assert.deepEqual(result.pagination, {
    total: 205,
    page: 2,
    limit: 100,
    totalPages: 3,
  });
});

test("email statistics calculate stable rates and total-view alias", async () => {
  let repositoryInput;
  const stats = createGetOwnedEmailStats({
    getOwnedStats: async (input) => {
      repositoryInput = input;
      return {
        totalCampaigns: 2,
        totalRecipients: 10,
        totalSent: 8,
        totalOpened: 3,
        totalClicked: 1,
        byProposal: [{ proposalId: "proposal-001" }],
      };
    },
  });

  const result = await stats({
    ownerUserId: "user-001",
    proposalId: "proposal-001",
  });

  assert.deepEqual(repositoryInput, {
    ownerUserId: "user-001",
    proposalId: "proposal-001",
  });
  assert.equal(result.openRate, 37.5);
  assert.equal(result.clickRate, 12.5);
  assert.equal(result.totalViews, 3);
});

test("zero sent emails produce zero rates without division errors", async () => {
  const stats = createGetOwnedEmailStats({
    getOwnedStats: async () => ({
      totalCampaigns: 0,
      totalRecipients: 0,
      totalSent: 0,
      totalOpened: 0,
      totalClicked: 0,
      byProposal: [],
    }),
  });

  const result = await stats({ ownerUserId: "user-001" });

  assert.equal(result.openRate, 0);
  assert.equal(result.clickRate, 0);
});

test("proposal campaign deletion is owner-scoped and reports count", async () => {
  let repositoryInput;
  const remove = createDeleteOwnedEmailCampaignsByProposal({
    deleteOwnedByProposal: async (input) => {
      repositoryInput = input;
      return 3;
    },
  });
  const input = { ownerUserId: "user-001", proposalId: "proposal-001" };

  const result = await remove(input);

  assert.deepEqual(repositoryInput, input);
  assert.deepEqual(result, { kind: "deleted", deletedCount: 3 });
});

test("campaign-id deletion hides missing or cross-owner records", async () => {
  let repositoryInput;
  const remove = createDeleteOwnedEmailCampaignById({
    deleteOwnedById: async (input) => {
      repositoryInput = input;
      return null;
    },
  });
  const input = { ownerUserId: "user-001", campaignId: "campaign-other" };

  const result = await remove(input);

  assert.deepEqual(repositoryInput, input);
  assert.deepEqual(result, { kind: "not_found" });
});
