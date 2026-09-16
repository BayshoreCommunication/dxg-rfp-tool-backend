const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateStructuredVendorResponse,
  roomNightsBetween,
  validateStructuredVendorResponse,
  validateVendorResponseQuestionnaire,
  countRequirement,
} = require("../src/modules/vendorResponses/domain/structuredResponse");
const {
  validateVendorResponseCalculationV1,
  validateVendorResponseQuestionnaireV1,
  validateVendorResponseV1,
} = require("../contracts/vendor-response/v1/validators");
const {
  buildCompleteVendorResponse,
  buildEmptyVendorResponse,
  buildEmptyVendorResponseQuestionnaire,
  buildVendorResponseQuestionnaire,
  cloneFixture,
} = require("./fixtures/vendorResponseV1");

test("canonical questionnaire and complete response pass contract and semantic validation", () => {
  const questionnaire = buildVendorResponseQuestionnaire();
  const response = buildCompleteVendorResponse(questionnaire);

  assert.equal(validateVendorResponseQuestionnaireV1(questionnaire), true);
  assert.equal(validateVendorResponseV1(response), true);
  assert.deepEqual(validateVendorResponseQuestionnaire(questionnaire), []);
  assert.deepEqual(validateStructuredVendorResponse(questionnaire, response, "final"), []);
});

test("empty-room questionnaire fixture remains a valid contract", () => {
  const questionnaire = buildEmptyVendorResponseQuestionnaire();
  assert.equal(validateVendorResponseQuestionnaireV1(questionnaire), true);
  assert.deepEqual(validateVendorResponseQuestionnaire(questionnaire), []);
});

test("contracts reject unknown properties and unstable identifiers", () => {
  const questionnaire = buildVendorResponseQuestionnaire();
  const withUnknownProperty = { ...questionnaire, demoAnswer: "must not ship" };
  const withUnstableId = { ...questionnaire, questionnaireId: "questionnaire 1" };

  assert.equal(validateVendorResponseQuestionnaireV1(withUnknownProperty), false);
  assert.equal(validateVendorResponseQuestionnaireV1(withUnstableId), false);
});

test("questionnaire semantic validation rejects duplicate stable IDs", () => {
  const questionnaire = buildVendorResponseQuestionnaire();
  questionnaire.rooms[1].roomId = questionnaire.rooms[0].roomId;
  questionnaire.rooms[1].specs[0].specId = questionnaire.rooms[0].specs[0].specId;

  const errors = validateVendorResponseQuestionnaire(questionnaire);
  assert.ok(errors.some((entry) => entry.code === "duplicate_id" && entry.message.includes("room ID")));
  assert.ok(errors.some((entry) => entry.code === "duplicate_id" && entry.message.includes("spec ID")));
});

test("response cannot answer rooms, specs, or categories outside its questionnaire", () => {
  const questionnaire = buildVendorResponseQuestionnaire();
  const response = buildCompleteVendorResponse(questionnaire);
  response.rooms[0].specResponses.push({ specId: "spec-not-published", status: "comply", note: "" });
  response.rooms[0].equipmentLines[0].categoryId = "category-not-published";
  response.rooms.push({
    ...cloneFixture(response.rooms[0]),
    roomId: "room-not-published",
    specResponses: [],
    equipmentLines: [],
    categoryTotals: [],
    laborLines: [],
  });

  const errors = validateStructuredVendorResponse(questionnaire, response, "draft");
  assert.ok(errors.filter((entry) => entry.code === "unknown_reference").length >= 3);
});

test("substitutions and exceptions require an explanatory note", () => {
  const questionnaire = buildVendorResponseQuestionnaire();
  const response = buildCompleteVendorResponse(questionnaire);
  response.rooms[0].specResponses[0].status = "substitute";
  response.rooms[0].specResponses[0].note = "";

  const errors = validateStructuredVendorResponse(questionnaire, response, "final");
  assert.ok(errors.some((entry) => entry.code === "note_required"));

  response.rooms[0].specResponses[0].note = "Equivalent laser projector with higher brightness.";
  assert.ok(!validateStructuredVendorResponse(questionnaire, response, "final").some((entry) => entry.code === "note_required"));
});

test("hybrid details are required only for streaming-applicable rooms", () => {
  const questionnaire = buildVendorResponseQuestionnaire();
  const response = buildCompleteVendorResponse(questionnaire);
  delete response.rooms[0].hybrid;
  response.rooms[1].hybrid = {
    feedHandoff: "Not applicable",
    redundancy: "Not applicable",
    virtualAudienceExperience: "Not applicable",
  };

  const errors = validateStructuredVendorResponse(questionnaire, response, "final");
  assert.ok(errors.some((entry) => entry.code === "required" && entry.path === "/rooms/room-1/hybrid"));
  assert.ok(errors.some((entry) => entry.code === "not_applicable" && entry.path === "/rooms/room-2/hybrid"));
});

test("travel is hidden without travel labor and validates date-only room nights deterministically", () => {
  const questionnaire = buildVendorResponseQuestionnaire();
  const noTravelResponse = buildCompleteVendorResponse(questionnaire, false);
  const calculation = calculateStructuredVendorResponse(questionnaire, noTravelResponse, "2026-09-14T14:00:00.000Z");

  assert.equal(calculation.completion.requiredSections, 7);
  assert.equal(calculation.completion.percent, 100);
  assert.equal(calculation.requestedRoomNights, 0);
  assert.equal(roomNightsBetween("2027-03-13", "2027-03-15"), 2);
  assert.equal(roomNightsBetween("2027-03-15", "2027-03-13"), 0);

  noTravelResponse.travel.lodgingRequests.push({
    laborLineId: noTravelResponse.rooms[0].laborLines[0].laborLineId,
    roomId: noTravelResponse.rooms[0].roomId,
    clientProvidedRoom: true,
    checkIn: "2027-03-13",
    checkOut: "2027-03-15",
  });
  assert.ok(validateStructuredVendorResponse(questionnaire, noTravelResponse, "final").some((entry) => entry.code === "not_applicable"));
});

