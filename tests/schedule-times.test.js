const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatInstantInEventZone,
  ianaZoneForLabel,
  withEventZoneScheduleTimes,
} = require("../src/modules/liveAi/scheduleTimes");
const { proposalDraftEvidence } = require("../src/modules/liveAi/operations");

test("schedule instants are presented as the venue reading, not the UTC clock", () => {
  // 15:15Z on 10 Mar 2027 is 9:15 AM in Chicago (CST; DST starts the 14th).
  assert.equal(
    formatInstantInEventZone("2027-03-10T15:15:00.000Z", "Central Time (CT)"),
    "2027-03-10 09:15 AM CT",
  );
  // After the change to daylight time the same wall clock is an hour earlier in UTC.
  assert.equal(
    formatInstantInEventZone("2027-03-15T14:15:00.000Z", "Central Time (CT)"),
    "2027-03-15 09:15 AM CT",
  );
  assert.equal(
    formatInstantInEventZone("2027-03-10T17:00:00.000Z", "Pacific Time (PT)"),
    "2027-03-10 09:00 AM PT",
  );
});

test("an unknown zone or a non-instant leaves the value alone", () => {
  assert.equal(formatInstantInEventZone("2027-03-10T15:15:00.000Z", "Other / International"), null);
  assert.equal(formatInstantInEventZone("2027-03-10T15:15:00.000Z", ""), null);
  assert.equal(formatInstantInEventZone("sometime tuesday", "Central Time (CT)"), null);
  assert.equal(formatInstantInEventZone(1234, "Central Time (CT)"), null);
  assert.equal(ianaZoneForLabel("Other / International"), null);
  assert.equal(ianaZoneForLabel("Central Time (CT)"), "America/Chicago");
});

test("only schedule keys are rewritten, nested through rooms and functions", () => {
  const rooms = [
    {
      roomLocation: "Grand Ballroom",
      // Not a schedule key: an instant here must survive untouched.
      createdAt: "2027-03-10T15:15:00.000Z",
      loadInDateTime: "2027-03-10T12:00:00.000Z",
      functions: [
        { functionName: "Opening Keynote", showStartDateTime: "2027-03-10T15:15:00.000Z", showEndDateTime: "2027-03-10T17:30:00.000Z" },
      ],
    },
  ];
  const converted = withEventZoneScheduleTimes(rooms, "Central Time (CT)");
  assert.equal(converted[0].functions[0].showStartDateTime, "2027-03-10 09:15 AM CT");
  assert.equal(converted[0].functions[0].showEndDateTime, "2027-03-10 11:30 AM CT");
  assert.equal(converted[0].loadInDateTime, "2027-03-10 06:00 AM CT");
  assert.equal(converted[0].createdAt, "2027-03-10T15:15:00.000Z");
  assert.equal(converted[0].roomLocation, "Grand Ballroom");
  // The original is not mutated.
  assert.equal(rooms[0].functions[0].showStartDateTime, "2027-03-10T15:15:00.000Z");
});

test("draft evidence carries venue-local show times", () => {
  const evidence = proposalDraftEvidence({
    venueSchedule: { timeZone: "Central Time (CT)", venueCity: "Chicago" },
    roomByRoom: [
      { roomLocation: "Grand Ballroom", functions: [{ functionName: "Opening Keynote", showStartDateTime: "2027-03-10T15:15:00.000Z" }] },
    ],
  });
  const rooms = evidence.find((item) => item.id === "/content/roomByRoom");
  assert.ok(rooms, "room evidence missing");
  assert.equal(rooms.value[0].functions[0].showStartDateTime, "2027-03-10 09:15 AM CT");
});

test("without a known event zone the stored instant is passed through", () => {
  const evidence = proposalDraftEvidence({
    venueSchedule: { timeZone: "Other / International" },
    roomByRoom: [{ functions: [{ showStartDateTime: "2027-03-10T15:15:00.000Z" }] }],
  });
  const rooms = evidence.find((item) => item.id === "/content/roomByRoom");
  assert.equal(rooms.value[0].functions[0].showStartDateTime, "2027-03-10T15:15:00.000Z");
});
