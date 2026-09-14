require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");

const Proposal = require("../modal/proposalsModel").default;
const QuestionnaireVersion = require("../modal/vendorResponseQuestionnaireVersionModel").default;
const {
  mongoVendorResponseQuestionnaireRepository: repository,
} = require("../src/modules/vendorResponses/infrastructure/mongo/mongoVendorResponseQuestionnaireRepository");
const {
  buildVendorResponseQuestionnaire,
} = require("./fixtures/vendorResponseV1");

const organizationId = "507f1f77bcf86cd799439012";
const proposalId = "507f1f77bcf86cd799439011";
const ownerUserId = "507f1f77bcf86cd799439013";

const projectionFixture = () => {
  const questionnaire = buildVendorResponseQuestionnaire();
  questionnaire.proposalId = proposalId;
  questionnaire.questionnaireId = `vendor-questionnaire-${proposalId}`;
  const {
    questionnaireVersion: _questionnaireVersion,
    questionnaireChecksum: _questionnaireChecksum,
    publishedAt: _publishedAt,
    ...projection
  } = questionnaire;
  return projection;
};

test("proposal loading scopes Mongo reads by tenant, proposal, and optional owner", async () => {
  const original = Proposal.findOne;
  let capturedFilter;
  Proposal.findOne = (filter) => {
    capturedFilter = filter;
    return {
      select: () => ({
        lean: async () => ({
          _id: proposalId,
          organizationId,
          userId: ownerUserId,
          status: "submitted",
          isDraft: false,
          isActive: true,
          isOpen: true,
          isArchived: false,
          proposalSettings: { vendorResponseFormat: "structured_v1" },
        }),
      }),
    };
  };

  try {
    const result = await repository.loadProposal({ organizationId, proposalId, ownerUserId });
    assert.deepEqual(capturedFilter, {
      _id: proposalId,
      organizationId,
      userId: ownerUserId,
    });
    assert.equal(result.organizationId, organizationId);
    assert.equal(result.ownerUserId, ownerUserId);
    assert.equal(result.responseFormat, "structured_v1");
    assert.equal(result.legacyProposal._id, proposalId);
  } finally {
    Proposal.findOne = original;
  }
});

test("proposal rollout marker updates are tenant and owner scoped", async () => {
  const original = Proposal.updateOne;
  let capturedFilter;
  let capturedUpdate;
  Proposal.updateOne = async (filter, update) => {
    capturedFilter = filter;
    capturedUpdate = update;
    return { matchedCount: 1 };
  };
  try {
    const updated = await repository.setResponseFormat({
      organizationId,
      proposalId,
      ownerUserId,
      responseFormat: "legacy_unstructured",
    });
    assert.equal(updated, true);
    assert.deepEqual(capturedFilter, {
      _id: proposalId,
      organizationId,
      userId: ownerUserId,
    });
    assert.equal(
      capturedUpdate.$set["proposalSettings.vendorResponseFormat"],
      "legacy_unstructured",
    );
  } finally {
    Proposal.updateOne = original;
  }
});

test("unchanged publication returns the existing immutable version", async () => {
  const originalFind = QuestionnaireVersion.findOne;
  const originalCreate = QuestionnaireVersion.create;
  let createCalled = false;
  QuestionnaireVersion.findOne = () => ({
    sort: () => ({
      lean: async () => ({
        sourceChecksum: "a".repeat(64),
        questionnaireVersion: 3,
        questionnaire: buildVendorResponseQuestionnaire(),
      }),
    }),
  });
  QuestionnaireVersion.create = async () => {
    createCalled = true;
    throw new Error("must not create");
  };

  try {
    const result = await repository.publish({
      organizationId,
      proposalId,
      proposalVersion: 4,
      projection: projectionFixture(),
      sourceChecksum: "a".repeat(64),
      publishedByActorId: ownerUserId,
      publishedAt: new Date("2026-09-14T12:00:00.000Z"),
    });
    assert.equal(result.created, false);
    assert.equal(createCalled, false);
  } finally {
    QuestionnaireVersion.findOne = originalFind;
    QuestionnaireVersion.create = originalCreate;
  }
});

test("changed publication creates version n plus one and supersedes only older published rows", async () => {
  const originals = {
    findOne: QuestionnaireVersion.findOne,
    create: QuestionnaireVersion.create,
    updateMany: QuestionnaireVersion.updateMany,
  };
  let createdInput;
  let updateFilter;
  let updateBody;
  QuestionnaireVersion.findOne = () => ({
    sort: () => ({
      lean: async () => ({
        sourceChecksum: "b".repeat(64),
        questionnaireVersion: 3,
        questionnaire: buildVendorResponseQuestionnaire(),
      }),
    }),
  });
  QuestionnaireVersion.create = async (input) => {
    createdInput = input;
    return { toObject: () => input };
  };
  QuestionnaireVersion.updateMany = async (filter, body) => {
    updateFilter = filter;
    updateBody = body;
    return { modifiedCount: 1 };
  };

  try {
    const result = await repository.publish({
      organizationId,
      proposalId,
      proposalVersion: 5,
      projection: projectionFixture(),
      sourceChecksum: "c".repeat(64),
      publishedByActorId: ownerUserId,
      publishedAt: new Date("2026-09-14T12:00:00.000Z"),
    });
    assert.equal(result.created, true);
    assert.equal(createdInput.questionnaireVersion, 4);
    assert.equal(createdInput.questionnaire.questionnaireVersion, 4);
    assert.equal(createdInput.status, "published");
    assert.equal(createdInput.responseFormat, "structured_v1");
    assert.deepEqual(updateFilter, {
      organizationId,
      proposalId,
      questionnaireVersion: { $lt: 4 },
      status: "published",
    });
    assert.equal(updateBody.$set.status, "superseded");
  } finally {
    QuestionnaireVersion.findOne = originals.findOne;
    QuestionnaireVersion.create = originals.create;
    QuestionnaireVersion.updateMany = originals.updateMany;
  }
});
