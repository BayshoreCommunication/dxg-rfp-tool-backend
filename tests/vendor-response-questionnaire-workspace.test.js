require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  projectProposalToVendorResponseQuestionnaire,
  publishQuestionnaireProjection,
  questionnaireProjectionChecksum,
} = require("../src/modules/vendorResponses/domain/questionnaire");
const {
  createVendorResponseQuestionnaireService,
  VendorResponseWorkspaceError,
} = require("../src/modules/vendorResponses/application/vendorResponseWorkspace");
const {
  validateVendorResponseQuestionnaireV1,
  validateVendorResponseWorkspaceV1,
} = require("../contracts/vendor-response/v1/validators");

const proposalId = "507f1f77bcf86cd799439011";
const organizationId = "507f1f77bcf86cd799439012";
const ownerUserId = "507f1f77bcf86cd799439013";
const fixedNow = new Date("2026-09-14T12:00:00.000Z");
process.env.VENDOR_STRUCTURED_RESPONSES_ENABLED = "true";

const legacyProposal = (overrides = {}) => ({
  _id: proposalId,
  organizationId,
  userId: ownerUserId,
  status: "submitted",
  isDraft: false,
  isActive: true,
  isOpen: true,
  isArchived: false,
  version: 4,
  event: {
    eventName: "Annual Leadership Summit",
    eventFormat: "Hybrid",
    startDate: "2027-02-01",
    endDate: "2027-02-03",
  },
  venueSchedule: {
    numberOfEventRooms: "2",
    venueName: "Example Convention Center",
    venueCity: "Chicago",
    venueState: "IL",
  },
  roomByRoom: [
    {
      _id: "room-general-session",
      roomFunction: "General session",
      roomLocation: "Grand ballroom",
      estimatedAttendeesInRoom: "1200",
      audioSystemRequired: "YES",
      showCrewNeeded: ["Technical Director", "Audio Engineer"],
    },
    {
      _id: "room-breakout",
      roomFunction: "Breakout",
      roomLocation: "Room 201",
      largeMonitorsOrScreenProjector: {
        largeMonitorsOrScreenProjector: "YES",
        numberOfMonitors: "2",
      },
    },
  ],
  venue: { coiRequirements: "Provide evidence of current coverage." },
  budget: {
    proposalSubmissionDueDate: "2026-12-01",
    estimatedAvBudgetCurrency: "EUR",
  },
  proposalSettings: { defaultCurrency: "$", decimalPrecision: 2 },
  contact: {
    contactFirstName: "Pat",
    contactLastName: "Planner",
    contactEmail: "private-planner@example.com",
    contactPhone: "+1 555 9999",
    contactOrganization: "Example Planning",
  },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
  ...overrides,
});

const sourceSnapshot = (overrides = {}) => ({
  organizationId,
  proposalId,
  ownerUserId,
  status: "submitted",
  isDraft: false,
  isActive: true,
  isOpen: true,
  isArchived: false,
  responseFormat: "structured_v1",
  legacyProposal: legacyProposal(),
  ...overrides,
});

const inMemoryRepository = (snapshot = sourceSnapshot()) => {
  const publications = [];
  return {
    publications,
    async loadProposal(input) {
      if (input.organizationId !== organizationId || input.proposalId !== proposalId) return null;
      if (input.ownerUserId && input.ownerUserId !== ownerUserId) return null;
      return snapshot;
    },
    async setResponseFormat(input) {
      snapshot.responseFormat = input.responseFormat;
      snapshot.legacyProposal.proposalSettings = {
        ...(snapshot.legacyProposal.proposalSettings ?? {}),
        vendorResponseFormat: input.responseFormat,
      };
      return true;
    },
    async publish(input) {
      const existing = publications.find((entry) => entry.sourceChecksum === input.sourceChecksum);
      if (existing) return { questionnaire: existing.questionnaire, created: false };
      const questionnaire = publishQuestionnaireProjection(
        input.projection,
        publications.length + 1,
        input.publishedAt.toISOString(),
      );
      publications.push({ ...input, questionnaire });
      return { questionnaire, created: true };
    },
  };
};