test("calculation preserves cents, separates fees and tax, and uses one currency", () => {
  const questionnaire = buildVendorResponseQuestionnaire();
  const response = buildCompleteVendorResponse(questionnaire);
  const calculation = calculateStructuredVendorResponse(questionnaire, response, "2026-09-14T14:00:00.000Z");

  assert.equal(calculation.equipmentSubtotalMinor, 20_003);
  assert.equal(calculation.laborSubtotalMinor, 10_003);
  assert.equal(calculation.travelSubtotalMinor, 2_500);
  assert.equal(calculation.feeSubtotalMinor, 1_000);
  assert.equal(calculation.taxSubtotalMinor, 500);
  assert.equal(calculation.discountMinor, 100);
  assert.equal(calculation.grandTotalMinor, 33_906);
  assert.equal(calculation.requestedRoomNights, 3);
  assert.equal(validateVendorResponseCalculationV1(calculation), true);

  response.rooms[0].categoryTotals[0].amount.currency = "EUR";
  assert.ok(validateStructuredVendorResponse(questionnaire, response, "final").some((entry) => entry.code === "currency_mismatch"));
});

test("completion excludes optional and conditionally hidden sections", () => {
  const questionnaire = buildVendorResponseQuestionnaire();
  const response = buildCompleteVendorResponse(questionnaire, false);
  response.valueAdds = "";
  response.alternates = [];

  const complete = calculateStructuredVendorResponse(questionnaire, response, "2026-09-14T14:00:00.000Z");
  assert.deepEqual(complete.completion, { requiredSections: 7, completedSections: 7, percent: 100 });

  response.identity.vendorName = "";
  const incomplete = calculateStructuredVendorResponse(questionnaire, response, "2026-09-14T14:00:00.000Z");
  assert.deepEqual(incomplete.completion, { requiredSections: 7, completedSections: 6, percent: 86 });
});

test("empty structured fixture is valid as a draft shape but incomplete for final submission", () => {
  const questionnaire = buildVendorResponseQuestionnaire();
  const response = buildEmptyVendorResponse(questionnaire);

  assert.equal(validateVendorResponseV1(response), true);
  assert.deepEqual(validateStructuredVendorResponse(questionnaire, response, "draft"), []);
  assert.ok(validateStructuredVendorResponse(questionnaire, response, "final").length > 0);
});

test("calculations remain deterministic for an 80-room questionnaire", () => {
  const questionnaire = buildVendorResponseQuestionnaire(80, new Set());
  const response = buildCompleteVendorResponse(questionnaire, false);
  const first = calculateStructuredVendorResponse(questionnaire, response, "2026-09-14T14:00:00.000Z");
  const second = calculateStructuredVendorResponse(questionnaire, cloneFixture(response), "2026-09-14T14:00:00.000Z");

  assert.equal(first.roomTotals.length, 80);
  assert.equal(first.specCounts.total, 80);
  assert.equal(first.completion.percent, 100);
  assert.deepEqual(first, second);
});

test("date and room-count properties remain stable across a bounded generated sample", () => {
  for (let roomCount = 0; roomCount <= 80; roomCount += 8) {
    const questionnaire = buildVendorResponseQuestionnaire(roomCount, new Set());
    const response = buildCompleteVendorResponse(questionnaire, false);
    const calculation = calculateStructuredVendorResponse(questionnaire, response, "2026-09-14T14:00:00.000Z");
    assert.equal(calculation.roomTotals.length, roomCount);
    assert.equal(calculation.specCounts.total, roomCount);
    assert.ok(Number.isSafeInteger(calculation.grandTotalMinor));
  }
  for (let day = 1; day <= 20; day += 1) {
    const start = `2027-01-${String(day).padStart(2, "0")}`;
    const end = `2027-01-${String(day + 3).padStart(2, "0")}`;
    assert.equal(roomNightsBetween(start, end), 3);
  }
});

/* The reference minimum was not pinned by any test, so it silently sat at 1
   while the product required three comparable references. */
test("a response short of the reference minimum cannot be finalized", () => {
  const questionnaire = buildVendorResponseQuestionnaire();
  questionnaire.references = {
    enabled: true,
    minimumCount: 3,
    maximumCount: 3,
    maxAgeMonths: 36,
    maxVisualsPerReference: 3,
  };
  const response = buildCompleteVendorResponse(questionnaire);
  const template = cloneFixture(response.references[0]);
  const reference = (id) => ({ ...cloneFixture(template), referenceId: id });

  response.references = [reference("reference-1"), reference("reference-2")];
  const shortOfMinimum = validateStructuredVendorResponse(questionnaire, response, "final");
  assert.ok(
    shortOfMinimum.some((error) => error.path === "/references" && error.code === "invalid_count"),
    "two references must block a final submission when three are required",
  );

  response.references = [reference("reference-1"), reference("reference-2"), reference("reference-3")];
  assert.deepEqual(
    validateStructuredVendorResponse(questionnaire, response, "final")
      .filter((error) => error.path === "/references"),
    [],
  );
});

test("an exact count requirement is phrased without a degenerate range", () => {
  // "Provide between 3 and 3 references" is what the naive range wording gives.
  assert.equal(countRequirement("Provide", 3, 3, "reference"), "Provide 3 references");
  assert.equal(countRequirement("Provide", 1, 1, "reference"), "Provide 1 reference");
  assert.equal(countRequirement("Provide", 1, 3, "reference"), "Provide between 1 and 3 references");
});
