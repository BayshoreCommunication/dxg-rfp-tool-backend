const test = require("node:test"),
  assert = require("node:assert/strict");
const { computeInvestmentGuidance, evaluateCondition, investmentEnabled } = require("../src/modules/investment/domain");
const { readFacts } = require("../src/modules/investment/proposalAccess");
const corpus = require("./investmentPricingCorpus");

const { regionalFactors, modifiers, confidenceRules } = corpus;

// Minimal synthetic records: low = mid = high so the factor stack is readable.
const rate = (overrides) => ({
  id: overrides.id || "r1", category: "audio", subcategory: "Speakers", spec: "", itemLabel: "Powered box",
  unit: "per_day", unitLabel: "per box/day", quantityDimension: "box", calibrationTier: "baseline",
  amountLowMinor: 1_000, amountMidMinor: 1_000, amountHighMinor: 1_000,
  currency: "USD", market: null, dayType: "any", laborRole: null, ...overrides,
});
const A1 = rate({ id: "a1", category: "labor", subcategory: "Audio", itemLabel: "A1 - Audio Lead / FOH", unit: "per_hour", unitLabel: "per hour", quantityDimension: null, laborRole: "A1" });
const SPEAKER = rate({ id: "spk" });
const generalSessionOnly = (overrides = {}) => ({
  event: { eventName: "Summit", startDate: "2026-05-04", endDate: "2026-05-04", eventFormat: "In-Person" },
  venueSchedule: { isUnionVenue: "NO" },
  venue: { inHouseAvRequired: "NO" },
  roomByRoom: [{ roomFunction: "General Session" }],
  ...overrides,
});
const lineFor = (result, componentKey) => result.lineItems.find((line) => line.componentKey === componentKey);
const factorKinds = (line) => line.appliedFactors.map((factor) => factor.kind);

const proposal = {
  event: { startDate: "2026-09-10", endDate: "2026-09-11" },
  venueSchedule: { numberOfEventRooms: "3", isUnionVenue: "YES" },
  venue: { riggingRequired: "YES" },
};

test("enable gating follows environment authorization and flag", () => {
  const saved = { a: process.env.AI_ENVIRONMENT, n: process.env.NODE_ENV, f: process.env.INVESTMENT_GUIDANCE_ENABLED };
  delete process.env.AI_ENVIRONMENT;
  process.env.NODE_ENV = "production"; process.env.INVESTMENT_GUIDANCE_ENABLED = "true";
  assert.equal(investmentEnabled(), false);
  process.env.NODE_ENV = "test";
  assert.equal(investmentEnabled(), true);
  for (const [key, value] of [["AI_ENVIRONMENT", saved.a], ["NODE_ENV", saved.n], ["INVESTMENT_GUIDANCE_ENABLED", saved.f]])
    value === undefined ? delete process.env[key] : (process.env[key] = value);
});

test("repeated LED wall dimensions contribute their combined active area", () => {
  const facts = readFacts(generalSessionOnly({
    roomByRoom: [{
      roomFunction: "General Session",
      ledWall: "Yes",
      ledWallCount: "2",
      ledWalls: [
        { width: "40", height: "15", pixelPitch: "2.6mm" },
        { width: "16", height: "9", pixelPitch: "1.9mm" },
      ],
    }],
  }));
  assert.equal(facts.ledWallSqFt, 744);
  assert.equal(facts.surfaceSizeStated, true);
});

test("components price a selected configuration, never the whole catalog", () => {
  const result = computeInvestmentGuidance(generalSessionOnly(), corpus.records, [], regionalFactors, modifiers, confidenceRules);
  const speakers = lineFor(result, "gs_line_array");
  // 61 approved speaker records exist; the line must rest on the median ones only.
  assert.ok(corpus.records.filter((record) => record.subcategory === "Speakers").length > 50);
  assert.ok(result.lineItems.every((line) => line.provenance.pricingRecordIds.length <= 3), "each component resolves to median records only");
  assert.equal(speakers.quantity, 4);
  assert.equal(speakers.midMinor, 4 * 14_000); // median powered box, no regional match
  assert.equal(speakers.unitLabel, "per box/day");
});