test("projection creates a vendor-safe deterministic questionnaire from canonical proposal data", async () => {
  const repository = inMemoryRepository();
  const service = createVendorResponseQuestionnaireService(repository, () => fixedNow);
  const first = await service.publish({ organizationId, proposalId, actorId: ownerUserId });
  const second = await service.publish({ organizationId, proposalId, actorId: ownerUserId });
  const questionnaire = first.publication.questionnaire;

  assert.equal(first.publication.created, true);
  assert.equal(second.publication.created, false);
  assert.equal(repository.publications.length, 1);
  assert.equal(validateVendorResponseQuestionnaireV1(questionnaire), true);
  assert.equal(questionnaire.proposalVersion, 4);
  assert.equal(questionnaire.context.currency, "EUR");
  assert.equal(questionnaire.pricing.currency, "EUR");
  assert.deepEqual(questionnaire.rooms.map((room) => room.roomId), [
    "room-general-session",
    "room-breakout",
  ]);
  assert.ok(questionnaire.rooms[0].specs.every((spec) => spec.specId.startsWith("spec-")));
  assert.equal(
    questionnaireProjectionChecksum(
      projectProposalToVendorResponseQuestionnaire(
        require("../contracts/proposal/v1/legacyAdapter").mapLegacyProposalToV1(
          legacyProposal(),
          { organizationId, ownerUserId, now: fixedNow.toISOString() },
        ).proposal,
      ),
    ),
    repository.publications[0].sourceChecksum,
  );
  const serialized = JSON.stringify(questionnaire);
  assert.doesNotMatch(serialized, /private-planner@example\.com|555 9999/);
  assert.doesNotMatch(serialized, /organizationId|ownerUserId|accessGrant|sourceReferences/);
});

test("a changed proposal projection publishes the next questionnaire version", async () => {
  const snapshot = sourceSnapshot();
  const repository = inMemoryRepository(snapshot);
  const service = createVendorResponseQuestionnaireService(repository, () => fixedNow);
  const first = await service.publish({ organizationId, proposalId, actorId: ownerUserId });

  snapshot.legacyProposal = legacyProposal({
    version: 5,
    roomByRoom: [
      ...legacyProposal().roomByRoom,
      { _id: "room-workshop", roomFunction: "Workshop", audioSystemRequired: "YES" },
    ],
    venueSchedule: {
      ...legacyProposal().venueSchedule,
      numberOfEventRooms: "3",
    },
  });
  const second = await service.publish({ organizationId, proposalId, actorId: ownerUserId });

  assert.equal(first.publication.questionnaire.questionnaireVersion, 1);
  assert.equal(second.publication.created, true);
  assert.equal(second.publication.questionnaire.questionnaireVersion, 2);
  assert.equal(second.publication.questionnaire.proposalVersion, 5);
  assert.equal(second.publication.questionnaire.rooms.length, 3);
  assert.notEqual(
    first.publication.questionnaire.questionnaireChecksum,
    second.publication.questionnaire.questionnaireChecksum,
  );
});

test("workspace returns only the contract DTO and derives open, closed, and expired states", async () => {
  const openService = createVendorResponseQuestionnaireService(inMemoryRepository(), () => fixedNow);
  const open = await openService.workspace({ organizationId, proposalId, grantActorId: ownerUserId });
  assert.equal(validateVendorResponseWorkspaceV1(open), true);
  assert.equal(open.proposalTitle, "Annual Leadership Summit");
  assert.deepEqual(open.capabilities, {
    structuredResponse: true,
    responseFormat: "structured_v1",
    reason: "enabled",
  });
  assert.deepEqual(open.access, { state: "open", canEdit: true, canSubmit: true });
  assert.equal(open.draft, null);
  assert.equal(open.currentSubmission, null);

  const closed = await createVendorResponseQuestionnaireService(
    inMemoryRepository(sourceSnapshot({ isOpen: false })),
    () => fixedNow,
  ).workspace({ organizationId, proposalId, grantActorId: ownerUserId });
  assert.equal(closed.access.state, "closed");
  assert.equal(closed.access.canSubmit, false);

  const expiredSnapshot = sourceSnapshot();
  expiredSnapshot.legacyProposal = legacyProposal({
    budget: { proposalSubmissionDueDate: "2026-09-13" },
  });
  const expired = await createVendorResponseQuestionnaireService(
    inMemoryRepository(expiredSnapshot),
    () => fixedNow,
  ).workspace({ organizationId, proposalId, grantActorId: ownerUserId });
  assert.equal(expired.access.state, "expired");
  assert.equal(expired.access.canEdit, false);
});

