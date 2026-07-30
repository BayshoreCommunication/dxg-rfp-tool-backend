const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ROOM_RELOCATION_MINUTES,
  ROOM_SCHEDULE_ANALYSIS_VERSION,
  computeRoomScheduleAnalysis,
} = require("../src/modules/guidance/roomScheduleAnalysis");
const { computeGuidance } = require("../src/modules/guidance/domain");

const room = (overrides = {}) => ({
  _id: "room-a",
  roomFunction: "General Session",
  roomSetup: "Theater",
  estimatedAttendeesInRoom: "500",
  showStartDateTime: "2026-10-01T09:00:00.000Z",
  showEndDateTime: "2026-10-01T10:00:00.000Z",
  ...overrides,
});

test("room analysis reports bounded missing inputs and deferred subtotals", () => {
  const result = computeRoomScheduleAnalysis({ roomByRoom: [{}] });
  assert.equal(result.version, ROOM_SCHEDULE_ANALYSIS_VERSION);
  assert.equal(result.roomCount, 1);
  assert.equal(result.confidence, "low");
  assert.ok(result.roomLevelGapIds.length > 0);
  assert.ok(result.missingInputIds.length > 0);
  assert.deepEqual(result.roomSubtotals[0], {
    roomKey: "room-1",
    roomLabel: "Room 1",
    status: "pricing_not_evaluated",
    amountMinor: null,
    currency: null,
    reason:
      "Room scope is analyzed here; authoritative pricing is calculated separately.",
  });
  assert.equal(result.sharedServicesSubtotal.amountMinor, null);
});

test("reversed room windows and late setup events are deterministic conflicts", () => {
  const result = computeRoomScheduleAnalysis({
    roomByRoom: [
      room({
        loadInDateTime: "2026-10-01T11:00:00.000Z",
        rehearsalDateTime: "2026-10-01T10:30:00.000Z",
        showStartDateTime: "2026-10-01T10:00:00.000Z",
        showEndDateTime: "2026-10-01T09:00:00.000Z",
      }),
    ],
  });
  const codes = result.findings.map((finding) => finding.code);
  assert.ok(codes.includes("ROOM_SHOW_WINDOW_REVERSED"));
  assert.ok(codes.includes("ROOM_LOAD_IN_AFTER_SHOW_START"));
  assert.ok(codes.includes("ROOM_REHEARSAL_AFTER_SHOW_START"));
  assert.equal(
    result.findings.find(
      (finding) => finding.code === "ROOM_SHOW_WINDOW_REVERSED",
    ).severity,
    "blocking",
  );
});

test("overlapping rooms identify crew and physical-resource conflicts", () => {
  const result = computeRoomScheduleAnalysis({
    roomByRoom: [
      room({
        _id: "main",
        showCrewNeeded: ["V1"],
        showCrewQty: { V1: "1" },
        wirelessMics: { wirelessMics: "YES", wirelessMicsQty: "4" },
      }),
      room({
        _id: "breakout",
        roomFunction: "Breakout",
        showStartDateTime: "2026-10-01T09:30:00.000Z",
        showEndDateTime: "2026-10-01T10:30:00.000Z",
        showCrewNeeded: ["V1"],
        showCrewQty: { V1: "1" },
        wirelessMics: { wirelessMics: "YES", wirelessMicsQty: "2" },
      }),
    ],
  });
  const crew = result.findings.find(
    (finding) => finding.code === "SIMULTANEOUS_CREW_ROLE_CONFLICT",
  );
  const inventory = result.findings.find(
    (finding) => finding.code === "SIMULTANEOUS_RESOURCE_CAPACITY_REVIEW",
  );
  assert.deepEqual(crew.roomKeys, ["main", "breakout"]);
  assert.ok(crew.explanation.includes("One person cannot cover both rooms"));
  assert.deepEqual(inventory.reusableResourceKeys, ["wireless_microphone"]);
  assert.equal(result.crewConflictIds.length, 1);
  assert.equal(result.scheduleConflictIds.length, 1);
});

