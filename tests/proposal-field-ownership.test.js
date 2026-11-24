const assert = require("node:assert/strict");
const test = require("node:test");
const Proposal = require("../modal/proposalsModel").default;
const {
  PROPOSAL_FIELD_OWNERSHIP,
  ProposalTenancyChangeRefusedError,
  assertEditUpdateIsSafe,
  assertNoOrganizationChange,
  clientProposalFields,
  withoutTenancyFields,
} = require("../src/modules/proposals/domain/proposalFieldOwnership");
const {
  createCreateOwnedProposal,
  createUpdateOwnedProposal,
} = require("../src/modules/proposals/application/authorOwnedProposal");
const {
  createUpdateOwnedProposalMeta,
  createUpdateOwnedProposalStatus,
} = require("../src/modules/proposals/application/mutateOwnedProposal");

// Trust boundary: a server-owned proposal field is never taken from a client payload.

const SERVER_OWNED = [...PROPOSAL_FIELD_OWNERSHIP].filter(([, owner]) => owner === "server").map(([field]) => field);
const CLIENT_FLAGS = [...PROPOSAL_FIELD_OWNERSHIP].filter(([, owner]) => owner === "client_flag").map(([field]) => field);
const CONTENT = [...PROPOSAL_FIELD_OWNERSHIP].filter(([, owner]) => owner === "content").map(([field]) => field);

test("every top-level field of the Proposal model is classified, and nothing else is", () => {
  const modelFields = [...new Set(Object.keys(Proposal.schema.paths).map((path) => path.split(".")[0]))].sort();
  const classified = [...PROPOSAL_FIELD_OWNERSHIP.keys()].sort();
  assert.deepEqual(
    classified,
    modelFields,
    "Classify every top-level Proposal field in src/modules/proposals/domain/proposalFieldOwnership.ts as content, client_flag or server (and remove fields the model no longer has). An unclassified field is dropped from client payloads.",
  );
});

test("the classification is the one this change was reviewed with", () => {
  assert.deepEqual(SERVER_OWNED.sort(), [
    "__v", "_id", "archivedAt", "candidateApplicationIds", "createdAt", "isArchived", "isCopy",
    "lifecycle", "organizationId", "updatedAt", "userId", "version", "viewsCount",
  ]);
  assert.deepEqual(CLIENT_FLAGS.sort(), ["isAccepted", "isActive", "isDraft", "isFavorite", "isOpen", "status", "teamId"]);
  assert.deepEqual(CONTENT.sort(), [
    "budget", "contact", "contentCreative", "event", "hybridVirtual", "production", "proposalSettings",
    "roomByRoom", "uploads", "venue", "venueSchedule", "videoRecordingStep",
  ]);
});

test("each server-owned field is dropped as a top-level key, a dotted path and under an operator", () => {
  for (const field of SERVER_OWNED) {
    const cleaned = clientProposalFields({
      [field]: "forged",
      [`${field}.child`]: "forged",
      $set: { [field]: "forged" },
      $unset: { [field]: "" },
      event: { eventName: "Kept" },
    });
    assert.deepEqual(cleaned, { event: { eventName: "Kept" } }, field);
  }
});

test("each client-writable field is kept; a flag is exact-key only, content takes dotted paths", () => {
  for (const field of CLIENT_FLAGS) {
    assert.deepEqual(clientProposalFields({ [field]: "value", [`${field}.child`]: "x" }), { [field]: "value" }, field);
  }
  for (const field of CONTENT) {
    assert.deepEqual(
      clientProposalFields({ [field]: { a: 1 }, [`${field}.nested.value`]: 2 }),
      { [field]: { a: 1 }, [`${field}.nested.value`]: 2 },
      field,
    );
  }
});