test("global and proposal rollout gates return a legacy bootstrap without publishing", async () => {
  const original = process.env.VENDOR_STRUCTURED_RESPONSES_ENABLED;
  const repository = inMemoryRepository();
  process.env.VENDOR_STRUCTURED_RESPONSES_ENABLED = "false";
  const globallyDisabled = await createVendorResponseQuestionnaireService(
    repository,
    () => fixedNow,
  ).workspace({ organizationId, proposalId, grantActorId: ownerUserId });
  assert.equal(globallyDisabled.capabilities.reason, "global_flag_disabled");
  assert.equal(globallyDisabled.questionnaire, null);
  assert.equal(repository.publications.length, 0);

  process.env.VENDOR_STRUCTURED_RESPONSES_ENABLED = "true";
  const proposalRepository = inMemoryRepository(sourceSnapshot({
    responseFormat: "legacy_unstructured",
  }));
  const proposalDisabled = await createVendorResponseQuestionnaireService(
    proposalRepository,
    () => fixedNow,
  ).workspace({ organizationId, proposalId, grantActorId: ownerUserId });
  assert.equal(proposalDisabled.capabilities.reason, "proposal_not_enabled");
  assert.equal(proposalDisabled.questionnaire, null);
  assert.equal(proposalRepository.publications.length, 0);
  if (original === undefined) delete process.env.VENDOR_STRUCTURED_RESPONSES_ENABLED;
  else process.env.VENDOR_STRUCTURED_RESPONSES_ENABLED = original;
});

test("proposal capability can be enabled and rolled back without removing publications", async () => {
  const repository = inMemoryRepository(sourceSnapshot({
    responseFormat: "legacy_unstructured",
  }));
  const service = createVendorResponseQuestionnaireService(repository, () => fixedNow);
  const enabled = await service.configure({
    organizationId,
    proposalId,
    actorId: ownerUserId,
    ownerUserId,
    responseFormat: "structured_v1",
  });
  assert.equal(enabled.publication.created, true);
  assert.equal(repository.publications.length, 1);
  const disabled = await service.configure({
    organizationId,
    proposalId,
    actorId: ownerUserId,
    ownerUserId,
    responseFormat: "legacy_unstructured",
  });
  assert.equal(disabled.publication, null);
  assert.equal(repository.publications.length, 1);
  const workspace = await service.workspace({
    organizationId,
    proposalId,
    grantActorId: ownerUserId,
  });
  assert.equal(workspace.capabilities.responseFormat, "legacy_unstructured");
  assert.equal(workspace.questionnaire, null);
});

test("publication remains tenant and owner scoped and fails closed for an invalid source", async () => {
  const repository = inMemoryRepository();
  const service = createVendorResponseQuestionnaireService(repository, () => fixedNow);
  await assert.rejects(
    () => service.publish({ organizationId: "wrong", proposalId, actorId: ownerUserId }),
    (error) => error instanceof VendorResponseWorkspaceError && error.code === "PROPOSAL_NOT_FOUND",
  );
  await assert.rejects(
    () => service.publish({ organizationId, proposalId, actorId: ownerUserId, ownerUserId: "wrong" }),
    (error) => error instanceof VendorResponseWorkspaceError && error.code === "PROPOSAL_NOT_FOUND",
  );

  const invalidRepository = inMemoryRepository(sourceSnapshot({
    legacyProposal: legacyProposal({ contact: {} }),
  }));
  await assert.rejects(
    () => createVendorResponseQuestionnaireService(invalidRepository, () => fixedNow)
      .publish({ organizationId, proposalId, actorId: ownerUserId }),
    (error) => error instanceof VendorResponseWorkspaceError
      && error.code === "QUESTIONNAIRE_SOURCE_INVALID",
  );

  const invalidConfigureSource = sourceSnapshot({
    responseFormat: "legacy_unstructured",
    legacyProposal: legacyProposal({ contact: {} }),
  });
  const invalidConfigureRepository = inMemoryRepository(invalidConfigureSource);
  await assert.rejects(
    () => createVendorResponseQuestionnaireService(invalidConfigureRepository, () => fixedNow)
      .configure({
        organizationId,
        proposalId,
        actorId: ownerUserId,
        ownerUserId,
        responseFormat: "structured_v1",
      }),
    (error) => error instanceof VendorResponseWorkspaceError
      && error.code === "QUESTIONNAIRE_SOURCE_INVALID",
  );
  assert.equal(invalidConfigureSource.responseFormat, "legacy_unstructured");
});

