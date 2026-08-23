const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PROPOSAL_WORKFLOW_SECTION_AVAILABILITY,
  proposalWorkflowSectionEnabled,
  isRetiredLegacyProposalWorkflowPath,
  isRetiredCanonicalProposalWorkflowPath,
  activeProposalWorkflowContent,
} = require("../src/modules/proposals/domain/workflowSections");

test("standalone video recording is centrally retired and trivially reversible", () => {
  assert.equal(PROPOSAL_WORKFLOW_SECTION_AVAILABILITY.video_recording, false);
  assert.equal(proposalWorkflowSectionEnabled("video_recording"), false);
  assert.equal(proposalWorkflowSectionEnabled("room_specifications"), true);
});

test("active proposal projection removes only standalone recording without mutating storage", () => {
  const stored = {
    event: { eventName: "Summit" },
    videoRecordingStep: { videoRecordingRequired: "YES", numberOfCameras: "8" },
    "videoRecordingStep.numberOfCameras": "12",
    "event.eventName": "Dotted but active",
    roomByRoom: [{ roomFunction: "General Session", videoRecording: "Yes", camerasQty: "3" }],
    hybridVirtual: { onDemandRecording: "YES" },
  };
  const active = activeProposalWorkflowContent(stored);
  assert.equal("videoRecordingStep" in active, false);
  assert.equal("videoRecordingStep.numberOfCameras" in active, false);
  assert.equal(active["event.eventName"], "Dotted but active");
  assert.deepEqual(active.roomByRoom, stored.roomByRoom);
  assert.deepEqual(active.hybridVirtual, stored.hybridVirtual);
  assert.equal(stored.videoRecordingStep.numberOfCameras, "8");
});

test("workflow fingerprints ignore dormant data and Mongo bookkeeping only", () => {
  const { activeProposalWorkflowFingerprintContent } = require("../src/modules/proposals/domain/workflowSections");
  const before = activeProposalWorkflowFingerprintContent({
    __v: 2,
    version: 7,
    candidateApplicationIds: ["old"],
    status: "unsubmitted",
    updatedAt: new Date("2026-01-01"),
    event: { eventName: "Summit" },
    videoRecordingStep: { numberOfCameras: "3" },
  });
  const afterDormantWrite = activeProposalWorkflowFingerprintContent({
    __v: 3,
    version: 8,
    candidateApplicationIds: ["new"],
    status: "unsubmitted",
    updatedAt: new Date("2026-02-01"),
    event: { eventName: "Summit" },
    videoRecordingStep: { numberOfCameras: "99" },
  });
  assert.deepEqual(afterDormantWrite, before);
  assert.notDeepEqual(
    activeProposalWorkflowFingerprintContent({
      event: { eventName: "Summit" },
      status: "submitted",
    }),
    activeProposalWorkflowFingerprintContent({
      event: { eventName: "Summit" },
      status: "unsubmitted",
    }),
  );
  assert.notDeepEqual(
    activeProposalWorkflowFingerprintContent({
      __v: 3,
      event: { eventName: "Summit" },
      status: "unsubmitted",
      roomByRoom: [{ videoRecording: { videoRecording: "Yes" } }],
    }),
    before,
  );
});

test("retired path predicates match only the standalone legacy and canonical roots", () => {
  for (const path of [
    "/content/videoRecordingStep",
    "/content/videoRecordingStep/videoRecordingRequired",
    "/content/videoRecordingStep/editedDeliverable/needed",
  ]) assert.equal(isRetiredLegacyProposalWorkflowPath(path), true, path);

  for (const path of [
    "/content/videoRecording",
    "/content/videoRecording/required",
    "/content/videoRecording/editedDeliverable/types/*",
  ]) assert.equal(isRetiredCanonicalProposalWorkflowPath(path), true, path);

  for (const path of [
    "/content/roomByRoom/0/videoRecording/videoRecording",
    "/content/rooms/*/video/videoRecordingRequired",
    "/content/hybridVirtual/onDemandRecording",
    "/content/contentCreative/sizzleRecapVideo",
  ]) {
    assert.equal(isRetiredLegacyProposalWorkflowPath(path), false, path);
    assert.equal(isRetiredCanonicalProposalWorkflowPath(path), false, path);
  }
});

test("proposal reference backfill fingerprints active content only", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(
      __dirname,
      "../scripts/backfillPostgresProposalReferences.ts",
    ),
    "utf8",
  );
  assert.match(source, /activeProposalWorkflowFingerprintContent/);
  assert.match(source, /sourceVersion: activeChecksum/);
  assert.match(source, /sourceChecksum: activeChecksum/);
  assert.doesNotMatch(source, /sourceUpdatedAt: proposal\.updatedAt/);
});
