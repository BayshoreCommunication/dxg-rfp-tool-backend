const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");
const proposalFormUi = require("../contracts/proposal/v1/proposal-form-ui.v1.json");

const {
  PROPOSAL_FORM_FIELD_GUIDANCE,
  PROPOSAL_FORM_GUIDANCE_VERSION,
  PROPOSAL_FORM_SCHEMA_LEAF_PATHS,
  ALL_PROPOSAL_FORM_SECTIONS,
  PROPOSAL_FORM_SECTIONS,
  PROPOSAL_FORM_UI_EXCLUSIONS,
  proposalFormGuidanceCoverage,
  proposalFormGuidanceEvidenceForField,
  proposalFormGuidanceEvidenceForQuery,
  proposalFormGuidanceForField,
} = require("../src/modules/platformAssistant/proposalFormGuidance");
const {
  isRetiredCanonicalProposalWorkflowPath,
} = require("../src/modules/proposals/domain/workflowSections");

const EXPECTED_PROPOSAL_FORM_SCHEMA_DIGEST =
  "7c28af9a162898c84309e4fdf85cc63f7b04f3db0ffa14289133ae43f207ccfb";

test("proposal field guidance covers the canonical form contract", () => {
  const coverage = proposalFormGuidanceCoverage();
  assert.equal(coverage.schemaLeafCount, 265);
  assert.equal(
    coverage.guidedFieldCount + coverage.excludedFieldCount,
    coverage.schemaLeafCount,
  );
  assert.deepEqual(coverage.uncoveredPaths, []);
  assert.equal(PROPOSAL_FORM_UI_EXCLUSIONS.size, 11);
  assert.equal(coverage.excludedFieldCount, 28);
});

test("proposal field registry has complete stable metadata", () => {
  assert.equal(PROPOSAL_FORM_GUIDANCE_VERSION, "proposal-form-guidance.v4");
  assert.equal(PROPOSAL_FORM_SECTIONS.length, 9);
  assert.equal(ALL_PROPOSAL_FORM_SECTIONS.length, 10);
  assert.ok(!PROPOSAL_FORM_SECTIONS.some((section) => section.id === "video_recording"));
  assert.ok(ALL_PROPOSAL_FORM_SECTIONS.some((section) => section.id === "video_recording"));
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
    assert.ok(Array.isArray(field.allowedOptions));
    assert.ok(Array.isArray(field.optionGroups));
    assert.ok(field.approvedSourceIds.includes("contract:proposal.v1"));
    assert.equal(field.applicationSchemaVersion, "proposal.v1");
    assert.equal(field.guidanceVersion, PROPOSAL_FORM_GUIDANCE_VERSION);
    assert.match(field.reviewDate, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("Event Overview UI metadata produces exact effective field guidance", () => {
  assert.equal(proposalFormUi.schemaVersion, "proposal-form-ui.v1");
  for (const fieldKey of Object.keys(proposalFormUi.fields)) {
    if (isRetiredCanonicalProposalWorkflowPath(fieldKey)) {
      assert.equal(proposalFormGuidanceForField(fieldKey), undefined);
    } else {
      assert.ok(
        proposalFormGuidanceForField(fieldKey),
        `${fieldKey} must resolve to canonical field guidance`,
      );
    }
  }

  const eventType = proposalFormGuidanceForField("/content/event/type");
  assert.equal(eventType?.requirement, "required");
  assert.equal(eventType?.fieldType, "select");
  assert.equal(eventType?.allowedOptions.length, 13);
  assert.ok(
    eventType?.allowedOptions.some(
      (option) => option.label === "Sales Kickoff (SKO)",
    ),
  );

  const audience = proposalFormGuidanceForField(
    "/content/event/primaryAudiences/*",
  );
  assert.equal(audience?.minimumSelections, 1);
  assert.equal(audience?.maximumSelections, 4);
  assert.equal(audience?.allowedOptions.length, 14);

  const tone = proposalFormGuidanceForField(
    "/content/event/toneDirections/*",
  );
  assert.equal(tone?.label, "Tone / Brand Direction");
  assert.equal(tone?.requirement, "optional");
  assert.equal(tone?.fieldType, "multi_select");
  assert.equal(tone?.maximumSelections, 5);
  assert.equal(tone?.optionGroups.length, 4);
  assert.equal(tone?.allowedOptions.length, 18);
  assert.match(tone?.goodExample ?? "", /Tech-Forward/);

  const evidence = proposalFormGuidanceEvidenceForField(
    "/content/event/toneDirections/*",
  );
  assert.match(evidence?.content ?? "", /Choose up to 5 available options/i);
  assert.match(evidence?.content ?? "", /Energy: High-Energy, Polished & Refined/i);
  assert.match(evidence?.content ?? "", /Color Direction: Dark \/ Cinematic/i);

  const website = proposalFormGuidanceForField("/content/event/website");
  assert.equal(website?.label, "Event Website");
  assert.equal(website?.requirement, "optional");
  assert.equal(website?.fieldType, "url");
  assert.match(website?.goodExample ?? "", /^https:\/\//);

  const recording = proposalFormGuidanceForField(
    "/content/videoRecording/required",
  );
  assert.equal(recording, undefined);
  assert.ok(
    proposalFormUi.fields["/content/videoRecording/required"],
    "legacy UI metadata remains available for restoration",
  );

  const investmentFlexibility = proposalFormGuidanceForField(
    "/content/budgetPreferences/flexibility",
  );
  assert.equal(investmentFlexibility?.label, "Investment Flexibility");
  assert.equal(investmentFlexibility?.requirement, "optional");
  assert.deepEqual(
    investmentFlexibility?.allowedOptions.map((option) => option.label),
    ["Fixed", "Flexible", "Value-Engineering Welcome", "Not Sure"],
  );
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

test("field-help prompts from the proposal UI resolve across intake sections", () => {
  const examples = [
    ["Event Name", /Event Overview: Event Name/],
    ["Venue Name", /Venue & Schedule: Venue Name/],
    ["Streaming Platform", /Hybrid & Virtual: Streaming Platform/],
    ["Camera Count", /Camera Count/],
    ["Primary Contact Email", /Contact & Submit: Email/],
    ["Virtual Attendee Estimate", /Hybrid & Virtual: Virtual Attendee Count/],
  ];

  for (const [visibleLabel, expectedTitle] of examples) {
    const evidence = proposalFormGuidanceEvidenceForQuery(
      `What should I enter for the "${visibleLabel}" field? Explain it simply and give me one short example.`,
      3,
    );
    assert.ok(evidence.length > 0, `${visibleLabel} should return guidance`);
    assert.match(evidence[0].title, expectedTitle);
    assert.equal(evidence[0].href, "/proposals/add-new-proposal");
  }
});

test("conditional field guidance retains machine-readable dependencies", () => {
  const streaming = proposalFormGuidanceForField(
    "/content/hybridVirtual/streamingPlatform",
  );
  assert.equal(streaming?.requirement, "conditional");
  assert.ok(streaming?.dependencies.includes("/content/event/format"));

  assert.equal(
    proposalFormGuidanceForField("/content/videoRecording/cameraCount"),
    undefined,
  );
});
