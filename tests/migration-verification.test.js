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
const { compareReferencePlacement, parentEdgesToCheck, verificationChecks, verificationFailed } = require("../src/modules/tenancy/migrationVerification");

const placement = (references, users, rowsNotWithParent = [], organizationsRead = 3) => ({
  organizationsRead, references, userOrganization: new Map(users), rowsNotWithParent,
});
const reference = (proposalId, ownerUserId, organizationId) => ({ proposalId, ownerUserId, organizationId });
const mongo = (mongoProposals) => ({ mongoProposals });

test("references that sit with their proposal and their owner are not misplaced", () => {
  const result = compareReferencePlacement(
    placement([reference("p1", "ua", "holding-a"), reference("p2", "ub", "holding-b")], [["ua", "holding-a"], ["ub", "holding-b"]]),
    new Map([["p1", "holding-a"], ["p2", "holding-b"]]), mongo(2),
  );
  assert.equal(result.total, 0);
  assert.equal(result.notRead, null);
  assert.deepEqual(result.checked, { organizations: 3, references: 2, proposals: 2 });
});

test("a reference in another organization than its proposal is reported with both organizations", () => {
  // The defect of 2026-11-23: B's proposal is in B's tenant, its reference in A's.
  const result = compareReferencePlacement(
    placement([reference("p2", "ub", "holding-a")], [["ub", "holding-b"]]),
    new Map([["p2", "holding-b"]]), mongo(1),
  );
  assert.deepEqual(result.referenceNotWithProposal, [{ proposalId: "p2", proposalOrganizationId: "holding-b", referenceOrganizationId: "holding-a" }]);
  assert.deepEqual(result.ownerNotWithReference, [{ proposalId: "p2", referenceOrganizationId: "holding-a", ownerOrganizationId: "holding-b" }]);
  assert.equal(result.total, 2);
});

test("an owner whose row is in no known organization, and rows apart from their parent, count", () => {
  const result = compareReferencePlacement(
    placement([reference("p1", "gone", "holding-a")], [], [{ organizationId: "holding-b", table: "job_attempts", parent: "ai_jobs", rows: 13 }]),
    new Map([["p1", "holding-a"]]), mongo(1),
  );
  assert.deepEqual(result.ownerNotWithReference, [{ proposalId: "p1", referenceOrganizationId: "holding-a", ownerOrganizationId: null }]);
  assert.equal(result.total, 14);
});

test("a reference whose proposal no longer exists in MongoDB is only checked against its owner", () => {
  const result = compareReferencePlacement(placement([reference("deleted", "ua", "holding-a")], [["ua", "holding-a"]]), new Map(), mongo(0));
  assert.equal(result.total, 0);
});

test("the lists are capped and the total is not", () => {
  const references = Array.from({ length: 60 }, (_, i) => reference(`p${i}`, "ua", "holding-b"));
  const result = compareReferencePlacement(placement(references, [["ua", "holding-a"]]), new Map(references.map((r) => [r.proposalId, "holding-a"])), mongo(60));
  assert.equal(result.referenceNotWithProposal.length, 50);
  assert.equal(result.total, 120);
  assert.equal(compareReferencePlacement(placement(references, [["ua", "holding-a"]]), new Map(), { mongoProposals: 60, sampleSize: 1000 }).ownerNotWithReference.length, 60);
});

// Reading nothing is not passing (the wrong database, or a role row-level security hides everything from).
test("a check that found no organization in Postgres did not pass", () => {
  const result = compareReferencePlacement(placement([], [], [], 0), new Map(), mongo(0));
  assert.equal(result.total, 0);
  assert.match(result.notRead, /no organization/);
  const checks = verificationChecks({ ...passing, misplaced: result });
  assert.equal(checks.proposalDataFollowsProposal, false);
  assert.equal(verificationFailed(checks), true);
});

test("a check that read no reference while MongoDB holds proposals did not pass", () => {
  const result = compareReferencePlacement(placement([], [["ua", "holding-a"]]), new Map(), mongo(7));
  assert.match(result.notRead, /no proposal reference was read.*7 proposals/);
  assert.equal(verificationChecks({ ...passing, misplaced: result }).proposalDataFollowsProposal, false);
});

test("no references and no proposals anywhere is a pass: there was nothing to place", () => {
  const result = compareReferencePlacement(placement([], [["ua", "holding-a"]]), new Map(), mongo(0));
  assert.equal(result.notRead, null);
  assert.equal(verificationChecks({ ...passing, misplaced: result }).proposalDataFollowsProposal, true);
});

test("only plain foreign keys to a customer's own rows are compared across organizations", () => {
  const edge = (child, parent, composite = false) => ({ child, parent, composite, childColumns: ["x_id"], parentColumns: ["id"] });
  const schema = { tables: [], doerColumns: {}, idTables: [], primaryKeys: {}, edges: [
    edge("conversation_messages", "conversations"),
    edge("job_attempts", "ai_jobs"),
    // Tied through organization_id: the database already refuses a split.
    edge("source_extraction_runs", "proposal_references", true),
    // DXG's shared corpus: a customer's row may name a release in DXG's organization.
    edge("knowledge_retrieval_results", "knowledge_releases"),
    // Reported by proposal id as ownerNotWithReference instead.
    edge("proposal_references", "users"),
  ] };
  assert.deepEqual(parentEdgesToCheck(schema).map((e) => `${e.child}>${e.parent}`), ["conversation_messages>conversations", "job_attempts>ai_jobs"]);
});

const passing = { visibility: [], leftovers: { mongo: {}, postgres: {} }, orphans: { total: 0 }, misplaced: { total: 0, notRead: null } };

test("the verifier passes only when every check is true or skipped", () => {
  const checks = verificationChecks(passing);
  assert.deepEqual(checks, { visibilityUnchanged: true, noCustomerRecordsInSharedOrganization: true, everyProposalHasAnActiveOwner: true, proposalDataFollowsProposal: true });
  assert.equal(verificationFailed(checks), false);
  const skipped = verificationChecks({ ...passing, visibility: null, misplaced: null });
  assert.equal(typeof skipped.proposalDataFollowsProposal, "string");
  assert.equal(verificationFailed(skipped), false);
});

test("misplaced proposal data fails the verifier although every other check passes", () => {
  const checks = verificationChecks({ ...passing, misplaced: { total: 1, notRead: null } });
  assert.equal(checks.proposalDataFollowsProposal, false);
  assert.equal(verificationFailed(checks), true);
});
