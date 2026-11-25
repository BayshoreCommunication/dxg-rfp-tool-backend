const assert = require("node:assert/strict");
const test = require("node:test");
const Proposal = require("../modal/proposalsModel").default;
const {
  MAX_PROPOSAL_CONTENT_DEPTH,
  PROPOSAL_FIELD_OWNERSHIP,
  ProposalPayloadTooDeepError,
  refusedTenancyWriteAuditMetadata,
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

// The parity test below covers TOP-LEVEL fields only. Content sections are free-form: a
// server-owned field must never be added INSIDE one, because everything in a section is
// client-writable. Give such a value its own top-level field, classified "server".
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
    "lifecycle", "organizationId", "purgeStarted", "purgeStartedAt", "updatedAt", "userId", "version", "viewsCount",
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

// Raw JSON text on purpose: an object literal with a __proto__ key sets the prototype instead of
// creating the own key that JSON.parse (and so the request body parser) creates.
test("prototype keys in content are dropped at every depth and never become a prototype", () => {
  const body = JSON.parse(`{
    "event": { "__proto__": { "eventName": "polluted" }, "attendees": "800" },
    "venue": { "constructor": { "prototype": { "x": 1 } }, "prototype": { "y": 1 }, "rooms": [{ "__proto__": { "z": 1 }, "name": "A" }], "nested": { "deeper": { "__proto__": { "w": 1 }, "kept": true } } },
    "__proto__": { "isArchived": true },
    "constructor": { "prototype": { "isArchived": true } },
    "prototype": { "isArchived": true }
  }`);
  const cleaned = clientProposalFields(body);
  assert.deepEqual(Object.keys(cleaned).sort(), ["event", "venue"]);
  assert.deepEqual(cleaned, { event: { attendees: "800" }, venue: { rooms: [{ name: "A" }], nested: { deeper: { kept: true } } } });
  const objects = [cleaned, cleaned.event, cleaned.venue, cleaned.venue.rooms[0], cleaned.venue.nested, cleaned.venue.nested.deeper];
  for (const object of objects) {
    assert.equal(Object.getPrototypeOf(object), Object.prototype);
    for (const key of ["__proto__", "constructor", "prototype"]) assert.equal(Object.prototype.hasOwnProperty.call(object, key), false, key);
  }
  assert.equal(cleaned.event.eventName, undefined);
  assert.equal(cleaned.isArchived, undefined);
  assert.equal({}.eventName, undefined);
  assert.equal({}.isArchived, undefined);
});

test("a dotted content path with a prototype segment is dropped", () => {
  const body = JSON.parse(`{
    "venue.__proto__.x": 1,
    "venue.constructor.prototype.x": 1,
    "venue.prototype": 1,
    "event.constructor": 1,
    "__proto__.event": 1,
    "constructor.prototype.event": 1,
    "venue.riggingRequired": "YES"
  }`);
  assert.deepEqual(clientProposalFields(body), { "venue.riggingRequired": "YES" });
  for (const key of Object.keys(body).filter((path) => path !== "venue.riggingRequired")) {
    assert.throws(() => assertEditUpdateIsSafe({ [key]: 1 }), /server-owned/, key);
  }
});

const nestedObjects = (levels) => { let value = "leaf"; for (let i = 0; i < levels; i += 1) value = { a: value }; return value; };
const nestedArrays = (levels) => { let value = "leaf"; for (let i = 0; i < levels; i += 1) value = [value]; return value; };

test("content nested beyond the limit refuses the payload instead of overflowing the stack", async () => {
  assert.equal(MAX_PROPOSAL_CONTENT_DEPTH, 64);
  assert.doesNotThrow(() => clientProposalFields({ venue: nestedObjects(MAX_PROPOSAL_CONTENT_DEPTH) }));
  assert.doesNotThrow(() => clientProposalFields({ roomByRoom: nestedArrays(MAX_PROPOSAL_CONTENT_DEPTH) }));
  const tooDeep = (error) => error instanceof ProposalPayloadTooDeepError && error.status === 400 && error.code === "PROPOSAL_PAYLOAD_TOO_DEEP";
  assert.throws(() => clientProposalFields({ venue: nestedObjects(MAX_PROPOSAL_CONTENT_DEPTH + 1) }), tooDeep);
  assert.throws(() => clientProposalFields({ roomByRoom: nestedArrays(MAX_PROPOSAL_CONTENT_DEPTH + 1) }), tooDeep);
  assert.throws(() => clientProposalFields({ "event.deep": nestedObjects(100000) }), tooDeep);
  // Depth under a server-owned or unknown key is never walked.
  assert.deepEqual(clientProposalFields({ lifecycle: nestedObjects(100000), unknown: nestedArrays(100000) }), {});

  const capture = {};
  await assert.rejects(
    createUpdateOwnedProposal(dependencies(capture))({ proposalId: "p", ownerUserId: "u", updates: { venue: nestedObjects(5000) } }),
    tooDeep,
  );
  assert.equal(capture.update, undefined);
});

test("the refusal audit records strict ids or a fixed marker, and the proposal id as claimed", () => {
  const { safeAuditMetadata } = require("../src/modules/auth/infrastructure/audit/mongoSecurityAuditWriter");
  const hex = "64b0000000000000000000ff";
  const route = "PUT /api/proposals/:id";
  assert.deepEqual(
    refusedTenancyWriteAuditMetadata({ field: "organizationId", attempted: hex, claimedProposalId: "64b000000000000000000001", route }),
    { field: "organizationId", route, attemptedOrganizationId: hex, claimedProposalId: "64b000000000000000000001" },
  );
  // mongoose.isValidObjectId accepts any 12-character string; none of these is recorded as sent.
  for (const attempted of ["twelve chars", "<script>x</script>", "64b0000000000000000000f", `${hex}0`, `${hex}\n`, null, 12, { $oid: hex }, [hex]]) {
    assert.equal(refusedTenancyWriteAuditMetadata({ field: "organizationId", attempted, route }).attemptedOrganizationId, "malformed", JSON.stringify(attempted));
  }
  assert.equal(refusedTenancyWriteAuditMetadata({ field: "organizationId", attempted: hex, claimedProposalId: "twelve chars", route }).claimedProposalId, "malformed");
  // A create has no proposal id to claim.
  const onCreate = refusedTenancyWriteAuditMetadata({ field: "organizationId", attempted: hex, route: "POST /api/proposals" });
  assert.equal("claimedProposalId" in onCreate, false);
  // Every key survives the audit writer's metadata rule.
  const full = refusedTenancyWriteAuditMetadata({ field: "organizationId", attempted: hex, claimedProposalId: hex, route });
  assert.deepEqual(safeAuditMetadata(full), full);
});

test("the controller records the refusal without a target, through the metadata builder", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../controller/proposalsController.ts"), "utf8");
  const start = source.indexOf("const respondIfTenancyChangeRefused");
  const helper = source.slice(start, source.indexOf("\n};\n", start));
  assert.match(helper, /metadata: refusedTenancyWriteAuditMetadata\(\{/);
  assert.match(helper, /claimedProposalId,/);
  assert.doesNotMatch(helper, /targetId/);
  assert.doesNotMatch(helper, /isValidObjectId/);
  assert.match(helper, /error instanceof ProposalPayloadTooDeepError/);
});