test("unsupported scopes become explicit refusals, never estimates", () => {
  const empty = computeInvestmentGuidance(proposal, [], []);
  assert.equal(empty.totalLowMinor, null);
  assert.equal(empty.currency, null);
  const refused = empty.refusals.map((refusal) => refusal.category);
  for (const expected of ["general_session", "breakout_room"]) assert.ok(refused.includes(expected), expected);
  assert.ok(empty.refusals.every((refusal) => refusal.reason.includes("No approved pricing data")));
  assert.deepEqual(empty.scenarios, []);
});

test("a template that resolves nothing refuses its whole scope with a concrete ask", () => {
  const recording = generalSessionOnly({ videoRecordingStep: { videoRecordingRequired: "YES", numberOfCameras: "3" } });
  const result = computeInvestmentGuidance(recording, [SPEAKER, A1], [], regionalFactors, modifiers, confidenceRules);
  const refusal = result.refusals.find((item) => item.reason.includes("recording and cameras"));
  assert.ok(refusal, "recording scope is refused");
  assert.equal(refusal.category, "video");
  assert.match(refusal.ask, /Load approved pricing for recording and cameras/);
  assert.ok(!result.lineItems.some((line) => line.templateKey === "RECORDING"));
  // The general session still prices from what is approved.
  assert.ok(lineFor(result, "gs_line_array"));
});

test("multi-day discount applies to equipment days, never to labor hours", () => {
  const twoDays = generalSessionOnly({ event: { eventName: "Summit", startDate: "2026-05-04", endDate: "2026-05-05", eventFormat: "In-Person" } });
  const result = computeInvestmentGuidance(twoDays, [SPEAKER, A1], [], [], modifiers, confidenceRules);
  const equipment = lineFor(result, "gs_line_array");
  const labor = lineFor(result, "gs_a1");
  assert.equal(result.basis.multiDayFactor, 1.4); // 1 + 0.4 x (2 - 1)
  assert.equal(equipment.midMinor, Math.round(1_000 * 4 * 1.4));
  assert.ok(factorKinds(equipment).includes("multi_day"));
  assert.equal(labor.quantity, 20); // 10 hours x 2 show days
  assert.equal(labor.midMinor, 20 * 1_000);
  assert.ok(!factorKinds(labor).includes("multi_day"));
});

test("union factor lifts labor only", () => {
  const union = generalSessionOnly({ venueSchedule: { isUnionVenue: "YES" } });
  const result = computeInvestmentGuidance(union, [SPEAKER, A1], [], [], modifiers, confidenceRules);
  assert.equal(result.basis.unionKey, "union_light"); // no market matched, so the light tier
  assert.equal(result.basis.unionFactor, 1.25);
  const labor = lineFor(result, "gs_a1");
  const equipment = lineFor(result, "gs_line_array");
  assert.equal(labor.midMinor, Math.round(10 * 1_000 * 1.25 * 1.1));
  assert.ok(factorKinds(labor).includes("union"));
  assert.ok(factorKinds(labor).includes("overtime"));
  assert.equal(equipment.midMinor, 4 * 1_000);
  assert.ok(!factorKinds(equipment).includes("union"));
  const heavy = computeInvestmentGuidance(
    { ...union, venueSchedule: { ...union.venueSchedule, venueCity: "Chicago" } },
    [SPEAKER, A1], [], regionalFactors, modifiers, confidenceRules,
  );
  assert.equal(heavy.basis.unionKey, "union_heavy_nyc_chicago_sf");
});

test("in-house markup skips connectivity and management, and the service charge compounds on the subtotal", () => {
  const internet = rate({ id: "net", category: "connectivity", subcategory: "Internet", itemLabel: "Event WiFi (per AP)", unitLabel: "per unit/day", quantityDimension: "each" });
  const management = rate({ id: "pm", category: "production_management", subcategory: "Management", itemLabel: "Project management (day)", unitLabel: "per day", quantityDimension: "each" });
  const inHouse = generalSessionOnly({ venue: { inHouseAvRequired: "YES", wirelessInternetRequired: "YES" } });
  const result = computeInvestmentGuidance(inHouse, [SPEAKER, internet, management], [], [], modifiers, confidenceRules);

  assert.equal(result.basis.inHouseKey, "hotel_in_house_typical");
  assert.equal(result.basis.inHouseFactor, 1.4);
  assert.equal(result.basis.serviceChargeFactor, 1.22);

  const equipment = lineFor(result, "gs_line_array");
  assert.equal(equipment.midMinor, Math.round(1_000 * 4 * 1.4 * 1.22)); // 1.40 x 1.22, the workbook's compounding
  assert.deepEqual(factorKinds(equipment).sort(), ["in_house", "regional", "service_charge"]);

  for (const key of ["connectivity_internet", "gs_management"]) {
    const line = lineFor(result, key);
    assert.ok(line, key);
    assert.ok(!factorKinds(line).includes("in_house"), `${key} is exempt from the in-house markup`);
    assert.ok(factorKinds(line).includes("service_charge"), `${key} still carries the subtotal service charge`);
    assert.equal(line.midMinor, Math.round(1_000 * 1.22));
  }
});

