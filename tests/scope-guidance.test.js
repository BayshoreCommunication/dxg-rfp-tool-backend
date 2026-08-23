const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SCOPE_RULES,
  SCOPE_RULESET_VERSION,
  computeScopeGuidance,
} = require("../src/modules/guidance/scopeRules");

const byRule = (findings, ruleId) =>
  findings.filter((finding) => finding.ruleId === ruleId);

test("scope rule registry is versioned, unique, and reviewable", () => {
  assert.ok(SCOPE_RULES.length >= 10);
  assert.equal(
    new Set(SCOPE_RULES.map((rule) => rule.id)).size,
    SCOPE_RULES.length,
  );
  for (const rule of SCOPE_RULES) {
    assert.equal(rule.version, SCOPE_RULESET_VERSION);
    assert.ok(rule.applicability.length > 0, rule.id);
    assert.ok(rule.requiredInputs.length > 0, rule.id);
    assert.ok(rule.affectedFields.length > 0, rule.id);
    assert.ok(rule.source, rule.id);
    assert.equal(typeof rule.evaluate, "function");
  }
});

test("missing room dependencies generate bounded questions", () => {
  const findings = computeScopeGuidance({
    roomByRoom: [
      {
        roomFunction: "General Session",
        largeMonitorsOrScreenProjector: {
          largeMonitorsOrScreenProjector: "YES",
        },
        audienceQa: { audienceQa: "YES" },
        videoPlayback: { videoPlayback: "YES" },
      },
    ],
  });
  for (const ruleId of [
    "DISPLAY_SURFACE_QUANTITY_MISSING",
    "AUDIENCE_QA_METHOD_MISSING",
    "PLAYBACK_CONTROL_MISSING",
    "VIDEO_LIGHTING_REVIEW_NEEDED",
  ]) {
    const finding = byRule(findings, ruleId)[0];
    assert.ok(finding, ruleId);
    assert.ok(finding.question, ruleId);
    assert.equal(finding.source, "approved_scope_rule");
    assert.ok(finding.paths.every((path) => path.startsWith("/content/")));
  }
});

test("standalone recording rules remain registered but inactive", () => {
  const findings = computeScopeGuidance({
    videoRecordingStep: {
      videoRecordingRequired: "YES",
      numberOfCameras: "3",
      cameraOperators: "1",
    },
  });
  for (const ruleId of [
    "CAMERA_COUNT_MISSING",
    "CAMERA_OPERATOR_CAPACITY",
    "RECORDING_DELIVERY_MISSING",
  ]) {
    assert.ok(SCOPE_RULES.some((rule) => rule.id === ruleId), `${ruleId} remains restorable`);
    assert.equal(byRule(findings, ruleId).length, 0, `${ruleId} is inactive`);
  }
});

test("room recording data never reactivates retired proposal-level rules", () => {
  const findings = computeScopeGuidance({
    videoRecordingStep: { videoRecordingRequired: "YES" },
    roomByRoom: [{ cameras: { cameras: "Yes", cameraPlanMode: "Vendor Recommendation" } }],
  });
  assert.equal(byRule(findings, "CAMERA_COUNT_MISSING").length, 0);
});

test("hybrid scope requires connectivity and production ownership", () => {
  const findings = computeScopeGuidance({
    event: { eventFormat: "Hybrid" },
    hybridVirtual: { streamingPlatform: "Zoom Events" },
    venue: {},
  });
  assert.ok(byRule(findings, "STREAMING_CONNECTIVITY_UNDEFINED")[0]);
  assert.ok(byRule(findings, "HYBRID_PRODUCTION_OWNER_MISSING")[0]);
});

test("venue dependencies and possible duplicate rentals are labeled, not guessed", () => {
  const findings = computeScopeGuidance({
    venueSchedule: {},
    venue: {
      inHouseAvCompanyName: "Venue AV",
      riggingRequired: "YES",
    },
    roomByRoom: [
      {
        roomFunction: "Ballroom",
        largeMonitorsOrScreenProjector: {
          largeMonitorsOrScreenProjector: "YES",
          numberOfScreens: "2",
        },
        wirelessMics: { wirelessMics: "YES", wirelessMicsQty: "8" },
        showCrewNeeded: ["A1"],
      },
    ],
  });
  assert.equal(
    byRule(findings, "VENUE_EQUIPMENT_DUPLICATION_REVIEW")[0].severity,
    "optional_optimization",
  );
  assert.equal(
    byRule(findings, "WIRELESS_CHANNEL_CAPACITY_CONFIRMATION")[0].severity,
    "needs_venue_confirmation",
  );
  assert.equal(
    byRule(findings, "RIGGING_DETAILS_MISSING")[0].severity,
    "needs_venue_confirmation",
  );
  assert.equal(
    byRule(findings, "LABOR_ACCESS_OR_UNION_INPUTS_MISSING")[0].severity,
    "insufficient_information",
  );
});

test("fully inapplicable scope produces no speculative findings", () => {
  assert.deepEqual(
    computeScopeGuidance({
      event: { eventFormat: "In-Person" },
      venueSchedule: { isUnionVenue: "NO" },
      roomByRoom: [],
    }),
    [],
  );
});