test("Mongo questionnaire storage declares version uniqueness and immutable content", () => {
  const model = require("../modal/vendorResponseQuestionnaireVersionModel").default;
  const indexes = model.schema.indexes();
  assert.ok(indexes.some(([keys, options]) =>
    keys.organizationId === 1
      && keys.proposalId === 1
      && keys.questionnaireVersion === 1
      && options.unique === true));
  assert.ok(model.schema.path("questionnaireChecksum"));
  assert.ok(model.schema.path("sourceChecksum"));
  assert.equal(model.schema.path("responseFormat").options.default, "structured_v1");

  const repositorySource = fs.readFileSync(
    path.join(__dirname, "../src/modules/vendorResponses/infrastructure/mongo/mongoVendorResponseQuestionnaireRepository.ts"),
    "utf8",
  );
  assert.match(repositorySource, /organizationId: input\.organizationId/);
  assert.match(repositorySource, /proposalId: input\.proposalId/);
  assert.match(repositorySource, /sourceChecksum === input\.sourceChecksum/);
  assert.match(repositorySource, /status: "superseded"/);
  const modelSource = fs.readFileSync(
    path.join(__dirname, "../modal/vendorResponseQuestionnaireVersionModel.ts"),
    "utf8",
  );
  assert.match(modelSource, /Published vendor response questionnaire content is immutable/);
});

test("workspace and publication routes retain grant, rate-limit, and authorization boundaries", () => {
  const routeSource = fs.readFileSync(
    path.join(__dirname, "../routes/vendorResponseRoute.ts"),
    "utf8",
  );
  assert.match(
    routeSource,
    /"\/workspace",\s*publicGrantLimit,\s*requirePublicGrant\("vendor:submit", \{ allowRecipientlessVendorRead: true \}\)/,
  );
  assert.match(
    routeSource,
    /"\/questionnaires\/publish",\s*authenticate,\s*authorizeAction\("vendor-response:write"\),\s*plannerWriteLimit/,
  );
  assert.match(
    routeSource,
    /"\/questionnaires\/capability",\s*authenticate,\s*authorizeAction\("vendor-response:write"\),\s*plannerWriteLimit/,
  );
});

/* The reference minimum was not pinned by any test, so it silently sat at 1
   while the product required three comparable references. */
test("a published questionnaire demands three comparable references", () => {
  const questionnaire = projectProposalToVendorResponseQuestionnaire(
    require("../contracts/proposal/v1/legacyAdapter").mapLegacyProposalToV1(
      legacyProposal(),
      { organizationId, ownerUserId, now: fixedNow.toISOString() },
    ).proposal,
  );

  assert.equal(questionnaire.references.enabled, true);
  assert.equal(questionnaire.references.minimumCount, 3);
  assert.equal(questionnaire.references.maximumCount, 3);
});

/* A 500 from the workspace route used to leave only a statusClass in the logs.
   The telemetry allowlist drops any value that is not /^[A-Za-z0-9_.:-]{1,200}$/,
   so the classification has to be a token, not a message — these pin both the
   classification and the fact that it survives sanitisation. */
test("an unexpected workspace failure is classified into a loggable token", () => {
  const { workspaceErrorCode } = require("../controller/vendorResponseController");
  const { sanitizeTelemetry } = require("../src/shared/observability/safeTelemetry");

  const duplicateKey = Object.assign(new Error("E11000 duplicate key error collection: x"), {
    name: "MongoServerError",
    code: 11000,
  });
  assert.equal(workspaceErrorCode(duplicateKey), "MongoServerError.11000");
  assert.equal(workspaceErrorCode(new Error("boom")), "Error");
  assert.equal(
    workspaceErrorCode(new VendorResponseWorkspaceError("QUESTIONNAIRE_INVALID", 422, "bad")),
    "QUESTIONNAIRE_INVALID",
  );
  // Anything outside the allowed character class is neutralised, not dropped.
  assert.equal(workspaceErrorCode(Object.assign(new Error("x"), { name: "Weird Name!" })), "Weird_Name_");

  for (const error of [duplicateKey, new Error("boom")]) {
    const record = sanitizeTelemetry({
      event: "vendor_response_workspace_failed",
      outcome: "failure",
      statusClass: "5xx",
      errorCode: workspaceErrorCode(error),
    });
    assert.equal(record.errorCode, workspaceErrorCode(error), "errorCode must survive sanitisation");
  }
});

