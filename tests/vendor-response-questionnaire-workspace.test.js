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
});