test("unknown fields, operator keys and operator path segments never pass", () => {
  assert.deepEqual(
    clientProposalFields({
      purgeStarted: true,
      purgeStartedAt: "2020-01-01",
      deletedAt: "2020-01-01",
      proposalSetting: { injected: true },
      $set: { isArchived: true },
      $unset: { archivedAt: "" },
      $inc: { viewsCount: 100 },
      $rename: { userId: "x" },
      "$set.isArchived": true,
      "event.$[].x": 1,
      "event..eventName": "x",
      "event.": "x",
      ".event": "x",
      "": "x",
      constructor: { prototype: {} },
      toString: "x",
      hasOwnProperty: "x",
    }),
    {},
  );
  const prototypeKey = JSON.parse('{"__proto__":{"isArchived":true},"event":{"eventName":"A"}}');
  const cleaned = clientProposalFields(prototypeKey);
  assert.deepEqual(Object.keys(cleaned), ["event"]);
  assert.equal(cleaned.isArchived, undefined);
});

test("operator keys are removed at any depth inside content, and the input is not mutated", () => {
  const input = {
    venue: { $where: "x", riggingRequired: "YES", contacts: [{ $set: { a: 1 }, name: "Sam" }, "plain", null, 3] },
    roomByRoom: [{ roomFunction: "General session", $inc: { version: 1 } }],
    budget: { estimatedAvBudget: "$100k-$250k" },
  };
  const before = JSON.stringify(input);
  assert.deepEqual(clientProposalFields(input), {
    venue: { riggingRequired: "YES", contacts: [{ name: "Sam" }, "plain", null, 3] },
    roomByRoom: [{ roomFunction: "General session" }],
    budget: { estimatedAvBudget: "$100k-$250k" },
  });
  assert.equal(JSON.stringify(input), before);
});

test("a payload naming another organization is refused; the caller's own is ignored", () => {
  const actor = "64b000000000000000000001";
  assert.doesNotThrow(() => assertNoOrganizationChange({ event: {} }, actor));
  assert.doesNotThrow(() => assertNoOrganizationChange({ organizationId: actor }, actor));
  for (const value of ["64b0000000000000000000ff", null, "", { $oid: actor }, [actor], 0]) {
    assert.throws(
      () => assertNoOrganizationChange({ organizationId: value }, actor),
      (error) => error instanceof ProposalTenancyChangeRefusedError && error.status === 400 && error.code === "PROPOSAL_TENANCY_FIELD_NOT_WRITABLE" && error.field === "organizationId",
      JSON.stringify(value),
    );
  }
});

const dependencies = (capture) => ({
  proposals: {
    createOwned: async (input) => { capture.create = input; return { _id: "created-001", ...input.proposal }; },
    updateOwnedById: async (input) => { capture.update = input; return { _id: input.proposalId, ...input.updates }; },
    findOwnedLifecycleById: async () => ({ isCopy: false }),
  },
  settings: { findByUserId: async () => ({}) },
});

const FORGED = {
  organizationId: "64b000000000000000000001",
  userId: "64b0000000000000000000aa",
  isArchived: true,
  archivedAt: "2020-01-01T00:00:00.000Z",
  isCopy: true,
  viewsCount: 9999,
  version: 77,
  candidateApplicationIds: ["forged"],
  lifecycle: { stage: "awarded", awardedAt: "2020-01-01" },
  "lifecycle.stage": "awarded",
  "lifecycle.vendorsResponded": 50,
  purgeStarted: true,
  purgeStartedAt: "2020-01-01",
  createdAt: "2020-01-01",
  $set: { isArchived: true },
  $unset: { archivedAt: "" },
};

test("the edit use case passes only client-writable fields to the repository", async () => {
  const capture = {};
  const result = await createUpdateOwnedProposal(dependencies(capture))({
    proposalId: "proposal-001",
    ownerUserId: "user-001",
    actorOrganizationId: "64b000000000000000000001",
    updates: { ...FORGED, event: { eventName: "Edited" }, "contact.contactTitle": "Producer", isFavorite: true },
  });
  assert.equal(result.kind, "updated");
  assert.deepEqual(capture.update.updates, { event: { eventName: "Edited" }, "contact.contactTitle": "Producer", isFavorite: true });
  assert.doesNotThrow(() => assertEditUpdateIsSafe(capture.update.updates));
});

