const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createGetAdminOverview,
} = require("../src/modules/admin/application/getAdminOverview");

test("admin overview delegates cross-collection reporting to its read port", async () => {
  const expected = {
    totals: {
      totalClients: 12,
      totalProposals: 31,
      totalEmailSent: 88,
      totalClick: 9,
    },
    latestClients: [],
  };
  let calls = 0;
  const getOverview = createGetAdminOverview({
    async getOverview() {
      calls += 1;
      return expected;
    },
  });

  assert.deepEqual(await getOverview(), expected);
  assert.equal(calls, 1);
});
