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

// proposalDataFollowsProposal: a proposal's Postgres data is in the proposal's organization.
const { compareReferencePlacement, verificationChecks, verificationFailed } = require("../src/modules/tenancy/migrationVerification");

const placement = (references, users, rowsNotWithReference = []) => ({
  organizationsRead: 3, references, userOrganization: new Map(users), rowsNotWithReference,
});
const reference = (proposalId, ownerUserId, organizationId) => ({ proposalId, ownerUserId, organizationId });

test("references that sit with their proposal and their owner are not misplaced", () => {
  const result = compareReferencePlacement(
    placement([reference("p1", "ua", "holding-a"), reference("p2", "ub", "holding-b")], [["ua", "holding-a"], ["ub", "holding-b"]]),
    new Map([["p1", "holding-a"], ["p2", "holding-b"]]),
  );
  assert.equal(result.total, 0);
  assert.deepEqual(result.checked, { organizations: 3, references: 2, proposals: 2 });
});

test("a reference in another organization than its proposal is reported with both organizations", () => {
  // The defect of 2026-11-23: B's proposal is in B's tenant, its reference in A's.
  const result = compareReferencePlacement(
    placement([reference("p2", "ub", "holding-a")], [["ub", "holding-b"]]),
    new Map([["p2", "holding-b"]]),
  );
  assert.deepEqual(result.referenceNotWithProposal, [{ proposalId: "p2", proposalOrganizationId: "holding-b", referenceOrganizationId: "holding-a" }]);
  assert.deepEqual(result.ownerNotWithReference, [{ proposalId: "p2", referenceOrganizationId: "holding-a", ownerOrganizationId: "holding-b" }]);
  assert.equal(result.total, 2);
});

test("an owner whose row is in no known organization, and rows naming a reference elsewhere, count", () => {
  const result = compareReferencePlacement(
    placement([reference("p1", "gone", "holding-a")], [], [{ organizationId: "holding-b", table: "ai_jobs", rows: 13 }]),
    new Map([["p1", "holding-a"]]),
  );
  assert.deepEqual(result.ownerNotWithReference, [{ proposalId: "p1", referenceOrganizationId: "holding-a", ownerOrganizationId: null }]);
  assert.equal(result.total, 14);
});

test("a reference whose proposal no longer exists in MongoDB is only checked against its owner", () => {
  const result = compareReferencePlacement(placement([reference("deleted", "ua", "holding-a")], [["ua", "holding-a"]]), new Map());
  assert.equal(result.total, 0);
});

test("the lists are capped and the total is not", () => {
  const references = Array.from({ length: 60 }, (_, i) => reference(`p${i}`, "ua", "holding-b"));
  const result = compareReferencePlacement(placement(references, [["ua", "holding-a"]]), new Map(references.map((r) => [r.proposalId, "holding-a"])));
  assert.equal(result.referenceNotWithProposal.length, 50);
  assert.equal(result.total, 120);
});

const passing = { visibility: [], leftovers: { mongo: {}, postgres: {} }, orphans: { total: 0 }, misplaced: { total: 0 } };

test("the verifier passes only when every check is true or skipped", () => {
  const checks = verificationChecks(passing);
  assert.deepEqual(checks, { visibilityUnchanged: true, noCustomerRecordsInSharedOrganization: true, everyProposalHasAnActiveOwner: true, proposalDataFollowsProposal: true });
  assert.equal(verificationFailed(checks), false);
  const skipped = verificationChecks({ ...passing, visibility: null, misplaced: null });
  assert.equal(typeof skipped.proposalDataFollowsProposal, "string");
  assert.equal(verificationFailed(skipped), false);
});

test("misplaced proposal data fails the verifier although every other check passes", () => {
  const checks = verificationChecks({ ...passing, misplaced: { total: 1 } });
  assert.equal(checks.proposalDataFollowsProposal, false);
  assert.equal(verificationFailed(checks), true);
});
