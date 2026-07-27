const test = require("node:test");
const assert = require("node:assert/strict");

const { proposalDraftEvidence, supplementExplicitAttendanceCounts, validateDraftOutput } = require("../src/modules/liveAi/operations");

test("explicit attendance counts supplement omitted model fields without overriding them", () => {
  const evidence = [{
    id: "evidence-0",
    text: "A hybrid conference for 650 in-person executives and 1,200 remote attendees.",
  }];
  const supplemented = supplementExplicitAttendanceCounts([], evidence);
  const byPath = new Map(supplemented.map((item) => [item.path, item]));

  assert.equal(byPath.get("/content/event/attendees").value, "650");
  assert.equal(byPath.get("/content/hybridVirtual/virtualAttendeeEstimate").value, "1200");
  assert.deepEqual(byPath.get("/content/event/attendees").citations, ["evidence-0"]);

  const existing = [{ path: "/content/event/attendees", value: "700", confidence: 0.8, citations: ["evidence-0"] }];
  assert.equal(supplementExplicitAttendanceCounts(existing, evidence).filter((item) => item.path === "/content/event/attendees").length, 1);
  assert.equal(supplementExplicitAttendanceCounts(existing, evidence)[0].value, "700");

  const malformed = [
    { path: "/content/event/attendees", value: "650 in-person executives and 1,200 remote attendees", confidence: 0.98, citations: ["evidence-0"] },
    { path: "/content/event/attendees", value: "650", confidence: 0.96, citations: ["evidence-0"] },
    { path: "/content/hybridVirtual/virtualAttendeeEstimate", value: "1,200", confidence: 0.98, citations: ["evidence-0"] },
  ];
  const normalized = supplementExplicitAttendanceCounts(malformed, evidence);
  assert.equal(normalized.find((item) => item.path === "/content/event/attendees").value, "650");
  assert.equal(normalized.filter((item) => item.path === "/content/event/attendees").length, 1);
  assert.equal(normalized.find((item) => item.path === "/content/hybridVirtual/virtualAttendeeEstimate").value, "1200");
});

test("proposal draft evidence includes every structured proposal section and nested field", () => {
  const evidence = proposalDraftEvidence({
    event: { eventName: "Leadership Forum", attendees: "650" },
    venueSchedule: { venueName: "Hyatt Regency Chicago" },
    hybridVirtual: { virtualAttendeeEstimate: "1200", closedCaptions: { closedCaptions: "YES" } },
    videoRecordingStep: { numberOfCameras: "3" },
    budget: { proposalSubmissionDueDate: "2027-02-12", estimatedAvBudget: "250k-500k" },
    contactInfo: { primaryContactName: "Avery Morgan" },
    _id: "mongo-id",
    userId: "owner-id",
    status: "Draft",
  });
  const byId = new Map(evidence.map((item) => [item.id, item.value]));

  assert.equal(byId.get("/content/event/attendees"), "650");
  assert.equal(byId.get("/content/hybridVirtual/virtualAttendeeEstimate"), "1200");
  assert.equal(byId.get("/content/hybridVirtual/closedCaptions/closedCaptions"), "YES");
  assert.equal(byId.get("/content/videoRecordingStep/numberOfCameras"), "3");
  assert.equal(byId.get("/content/budget/proposalSubmissionDueDate"), "2027-02-12");
  assert.equal(byId.get("/content/contactInfo/primaryContactName"), "Avery Morgan");
  assert.equal(byId.has("/content/_id"), false);
  assert.equal(byId.has("/content/userId"), false);
  assert.equal(byId.has("/content/status"), false);
});

test("beginner draft validation rejects duplicate sections and persistence overflow before SQL", () => {
  const paragraph = { text: "Supported proposal text.", citations: ["/content/event/eventName"] };
  assert.throws(
    () => validateDraftOutput({
      sections: [
        { key: "event_overview", heading: "Event overview", paragraphs: [paragraph] },
        { key: "event_overview", heading: "Event overview again", paragraphs: [paragraph] },
      ],
      gaps: [],
    }),
    (error) => error.code === "LIVE_AI_OUTPUT_INVALID",
  );

  assert.throws(
    () => validateDraftOutput({
      sections: Array.from({ length: 10 }, (_, section) => ({
        key: [
          "event_overview", "objectives_audience", "format_experience", "venue_schedule",
          "production_scope", "known_requirements", "information_gaps", "budget_procurement",
          "room_requirements", "venue_technical",
        ][section],
        heading: `Section ${section + 1}`,
        paragraphs: Array.from({ length: 4 }, () => paragraph),
      })),
      gaps: [],
    }),
    (error) => error.code === "LIVE_AI_OUTPUT_INVALID",
  );
});
