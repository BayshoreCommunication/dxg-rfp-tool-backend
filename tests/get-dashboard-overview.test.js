const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createGetOwnedDashboardOverview,
} = require("../src/modules/dashboard/application/getDashboardOverview");

test("dashboard read model always receives authenticated owner context", async () => {
  let ownerUserId;
  const expected = {
    totals: {
      totalProposals: 4,
      totalEmailSent: 10,
      totalEmailClicked: 3,
      totalProposalViews: 22,
    },
    latestProposals: [{ _id: "proposal-004" }],
  };
  const getOverview = createGetOwnedDashboardOverview({
    getOwnedOverview: async (inputOwnerUserId) => {
      ownerUserId = inputOwnerUserId;
      return expected;
    },
  });

  const result = await getOverview("user-001");

  assert.equal(ownerUserId, "user-001");
  assert.deepEqual(result, expected);
});

test("dashboard totals count the same proposals the Proposals page lists", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const repository = fs.readFileSync(path.join(__dirname, "..", "src/modules/dashboard/infrastructure/mongo/mongoDashboardReadRepository.ts"), "utf8");
  // The dashboard used to count every document (97) while the Proposals page
  // showed "All 86", because archived proposals and saved copies were only
  // excluded on the list. Both screens must use one definition.
  assert.match(repository, /isArchived: \{ \$ne: true \}/);
  assert.match(repository, /isCopy: \{ \$ne: true \}/);
  assert.match(repository, /Proposal\.countDocuments\(ownedProposals\)/);
  assert.match(repository, /Proposal\.find\(ownedProposals\)/);
  assert.match(repository, /\$match: ownedProposals/);
  assert.doesNotMatch(repository, /countDocuments\(\{ userId, organizationId \}\)/);
});