test("an unmatched market falls back to 1.0 and says so in confidence", () => {
  const nowhere = generalSessionOnly({ venueSchedule: { isUnionVenue: "NO", venueCity: "Somewhereville" } });
  const result = computeInvestmentGuidance(nowhere, [SPEAKER, A1], [], regionalFactors, modifiers, confidenceRules);
  assert.equal(result.basis.market, null);
  assert.equal(result.basis.regionalFactor, 1);
  const regional = lineFor(result, "gs_line_array").appliedFactors.find((factor) => factor.kind === "regional");
  assert.equal(regional.factor, 1);
  assert.match(regional.label, /national baseline/);
  assert.ok(result.confidence.deductions.some((item) => item.ruleKey === "market_city_unknown"));
  const matched = computeInvestmentGuidance(
    generalSessionOnly({ venueSchedule: { isUnionVenue: "NO", venueCity: "Chicago" } }),
    [SPEAKER, A1], [], regionalFactors, modifiers, confidenceRules,
  );
  assert.equal(matched.basis.regionalFactor, 1.2);
  assert.ok(!matched.confidence.deductions.some((item) => item.ruleKey === "market_city_unknown"));
});

test("confidence bands and the low-band warning follow the approved deduction rules", () => {
  const vague = { event: { eventName: "Something" } };
  const result = computeInvestmentGuidance(vague, [SPEAKER, A1], [], regionalFactors, modifiers, confidenceRules);
  assert.equal(result.confidence.band, "low");
  assert.ok(result.confidence.score < 65);
  assert.match(result.confidence.note, /Indicative range only/);
  assert.ok(result.totalMidMinor > 0, "numbers are flagged, never suppressed");
  for (const expected of ["scope_vague_av_for_general_session", "show_days_schedule_unknown", "union_status_unknown", "market_city_unknown"])
    assert.ok(result.confidence.deductions.some((item) => item.ruleKey === expected), expected);
  // Unknown rule keys are ignored rather than invented.
  const unknown = computeInvestmentGuidance(vague, [SPEAKER], [], [], modifiers, [{ id: "x", ruleKey: "not_a_real_rule", label: "?", deduction: 50, reason: "" }]);
  assert.deepEqual(unknown.confidence.deductions, []);
  assert.equal(unknown.confidence.score, 100);
});

test("cost-factor rules adjust matching lines on top of the modifier stack", () => {
  const rule = {
    id: "rule-1", ruleKey: "union_uplift", title: "Union venue uplift", explanation: "Union venues add labor conditions.",
    conditions: [{ path: "/content/venueSchedule/isUnionVenue", op: "eq", value: "YES" }],
    effect: { kind: "cost_factor", category: "labor", factorPercent: 10 },
  };
  const union = generalSessionOnly({ venueSchedule: { isUnionVenue: "YES" } });
  const result = computeInvestmentGuidance(union, [SPEAKER, A1], [rule], [], modifiers, confidenceRules);
  const labor = lineFor(result, "gs_a1");
  assert.equal(labor.midMinor, Math.round(Math.round(10 * 1_000 * 1.25 * 1.1) * 1.1)); // union + overtime first, then the rule
  assert.deepEqual(labor.provenance.ruleIds, ["rule-1"]);
  assert.ok(labor.appliedFactors.some((factor) => factor.kind === "expert_rule" && factor.factor === 1.1));
  assert.equal(lineFor(result, "gs_line_array").provenance.ruleIds.length, 0);
});

test("recommendation and ancillary rules require matching conditions", () => {
  const rules = [
    { id: "a", ruleKey: "hybrid_producer", title: "Dedicated virtual producer", explanation: "", conditions: [{ path: "/content/event/eventFormat", op: "eq", value: "Hybrid" }], effect: { kind: "recommendation", guidanceText: "Budget a dedicated virtual producer." } },
    { id: "b", ruleKey: "union_steward", title: "Union steward", explanation: "", conditions: [{ path: "/content/venueSchedule/isUnionVenue", op: "eq", value: "YES" }], effect: { kind: "recommendation", guidanceText: "Plan for a steward call." } },
  ];
  const result = computeInvestmentGuidance(proposal, [], rules);
  assert.deepEqual(result.recommendations.map((item) => item.ruleKey), ["union_steward"]);
});

