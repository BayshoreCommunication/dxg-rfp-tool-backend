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

test("completeness weights the fields a vendor cannot quote without", () => {
  // Every one of the 114 whitelisted paths counted equally, so answering
  // optional questions about sponsor overlays scored the same as naming the
  // event. A planner could see a healthy percentage on a proposal no vendor
  // could price.
  const essentialsOnly = {
    event: { eventName: "Gala", eventFormat: "in_person", startDate: "2026-09-01", endDate: "2026-09-02", attendees: "500" },
    venueSchedule: { venueName: "Hall", venueCity: "Tampa", venueState: "FL", numberOfEventRooms: "3", loadInDate: "2026-08-31", showStartDate: "2026-09-01", showEndDate: "2026-09-02" },
    venue: { inHouseAvRequired: "yes" },
    videoRecordingStep: { videoRecordingRequired: "yes" },
    budget: { estimatedAvBudget: "100000", proposalSubmissionDueDate: "2026-08-01" },
  };
  const trimmingsOnly = {
    hybridVirtual: { sponsorOverlays: "yes", virtualNetworking: "yes", virtualBackgroundDesign: "yes", liveVirtualQa: "yes", onDemandRecording: "yes", closedCaptions: { closedCaptions: "yes", captionType: "live" }, streamingPlatform: "zoom", streamOwnership: "client", dedicatedVirtualProducer: "yes", virtualOnlyBreakouts: "no", platformIntegrationWithAv: "yes", virtualAttendeeEstimate: "200" },
    contentCreative: { contentServicesNeeded: "yes", presentationTemplateDesign: "yes", speakerSlideCollection: "yes", motionGraphicsOpenerVideo: "yes", lowerThirdsNameSupers: "yes", eventLogoBrandStandards: "yes", sizzleRecapVideo: "yes", sponsorRecognitionContent: "yes", socialMediaContentCapture: "yes", virtualBackgroundDesign: "yes", creativeDirectionNotes: "notes" },
  };

  const withEssentials = computeGuidance(essentialsOnly);
  const withTrimmings = computeGuidance(trimmingsOnly);

  // 16 essentials vs 23 optional answers: unweighted, the second proposal wins.
  assert.ok(
    withEssentials.overall > withTrimmings.overall,
    `a quotable proposal must outscore an unquotable one (${withEssentials.overall} vs ${withTrimmings.overall})`,
  );
  assert.ok(!withEssentials.findings.some((f) => f.code === "ESSENTIALS_MISSING"));

  // The percentage says how far along; this says what to do next.
  const missing = withTrimmings.findings.find((f) => f.code === "ESSENTIALS_MISSING");
  assert.equal(missing.severity, "warning");
  assert.equal(missing.paths.length, 16);
  assert.ok(missing.paths.includes("/content/event/eventName"));
  assert.match(missing.message, /16 fields vendors need in order to quote are still empty\./);
});

test("every essential path is one the proposal can actually hold", () => {
  // A typo in the weight table would silently weight nothing, and the missing-
  // essentials finding would point at a path the dashboard cannot open.
  const { approvedCandidatePaths } = require("../src/modules/candidateApplication/canonicalMapping");
  const approved = new Set(approvedCandidatePaths);
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "src/modules/guidance/domain.ts"), "utf8",
  );
  const table = source.slice(source.indexOf("const ESSENTIAL_PATHS"), source.indexOf("const SECTION_LABELS"));
  const paths = [...table.matchAll(/"(\/content\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(paths.length, 16, "the table is the one being checked");
  for (const path of paths) assert.ok(approved.has(path), `essential path is on the whitelist: ${path}`);
});