/* Whether a projection change reaches vendors was unobservable: a republish and
   a reuse of the stored version look identical from outside, so a projection
   that silently never republishes leaves vendors on an old questionnaire with
   nothing in the logs explaining why. */
test("each publish records whether it republished or reused the stored version", async () => {
  const repository = inMemoryRepository();
  const service = createVendorResponseQuestionnaireService(repository, () => fixedNow);

  const previousObservability = process.env.OBSERVABILITY_ENABLED;
  process.env.OBSERVABILITY_ENABLED = "true";
  const originalWrite = process.stdout.write.bind(process.stdout);
  const lines = [];
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return originalWrite(chunk, ...rest);
  };

  try {
    await service.workspace({ organizationId, proposalId, grantActorId: ownerUserId });
    await service.workspace({ organizationId, proposalId, grantActorId: ownerUserId });
  } finally {
    process.stdout.write = originalWrite;
    if (previousObservability === undefined) delete process.env.OBSERVABILITY_ENABLED;
    else process.env.OBSERVABILITY_ENABLED = previousObservability;
  }

  const events = lines
    .flatMap((line) => line.split("\n"))
    .filter((line) => line.includes("vendor_questionnaire_publish_resolved"))
    .map((line) => JSON.parse(line));

  assert.equal(events.length, 2);
  assert.equal(events[0].outcome, "published");
  assert.equal(events[1].outcome, "reused");
  assert.equal(events[0].versionNumber, 1);
  assert.equal(events[1].versionNumber, 1);
  // The checksum has to survive the telemetry allowlist, or the diagnostic is
  // a log line that looks healthy and carries nothing.
  assert.match(events[0].sourceChecksum, /^[0-9a-f]{64}$/);
  assert.equal(events[0].sourceChecksum, events[1].sourceChecksum);
  assert.equal(events[0].sourceChecksum, repository.publications[0].sourceChecksum);
});

/* The version row is the commit point. A failure in the bookkeeping that
   follows it used to escape as a 500, so the vendor who happened to trigger a
   republish got an error page for a publish that had already succeeded. */
test("a publish survives a failure in the supersede bookkeeping", async () => {
  const { mongoVendorResponseQuestionnaireRepository } = require("../src/modules/vendorResponses/infrastructure/mongo/mongoVendorResponseQuestionnaireRepository");
  const VendorResponseQuestionnaireVersion = require("../modal/vendorResponseQuestionnaireVersionModel").default;

  const originalFindOne = VendorResponseQuestionnaireVersion.findOne;
  const originalCreate = VendorResponseQuestionnaireVersion.create;
  const originalUpdateMany = VendorResponseQuestionnaireVersion.updateMany;

  VendorResponseQuestionnaireVersion.findOne = () => ({
    sort: () => ({ lean: async () => null }),
  });
  VendorResponseQuestionnaireVersion.create = async (row) => ({
    toObject: () => ({ ...row, _id: "row-1" }),
  });
  VendorResponseQuestionnaireVersion.updateMany = async () => {
    throw Object.assign(new Error("connection timed out"), { name: "MongoNetworkTimeoutError" });
  };

  const projection = projectProposalToVendorResponseQuestionnaire(
    require("../contracts/proposal/v1/legacyAdapter").mapLegacyProposalToV1(
      legacyProposal(),
      { organizationId, ownerUserId, now: fixedNow.toISOString() },
    ).proposal,
  );

  let result;
  try {
    result = await mongoVendorResponseQuestionnaireRepository.publish({
      organizationId,
      proposalId,
      proposalVersion: 1,
      projection,
      sourceChecksum: "a".repeat(64),
      publishedByActorId: ownerUserId,
      publishedAt: fixedNow,
    });
  } finally {
    VendorResponseQuestionnaireVersion.findOne = originalFindOne;
    VendorResponseQuestionnaireVersion.create = originalCreate;
    VendorResponseQuestionnaireVersion.updateMany = originalUpdateMany;
  }

  assert.equal(result.created, true);
  assert.equal(result.questionnaire.questionnaireVersion, 1);
  assert.equal(result.questionnaire.references.minimumCount, 3);
});