test("the edit use case refuses another organization before any write", async () => {
  const capture = {};
  await assert.rejects(
    createUpdateOwnedProposal(dependencies(capture))({
      proposalId: "proposal-001",
      ownerUserId: "user-001",
      actorOrganizationId: "64b000000000000000000001",
      updates: { organizationId: "64b0000000000000000000ff", event: { eventName: "Edited" } },
    }),
    ProposalTenancyChangeRefusedError,
  );
  assert.equal(capture.update, undefined);
});

test("the create use case passes only client-writable fields, and refuses another organization", async () => {
  const capture = {};
  await createCreateOwnedProposal(dependencies(capture))({
    ownerUserId: "user-001",
    actorOrganizationId: "64b000000000000000000001",
    proposal: { ...FORGED, event: { eventName: "New" } },
  });
  assert.deepEqual(capture.create.proposal, { event: { eventName: "New" }, isDraft: true, status: "unsubmitted", teamId: null });

  const refused = {};
  await assert.rejects(
    createCreateOwnedProposal(dependencies(refused))({
      ownerUserId: "user-001",
      actorOrganizationId: "64b000000000000000000001",
      proposal: { organizationId: "64b0000000000000000000ff", event: { eventName: "New" } },
    }),
    ProposalTenancyChangeRefusedError,
  );
  assert.equal(refused.create, undefined);
});

test("every update the status and meta use cases build passes the repository backstop", async () => {
  for (const status of ["unsubmitted", "submitted", "reviewed", "approved", "rejected"]) {
    const capture = {};
    await createUpdateOwnedProposalStatus(dependencies(capture))({ proposalId: "p", ownerUserId: "u", status });
    assert.doesNotThrow(() => assertEditUpdateIsSafe(capture.update.updates), status);
  }
  const capture = {};
  await createUpdateOwnedProposalMeta(dependencies(capture))({
    proposalId: "p",
    ownerUserId: "u",
    metadata: { isActive: true, isFavorite: true, isAccepted: true, isOpen: true, isDraft: false, viewsCount: 3, isArchived: true, organizationId: "x" },
  });
  assert.deepEqual(Object.keys(capture.update.updates).sort(), ["isAccepted", "isActive", "isDraft", "isFavorite", "isOpen", "viewsCount"]);
  assert.doesNotThrow(() => assertEditUpdateIsSafe(capture.update.updates));
});

test("the repository backstop throws on tenancy, archive state, lifecycle, counters it doesn't set, operators and unknown fields", () => {
  for (const key of [
    "organizationId", "userId", "isArchived", "archivedAt", "lifecycle", "lifecycle.stage", "version",
    "candidateApplicationIds", "_id", "createdAt", "isCopy.x", "viewsCount.x", "$set", "$unset", "$inc", "purgeStarted",
  ]) {
    assert.throws(() => assertEditUpdateIsSafe({ event: { eventName: "A" }, [key]: 1 }), /server-owned/, key);
  }
  assert.doesNotThrow(() => assertEditUpdateIsSafe({ status: "submitted", isDraft: false, isCopy: false, isActive: true, isOpen: true, viewsCount: 2, teamId: null, "event.eventName": "A" }));
});

test("the repository's update and insert call the backstops", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../src/modules/proposals/infrastructure/mongo/mongoProposalWriteRepository.ts"),
    "utf8",
  );
  assert.match(source, /assertEditUpdateIsSafe\(updates\);\s+const proposal = await Proposal\.findOneAndUpdate\(/);
  assert.match(source, /new Proposal\(\{ \.\.\.withoutTenancyFields\(proposal\), userId: ownerUserId, \.\.\.tenant \}\)/);
});

test("an insert can't carry tenancy from its caller", () => {
  assert.deepEqual(
    withoutTenancyFields({ organizationId: "x", userId: "y", "organizationId.z": 1, "userId.z": 1, $set: {}, isArchived: false, archivedAt: null, event: { eventName: "A" } }),
    { isArchived: false, archivedAt: null, event: { eventName: "A" } },
  );
});
