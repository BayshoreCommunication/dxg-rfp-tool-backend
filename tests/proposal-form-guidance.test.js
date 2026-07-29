const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");

const {
  PROPOSAL_FORM_FIELD_GUIDANCE,
  PROPOSAL_FORM_GUIDANCE_VERSION,
  PROPOSAL_FORM_SCHEMA_LEAF_PATHS,
  PROPOSAL_FORM_SECTIONS,
  PROPOSAL_FORM_UI_EXCLUSIONS,
  proposalFormGuidanceCoverage,
  proposalFormGuidanceEvidenceForField,
  proposalFormGuidanceEvidenceForQuery,
  proposalFormGuidanceForField,
} = require("../src/modules/platformAssistant/proposalFormGuidance");

const EXPECTED_PROPOSAL_FORM_SCHEMA_DIGEST =
  "2784bb0c5787fea23d607781eae257f9a7f3355dde624ea4920cba9458ee8e5e";

test("proposal field guidance covers the canonical form contract", () => {
  const coverage = proposalFormGuidanceCoverage();
  assert.equal(coverage.schemaLeafCount, 242);
  assert.equal(
    coverage.guidedFieldCount + coverage.excludedFieldCount,
    coverage.schemaLeafCount,
  );
  assert.deepEqual(coverage.uncoveredPaths, []);
  assert.equal(PROPOSAL_FORM_UI_EXCLUSIONS.size, 11);
});

test("proposal field registry has complete stable metadata", () => {
  assert.equal(PROPOSAL_FORM_GUIDANCE_VERSION, "proposal-form-guidance.v1");
  assert.equal(PROPOSAL_FORM_SECTIONS.length, 10);
  assert.equal(
    new Set(PROPOSAL_FORM_SECTIONS.map((section) => section.id)).size,
    PROPOSAL_FORM_SECTIONS.length,
  );
  assert.equal(
    new Set(PROPOSAL_FORM_FIELD_GUIDANCE.map((field) => field.fieldKey)).size,
    PROPOSAL_FORM_FIELD_GUIDANCE.length,
  );
  for (const field of PROPOSAL_FORM_FIELD_GUIDANCE) {
    assert.equal(field.fieldKey, field.canonicalPath);
    assert.match(field.fieldKey, /^\/content\//);
    assert.ok(field.sectionId);
    assert.ok(field.sectionLabel);
    assert.ok(field.label);
    assert.ok(["required", "optional", "conditional"].includes(field.requirement));
    assert.ok(field.purpose.length > 20);
    assert.ok(field.entryGuidance.length > 20);
    assert.ok(field.goodExample);
    assert.ok(field.commonMistakes.length >= 1);
    assert.ok(field.followUpQuestions.length >= 1);
    assert.ok(field.approvedSourceIds.includes("contract:proposal.v1"));
    assert.equal(field.applicationSchemaVersion, "proposal.v1");
    assert.equal(field.guidanceVersion, PROPOSAL_FORM_GUIDANCE_VERSION);
    assert.match(field.reviewDate, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("schema field inventory digest detects unreviewed additions, removals, and renames", () => {
  const digest = createHash("sha256")
    .update(PROPOSAL_FORM_SCHEMA_LEAF_PATHS.join("\n"))
    .digest("hex");
  assert.equal(digest, EXPECTED_PROPOSAL_FORM_SCHEMA_DIGEST);
});

test("exact, natural-language, and unknown field guidance degrade safely", () => {
  const sacred = proposalFormGuidanceForField(
    "/content/event/sacredConstraints",
  );
  assert.equal(sacred?.label, "Sacred Constraints");
  assert.equal(sacred?.sectionLabel, "Event Overview");
  assert.match(sacred?.purpose ?? "", /non-negotiable/i);

  const evidence = proposalFormGuidanceEvidenceForField(
    "/content/event/sacredConstraints",
  );
  assert.equal(evidence?.releaseId, PROPOSAL_FORM_GUIDANCE_VERSION);
  assert.match(evidence?.href ?? "", /^\/proposals\/add-new-proposal$/);

  const selected = proposalFormGuidanceEvidenceForQuery(
    "What is a sacred constraint and what should I enter?",
  );
  assert.ok(selected.some((item) => item.title.includes("Sacred Constraints")));

  assert.equal(proposalFormGuidanceForField("/content/unknown"), undefined);
  assert.equal(
    proposalFormGuidanceEvidenceForField("/content/unknown"),
    undefined,
  );
});

test("conditional field guidance retains machine-readable dependencies", () => {
  const streaming = proposalFormGuidanceForField(
    "/content/hybridVirtual/streamingPlatform",
  );
  assert.equal(streaming?.requirement, "conditional");
  assert.ok(streaming?.dependencies.includes("/content/event/format"));

  const cameraCount = proposalFormGuidanceForField(
    "/content/videoRecording/cameraCount",
  );
  assert.equal(cameraCount?.requirement, "conditional");
  assert.ok(
    cameraCount?.dependencies.includes("/content/videoRecording/required"),
  );
});
