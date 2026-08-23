const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createCopyOwnedProposal,
  createCreateOwnedProposal,
  createUpdateOwnedProposal,
} = require("../src/modules/proposals/application/authorOwnedProposal");

const createDependencies = (capture = {}) => ({
  proposals: {
    createOwned: async (input) => {
      capture.create = input;
      return { _id: "created-001", ...input.proposal };
    },
    findOwnedCopySourceById: async (input) => {
      capture.sourceLookup = input;
      return {
        _id: "source-001",
        userId: "source-owner",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z",
        __v: 4,
        event: { eventName: "Original", startDate: "2026-08-01" },
        isActive: true,
        isFavorite: true,
        viewsCount: 99,
      };
    },
    updateOwnedById: async (input) => {
      capture.update = input;
      return { _id: input.proposalId, ...input.updates };
    },
  },
  settings: {
    findByUserId: async (userId, options) => {
      capture.settings = { userId, options };
      return { branding: { brandName: "DXG" } };
    },
  },
  references: {
    synchronize: async (input) => { capture.referenceSync = input; },
  },
});

test("create strips client-controlled system fields and normalizes drafts", async () => {
  const capture = {};
  const createProposal = createCreateOwnedProposal(createDependencies(capture));

  const result = await createProposal({
    ownerUserId: "user-001",
    proposal: {
      _id: "client-id",
      userId: "other-user",
      createdAt: "yesterday",
      proposalSetting: { injected: true },
      status: "draft",
      event: { eventName: "Summit" },
    },
  });

  assert.deepEqual(capture.create, {
    ownerUserId: "user-001",
    proposal: {
      status: "unsubmitted",
      event: { eventName: "Summit" },
      isDraft: true,
    },
  });
  assert.equal(result.proposalSetting.branding.brandName, "DXG");
});

test("full update protects ownership fields and applies submitted lifecycle", async () => {
  const capture = {};
  const updateProposal = createUpdateOwnedProposal(createDependencies(capture));

  const result = await updateProposal({
    proposalId: "proposal-001",
    ownerUserId: "user-001",
    updates: {
      _id: "replacement-id",
      userId: "other-user",
      isCopy: true,
      status: "submitted",
      event: { eventName: "Updated" },
    },
  });

  assert.deepEqual(capture.update, {
    proposalId: "proposal-001",
    ownerUserId: "user-001",
    updates: {
      status: "submitted",
      event: { eventName: "Updated" },
      isDraft: false,
      isActive: true,
      isCopy: false,
    },
    runValidators: true,
  });
  assert.equal(result.kind, "updated");
  assert.equal(capture.referenceSync.proposal._id, "proposal-001");
  assert.equal(capture.referenceSync.ownerUserId, "user-001");
});

test("missing or differently owned full update remains not found", async () => {
  const dependencies = createDependencies();
  dependencies.proposals.updateOwnedById = async () => null;
  const updateProposal = createUpdateOwnedProposal(dependencies);

  const result = await updateProposal({
    proposalId: "proposal-other-owner",
    ownerUserId: "user-001",
    updates: { status: "submitted" },
  });

  assert.deepEqual(result, { kind: "not_found" });
});

test("copy lookup and creation retain owner context and reset lifecycle", async () => {
  const capture = {};
  const copyProposal = createCopyOwnedProposal(createDependencies(capture));

  const result = await copyProposal({
    proposalId: "source-001",
    ownerUserId: "user-001",
    overrides: {
      eventName: "Copied Summit",
      endDate: "2026-08-03",
      templateId: "template-two",
      isDraft: true,
    },
  });

  assert.deepEqual(capture.sourceLookup, {
    proposalId: "source-001",
    ownerUserId: "user-001",
  });
  assert.equal(capture.create.ownerUserId, "user-001");
  assert.equal(capture.create.proposal.userId, undefined);
  assert.equal(capture.create.proposal._id, undefined);
  assert.deepEqual(capture.create.proposal.event, {
    eventName: "Copied Summit",
    startDate: "2026-08-01",
    endDate: "2026-08-03",
  });
  assert.equal(capture.create.proposal.status, "unsubmitted");
  assert.equal(capture.create.proposal.isCopy, true);
  assert.equal(capture.create.proposal.isActive, false);
  assert.equal(capture.create.proposal.isFavorite, false);
  assert.equal(capture.create.proposal.viewsCount, 0);
  assert.equal(capture.create.proposal.templateId, "template-two");
  assert.equal(result.kind, "copied");
});

test("copy ignores unsupported template and non-string event overrides", async () => {
  const capture = {};
  const copyProposal = createCopyOwnedProposal(createDependencies(capture));

  await copyProposal({
    proposalId: "source-001",
    ownerUserId: "user-001",
    overrides: { eventName: 42, templateId: "unsafe-template" },
  });

  assert.equal(capture.create.proposal.templateId, undefined);
  assert.equal(capture.create.proposal.event.eventName, "Original");
});

test("create, update, and copy do not write or propagate the dormant recording root", async () => {
  const createCapture = {};
  await createCreateOwnedProposal(createDependencies(createCapture))({
    ownerUserId: "user-001",
    proposal: {
      event: { eventName: "New" },
      videoRecordingStep: { videoRecordingRequired: "YES" },
      "videoRecordingStep.numberOfCameras": "7",
    },
  });
  assert.equal("videoRecordingStep" in createCapture.create.proposal, false);
  assert.equal("videoRecordingStep.numberOfCameras" in createCapture.create.proposal, false);

  const updateCapture = {};
  await createUpdateOwnedProposal(createDependencies(updateCapture))({
    proposalId: "proposal-001",
    ownerUserId: "user-001",
    updates: {
      event: { eventName: "Updated" },
      videoRecordingStep: { numberOfCameras: "4" },
      "videoRecordingStep.numberOfCameras": "11",
      "event.eventName": "Allowed active dotted update",
    },
  });
  assert.equal("videoRecordingStep" in updateCapture.update.updates, false);
  assert.equal("videoRecordingStep.numberOfCameras" in updateCapture.update.updates, false);
  assert.equal(updateCapture.update.updates["event.eventName"], "Allowed active dotted update");

  const copyCapture = {};
  const dependencies = createDependencies(copyCapture);
  dependencies.proposals.findOwnedCopySourceById = async () => ({
    event: { eventName: "Stored" },
    videoRecordingStep: { numberOfCameras: "9" },
    roomByRoom: [{ videoRecording: "Yes", camerasQty: "2" }],
  });
  await createCopyOwnedProposal(dependencies)({
    proposalId: "source-001", ownerUserId: "user-001", overrides: {},
  });
  assert.equal("videoRecordingStep" in copyCapture.create.proposal, false);
  assert.deepEqual(copyCapture.create.proposal.roomByRoom, [{ videoRecording: "Yes", camerasQty: "2" }]);
});
