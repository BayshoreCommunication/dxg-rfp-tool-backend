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
