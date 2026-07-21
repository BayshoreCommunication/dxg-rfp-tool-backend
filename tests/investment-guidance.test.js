const test = require("node:test"),
  assert = require("node:assert/strict");
const { computeInvestmentGuidance, evaluateCondition, investmentEnabled } = require("../src/modules/investment/domain");

const record = (overrides) => ({
  id: overrides.id || "r1", category: "audio", itemLabel: "PA system", unit: "per_day",
  amountLowMinor: 100_000, amountMidMinor: 150_000, amountHighMinor: 200_000,
  currency: "USD", market: null, dayType: "any", laborRole: null, ...overrides,
});
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

test("ranges scale by quantity drivers and carry pricing provenance", () => {
  const result = computeInvestmentGuidance(proposal, [
    record({ id: "audio-1" }),
    record({ id: "rooms-1", category: "breakout_room", unit: "per_room", amountLowMinor: 50_000, amountMidMinor: 60_000, amountHighMinor: 80_000 }),
  ], []);
  const audio = result.lineItems.find((line) => line.category === "audio");
  assert.equal(audio.lowMinor, 200_000); // 2 event days × per_day
  assert.deepEqual(audio.provenance.pricingRecordIds, ["audio-1"]);
  const rooms = result.lineItems.find((line) => line.category === "breakout_room");
  assert.equal(rooms.midMinor, 180_000); // 3 rooms × per_room
  assert.equal(result.currency, "USD");
  assert.equal(result.totalLowMinor, 350_000);
});

test("unsupported core categories become explicit refusals, never estimates", () => {
  const result = computeInvestmentGuidance(proposal, [record({})], []);
  const refusedCategories = result.refusals.map((refusal) => refusal.category);
  for (const expected of ["video", "lighting", "labor", "rigging"]) assert.ok(refusedCategories.includes(expected), expected);
  assert.ok(result.refusals.every((refusal) => refusal.reason.includes("No approved pricing data")));
  const empty = computeInvestmentGuidance(proposal, [], []);
  assert.equal(empty.totalLowMinor, null);
  assert.equal(empty.currency, null);
});

test("cost-factor rules adjust matching lines with rule provenance", () => {
  const rule = { id: "rule-1", ruleKey: "union_uplift", title: "Union venue uplift", explanation: "Union venues add labor conditions.", conditions: [{ path: "/content/venueSchedule/isUnionVenue", op: "eq", value: "YES" }], effect: { kind: "cost_factor", category: "audio", factorPercent: 10 } };
  const result = computeInvestmentGuidance(proposal, [record({ id: "audio-1" })], [rule]);
  const audio = result.lineItems.find((line) => line.category === "audio");
  assert.equal(audio.lowMinor, 220_000); // 200000 × 1.10
  assert.deepEqual(audio.provenance.ruleIds, ["rule-1"]);
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
    record({ id: "truck-1", category: "trucking_freight", unit: "per_event", amountLowMinor: 30_000, amountMidMinor: 40_000, amountHighMinor: 60_000 }),
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
