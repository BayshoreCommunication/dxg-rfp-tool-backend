require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { compareVisibility } = require("../src/modules/tenancy/migrationVerification");

const snapshot = (users) => ({ takenAt: "2026-11-01T00:00:00.000Z", users });
const member = (userId, organizationId, proposals, vendorResponses = []) => ({ userId, organizationId, proposals, vendorResponses });

test("a customer who moved organization but sees the same ids has no difference", () => {
  const before = snapshot([member("u1", "shared", ["p1", "p2"], ["r1"])]);
  const after = snapshot([member("u1", "holding-u1", ["p1", "p2"], ["r1"])]);
  assert.deepEqual(compareVisibility(before, after), []);
});

test("lost and gained proposals and vendor responses are reported per customer", () => {
  const before = snapshot([member("u1", "shared", ["p1", "p2"], ["r1"]), member("u2", "shared", ["p3"])]);
  const after = snapshot([member("u1", "holding", ["p2", "p9"], []), member("u2", "holding-2", ["p3"])]);
  assert.deepEqual(compareVisibility(before, after), [
    { userId: "u1", lostProposals: ["p1"], gainedProposals: ["p9"], lostVendorResponses: ["r1"], gainedVendorResponses: [] },
  ]);
});

test("a customer with no active membership afterwards has lost everything", () => {
  const before = snapshot([member("u1", "shared", ["p1"], ["r1"])]);
  assert.deepEqual(compareVisibility(before, snapshot([])), [
    { userId: "u1", lostProposals: ["p1"], gainedProposals: [], lostVendorResponses: ["r1"], gainedVendorResponses: [] },
  ]);
});

test("members who only appear afterwards are not differences", () => {
  assert.deepEqual(compareVisibility(snapshot([]), snapshot([member("new", "org", ["p1"])])), []);
});
