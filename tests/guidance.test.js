const test = require("node:test"),
  assert = require("node:assert/strict");
const { computeGuidance, guidanceEnabled } = require("../src/modules/guidance/domain");

const withEnv = (overrides, fn) => {
  const saved = {};
  for (const key of Object.keys(overrides)) { saved[key] = process.env[key]; if (overrides[key] === undefined) delete process.env[key]; else process.env[key] = overrides[key]; }
  try { fn(); } finally { for (const key of Object.keys(saved)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
};

test("guidance is gated by environment authorization and flag", () => {
  withEnv({ AI_ENVIRONMENT: undefined, NODE_ENV: "production", GUIDANCE_ENABLED: "true" }, () => assert.equal(guidanceEnabled(), false));
  withEnv({ AI_ENVIRONMENT: "staging", NODE_ENV: "production", GUIDANCE_ENABLED: "true" }, () => assert.equal(guidanceEnabled(), true));
  withEnv({ AI_ENVIRONMENT: "staging", NODE_ENV: "production", GUIDANCE_ENABLED: undefined }, () => assert.equal(guidanceEnabled(), false));
});

test("empty proposals score low and sparse sections are reported", () => {
  const result = computeGuidance({});
  assert.equal(result.overall, 0);
  assert.ok(result.completeness.length >= 8);
  assert.ok(result.findings.some((f) => f.code.startsWith("SECTION_SPARSE_")));
});

test("schedule conflicts produce blocking findings with field paths", () => {
  const result = computeGuidance({
    event: { startDate: "2026-09-10", endDate: "2026-09-08" },
    venueSchedule: { loadInDate: "2026-09-12", showStartDate: "2026-09-09" },
  });
  const reversed = result.findings.find((f) => f.code === "EVENT_DATES_REVERSED");
  assert.equal(reversed.severity, "blocking");
  assert.deepEqual(reversed.paths, ["/content/event/startDate", "/content/event/endDate"]);
  assert.ok(result.findings.some((f) => f.code === "LOAD_IN_AFTER_SHOW" && f.severity === "blocking"));
});

test("production and risk rules fire on realistic inconsistencies", () => {
  const result = computeGuidance({
    event: { eventName: "Summit", eventFormat: "Hybrid", startDate: "2026-09-10", endDate: "2026-09-11" },
    venueSchedule: { numberOfEventRooms: "4", isUnionVenue: "YES" },
    roomByRoom: [{}, {}],
    videoRecordingStep: { videoRecordingRequired: "YES" },
    budget: { proposalSubmissionDueDate: "2026-09-15" },
  });
  const codes = result.findings.map((f) => f.code);
  for (const expected of ["ROOM_COUNT_MISMATCH", "STREAMING_PLATFORM_MISSING", "CAMERA_COUNT_MISSING", "UNION_JURISDICTIONS_MISSING", "PROPOSAL_DUE_AFTER_EVENT"])
    assert.ok(codes.includes(expected), expected);
});

test("a consistent proposal produces no blocking findings", () => {
  const result = computeGuidance({
    event: { eventName: "Summit", eventFormat: "In-Person", startDate: "2026-09-10", endDate: "2026-09-11" },
    venueSchedule: { numberOfEventRooms: "1", loadInDate: "2026-09-09", showStartDate: "2026-09-10", showEndDate: "2026-09-11", strikeDate: "2026-09-11" },
    roomByRoom: [{}],
    budget: { estimatedAvBudget: "50k-100k", proposalSubmissionDueDate: "2026-08-15", vendorQuestionsDueDate: "2026-08-01" },
  });
  assert.equal(result.findings.filter((f) => f.severity === "blocking").length, 0);
  assert.ok(result.overall > 0);
});