test("non-overlapping matching scope becomes a conditional reuse opportunity", () => {
  const gap = ROOM_RELOCATION_MINUTES + 30;
  const result = computeRoomScheduleAnalysis({
    roomByRoom: [
      room({
        _id: "morning",
        cameras: { cameras: "YES", camerasQty: "2" },
      }),
      room({
        _id: "afternoon",
        roomFunction: "Afternoon Session",
        showStartDateTime: `2026-10-01T${String(10 + gap / 60).padStart(2, "0")}:00:00.000Z`,
        showEndDateTime: "2026-10-01T14:00:00.000Z",
        cameras: { cameras: "YES", camerasQty: "2" },
      }),
    ],
  });
  const opportunity = result.findings.find(
    (finding) =>
      finding.code === "NON_OVERLAPPING_RESOURCE_REUSE_OPPORTUNITY",
  );
  assert.ok(opportunity);
  assert.equal(opportunity.confidence, "medium");
  assert.equal(opportunity.duplicateRentalReview, true);
  assert.deepEqual(opportunity.reusableResourceKeys, ["camera"]);
  assert.deepEqual(result.duplicateRentalIds, [opportunity.id]);
  assert.ok(opportunity.question.includes("transport"));
});

test("a short turnover never claims that equipment can be reused", () => {
  const result = computeRoomScheduleAnalysis({
    roomByRoom: [
      room({
        cameras: { cameras: "YES", camerasQty: "2" },
      }),
      room({
        _id: "room-b",
        roomFunction: "Breakout",
        showStartDateTime: "2026-10-01T10:30:00.000Z",
        showEndDateTime: "2026-10-01T11:30:00.000Z",
        cameras: { cameras: "YES", camerasQty: "2" },
      }),
    ],
  });
  assert.equal(result.reusableEquipmentOpportunityIds.length, 0);
  assert.equal(result.duplicateRentalIds.length, 0);
});

test("proposal guidance preserves room analysis and maps its findings", () => {
  const result = computeGuidance({
    roomByRoom: [
      room({
        showStartDateTime: "2026-10-01T10:00:00.000Z",
        showEndDateTime: "2026-10-01T09:00:00.000Z",
      }),
    ],
  });
  assert.equal(result.analysisVersion, "proposal-analysis.v3");
  assert.equal(result.roomSchedule.version, ROOM_SCHEDULE_ANALYSIS_VERSION);
  const finding = result.findings.find(
    (item) => item.code === "ROOM_SHOW_WINDOW_REVERSED",
  );
  assert.equal(finding.roomCategory, "schedule_conflict");
  assert.deepEqual(finding.roomKeys, ["room-a"]);
  assert.equal(finding.provenance.ruleVersion, ROOM_SCHEDULE_ANALYSIS_VERSION);
});

test("room analysis persistence is tenant-report scoped and versioned", () => {
  const root = path.resolve(__dirname, "..");
  const up = fs.readFileSync(
    path.join(root, "migrations/postgres/036_room_schedule_analysis.up.sql"),
    "utf8",
  );
  const down = fs.readFileSync(
    path.join(root, "migrations/postgres/036_room_schedule_analysis.down.sql"),
    "utf8",
  );
  const repository = fs.readFileSync(
    path.join(root, "src/modules/guidance/postgresGuidanceRepository.ts"),
    "utf8",
  );
  assert.ok(up.includes("ADD COLUMN room_schedule_analysis jsonb"));
  assert.ok(up.includes("proposal-analysis.v3"));
  assert.ok(down.includes("DROP COLUMN IF EXISTS room_schedule_analysis"));
  assert.ok(repository.includes("JSON.stringify(result.roomSchedule)"));
  assert.ok(repository.includes("row.room_schedule_analysis"));
});