test("ancillary factors surface with honest statuses and union note", () => {
  const result = computeInvestmentGuidance(proposal, [
    rate({ id: "truck-1", category: "trucking_freight", subcategory: null, quantityDimension: null, unit: "per_event", amountLowMinor: 30_000, amountMidMinor: 40_000, amountHighMinor: 60_000 }),
  ], []);
  const trucking = result.ancillary.find((item) => item.factor === "Trucking & freight");
  assert.equal(trucking.status, "estimated");
  assert.equal(trucking.midMinor, 40_000);
  const venueFees = result.ancillary.find((item) => item.factor === "Venue fees & exclusivity");
  assert.equal(venueFees.status, "venue_dependent");
  assert.ok(result.ancillary.some((item) => item.factor === "Union labor conditions"));
});

test("condition operators evaluate against proposal fields", () => {
  assert.equal(evaluateCondition(proposal, { path: "/content/venueSchedule/numberOfEventRooms", op: "gte", value: 2 }), true);
  assert.equal(evaluateCondition(proposal, { path: "/content/venueSchedule/numberOfEventRooms", op: "lte", value: 2 }), false);
  assert.equal(evaluateCondition(proposal, { path: "/content/event/startDate", op: "filled" }), true);
  assert.equal(evaluateCondition(proposal, { path: "/content/event/theme", op: "empty" }), true);
  assert.equal(evaluateCondition(proposal, { path: "/content/venueSchedule/isUnionVenue", op: "contains", value: "ye" }), true);
});

test("rehearsal days add the approved equipment hold factor", () => {
  const rehearsal = generalSessionOnly({
    venueSchedule: {
      isUnionVenue: "NO",
      rehearsalDate: "2026-05-03",
    },
  });
  const result = computeInvestmentGuidance(
    rehearsal,
    [SPEAKER, A1],
    [],
    [],
    modifiers,
    confidenceRules,
  );
  assert.equal(result.basis.multiDayFactor, 1.5);
  assert.equal(lineFor(result, "gs_line_array").midMinor, 4 * 1_000 * 1.5);
  assert.match(result.basis.showDayEquipmentBasis, /rehearsal\/dark day/);
});

test("explicit stage, scenic and caption scope activates workbook-backed packages", () => {
  const records = [
    rate({ id: "deck", category: "staging", subcategory: "Stage Deck", itemLabel: "4' x 8' stage deck", quantityDimension: "deck" }),
    rate({ id: "scenic", category: "staging", subcategory: "Scenic", itemLabel: "Custom hard scenic element", quantityDimension: "element" }),
    rate({ id: "carpenter", category: "labor", subcategory: "Stage", itemLabel: "Scenic Carpenter", unit: "per_hour", quantityDimension: null }),
    rate({ id: "caption", category: "labor", subcategory: "Accessibility", itemLabel: "Captioner / CART", unit: "per_hour", quantityDimension: null }),
    rate({ id: "kit", category: "expendables", subcategory: "Consumables", itemLabel: "Consumables kit (misc)", unit: "per_event", quantityDimension: "show" }),
    rate({ id: "batteries", category: "expendables", subcategory: "Consumables", itemLabel: "Batteries (show package)", unit: "per_event", quantityDimension: "show" }),
  ];
  const scoped = generalSessionOnly({
    roomByRoom: [{
      roomFunction: "General Session",
      stageDimensions: "64 x 24",
      scenicStageDesign: "Yes",
    }],
    hybridVirtual: {
      closedCaptions: {
        closedCaptions: "YES",
        captionLanguages: ["English", "Spanish"],
      },
    },
  });
  const result = computeInvestmentGuidance(scoped, records, [], [], modifiers, []);

  assert.equal(lineFor(result, "gs_stage_deck").quantity, 48);
  assert.ok(lineFor(result, "scenic_element"));
  assert.ok(lineFor(result, "scenic_carpenter"));
  assert.equal(lineFor(result, "captioning_service").quantity, 20);
  assert.ok(lineFor(result, "expendables_kit").implied);
  assert.ok(lineFor(result, "show_batteries").implied);
});

