require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");

const OrganizationDomain = require("../modal/organizationDomainModel").default;
const { mongoDomainRepository: repository } = require("../src/modules/domainVerification/infrastructure/mongo/mongoDomainRepository");

test("a sweep leases a record with a conditional update on nextCheckAt, so only one task gets it", async (t) => {
  const calls = [];
  let modifiedCount = 1;
  t.mock.method(OrganizationDomain, "updateOne", async (filter, update) => {
    calls.push({ filter, update });
    return { modifiedCount };
  });
  const now = new Date("2026-11-03T00:00:00Z");
  const leaseUntil = new Date("2026-11-03T00:05:00Z");
  const id = "507f1f77bcf86cd799439011";
  assert.equal(await repository.claimDue({ id, now, leaseUntil }), true);
  assert.deepEqual(calls, [{ filter: { _id: id, nextCheckAt: { $lte: now } }, update: { $set: { nextCheckAt: leaseUntil } } }]);
  modifiedCount = 0;
  assert.equal(await repository.claimDue({ id, now, leaseUntil }), false);
  assert.equal(await repository.claimDue({ id: "not-an-id", now, leaseUntil }), false);
  assert.equal(calls.length, 2);
});