// ---------------------------------------------------------------------------
// Acceptance: the workbook's worked example - 13 breakout rooms in Chicago,
// one show day, 10 technician hours per room, non-union house, outside AV.
// The workbook totals $54,366; median-selected records from the real corpus
// cannot reproduce that figure exactly, so this asserts structure and
// relationships around it.
// ---------------------------------------------------------------------------
const WORKBOOK_MID_MINOR = 5_436_600;

test("acceptance: workbook worked example - 13 Chicago breakouts, one show day", () => {
  const room = (roomFunction) => ({
    roomFunction,
    largeMonitorsOrScreenProjector: { largeMonitorsOrScreenProjector: "YES", numberOfScreens: "1", screenSize: "9x16" },
  });
  const workbook = {
    event: { eventName: "DXG Leadership Summit", startDate: "2026-04-14", endDate: "2026-04-14", attendees: "900", eventFormat: "In-Person" },
    venueSchedule: { venueCity: "Chicago", venueState: "IL", venueName: "Hyatt Regency Chicago", isUnionVenue: "NO", numberOfEventRooms: "14" },
    venue: { inHouseAvRequired: "NO", wirelessInternetRequired: "YES" },
    hybridVirtual: { closedCaptions: { closedCaptions: "NO" } },
    roomByRoom: [room("General Session"), ...Array.from({ length: 13 }, (_, index) => room(`Breakout ${index + 1}`))],
  };
  const result = computeInvestmentGuidance(workbook, corpus.records, [], regionalFactors, modifiers, confidenceRules);

  assert.equal(result.currency, "USD");
  assert.equal(result.basis.days, 1);
  assert.equal(result.basis.multiDayFactor, 1);

  // Within 40% of the workbook total. Actual: $54,060 against the workbook's $54,366.
  assert.ok(
    result.totalMidMinor >= 3_200_000 && result.totalMidMinor <= 7_600_000,
    `mid total ${result.totalMidMinor} is outside 40% of the workbook's ${WORKBOOK_MID_MINOR}`,
  );
  assert.ok(result.totalHighMinor > result.totalMidMinor && result.totalMidMinor > result.totalLowMinor, "premium > mid > low");

  assert.equal(result.basis.market, "Chicago");
  assert.equal(result.basis.regionalFactor, 1.2);
  for (const line of result.lineItems)
    assert.ok(line.appliedFactors.some((factor) => factor.kind === "regional" && factor.factor === 1.2), `${line.componentKey} carries the Chicago factor`);

  const breakouts = result.lineItems.filter((line) => line.templateKey === "BREAKOUT_ROOM");
  assert.equal(lineFor(result, "breakout_projector").quantity, 13);
  assert.equal(lineFor(result, "breakout_technician").quantity, 130); // 13 rooms x 10 hours x 1 day
  assert.ok(breakouts.length >= 7, "the breakout package resolves its components");
  assert.ok(!result.refusals.some((refusal) => refusal.category === "breakout_room"), "breakouts are priced, not refused");

  const scenario = (key) => result.scenarios.find((item) => item.key === key);
  assert.ok(scenario("union").midMinor > scenario("base").midMinor, "union scenario exceeds base");
  assert.ok(scenario("in_house").midMinor > scenario("union").midMinor, "in-house scenario exceeds union");
  assert.equal(scenario("base").midMinor, result.totalMidMinor); // non-union, outside AV is the applied stack

  const assumptions = result.assumptions.map((item) => item.key);
  for (const expected of ["implied_breakout_screen", "implied_breakout_sound_system", "baseline_calibration_only", "breakout_tech_hours"])
    assert.ok(assumptions.includes(expected), expected);
  assert.match(result.assumptions.find((item) => item.key === "implied_breakout_screen").note, /confirm with the client/);

  assert.equal(result.confidence.band, "medium");
  const deductions = result.confidence.deductions.map((item) => item.ruleKey);
  for (const expected of ["no_calibrated_dxg_actuals_for_this_category", "projection_brightness_lumens_not_stated", "wireless_channel_count_not_stated"])
    assert.ok(deductions.includes(expected), expected);
  for (const absent of ["market_city_unknown", "union_status_unknown", "hotel_in_house_vs_outside_av_unknown", "show_days_schedule_unknown"])
    assert.ok(!deductions.includes(absent), `${absent} must not fire`);
});
