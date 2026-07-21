const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const {
  parsePricingRecordInput,
  parseExpertRuleInput,
  parseStatusChange,
  pricingEnabled,
  PricingError,
  PRICING_CATEGORIES,
  PRICING_UNITS,
  DAY_TYPES,
} = require("../src/modules/pricing/domain");

const withEnv = (overrides, fn) => {
  const saved = {};
  for (const key of Object.keys(overrides)) { saved[key] = process.env[key]; if (overrides[key] === undefined) delete process.env[key]; else process.env[key] = overrides[key]; }
  try { fn(); } finally { for (const key of Object.keys(saved)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
};
const rejects = (fn, code) => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof PricingError, `expected PricingError, got ${error.constructor.name}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code} to be thrown`);
};

const validRecord = () => ({
  category: "audio",
  itemLabel: "  Wireless handheld microphone  ",
  unit: "per_day",
  amountLowMinor: 5000,
  amountMidMinor: 7500,
  amountHighMinor: 12000,
  currency: "USD",
});
const validRule = () => ({
  ruleKey: "union_labor_uplift-1",
  title: "Union venue labor uplift",
  explanation: "Union venues carry mandated labor rates.",
  conditions: [
    { path: "/content/venueSchedule/isUnionVenue", op: "eq", value: "YES" },
    { path: "/content/venueSchedule/unionJurisdictionOther", op: "filled" },
  ],
  effect: { kind: "cost_factor", category: "labor", guidanceText: "Apply a union labor uplift to all labor lines.", factorPercent: 25 },
});

test("pricing record input round-trips with normalization and defaults", () => {
  const parsed = parsePricingRecordInput(validRecord());
  assert.equal(parsed.category, "audio");
  assert.equal(parsed.itemLabel, "Wireless handheld microphone");
  assert.equal(parsed.unit, "per_day");
  assert.equal(parsed.amountLowMinor, 5000);
  assert.equal(parsed.amountMidMinor, 7500);
  assert.equal(parsed.amountHighMinor, 12000);
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.market, null);
  assert.equal(parsed.dayType, "any");
  assert.equal(parsed.laborRole, null);
  assert.equal(parsed.sourceFragmentId, null);
  assert.equal(parsed.sourceNote, "");
  const full = parsePricingRecordInput({
    ...validRecord(),
    market: " Las Vegas ",
    dayType: "overtime",
    laborRole: "A1 Audio Engineer",
    sourceFragmentId: "0198A2B3-C4D5-7000-8000-0123456789AB",
    sourceNote: "From the 2025 national rate card.",
  });
  assert.equal(full.market, "Las Vegas");
  assert.equal(full.dayType, "overtime");
  assert.equal(full.laborRole, "A1 Audio Engineer");
  assert.equal(full.sourceFragmentId, "0198a2b3-c4d5-7000-8000-0123456789ab");
  assert.equal(full.sourceNote, "From the 2025 national rate card.");
});

test("pricing record amounts must satisfy low <= mid <= high and be non-negative integers", () => {
  rejects(() => parsePricingRecordInput({ ...validRecord(), amountLowMinor: 9000 }), "INVALID_PRICING_RECORD");
  rejects(() => parsePricingRecordInput({ ...validRecord(), amountHighMinor: 6000 }), "INVALID_PRICING_RECORD");
  rejects(() => parsePricingRecordInput({ ...validRecord(), amountMidMinor: -1 }), "INVALID_PRICING_RECORD");
  rejects(() => parsePricingRecordInput({ ...validRecord(), amountMidMinor: 75.5 }), "INVALID_PRICING_RECORD");
  rejects(() => parsePricingRecordInput({ ...validRecord(), amountMidMinor: "7500" }), "INVALID_PRICING_RECORD");
});

test("pricing record currency must be a 3-letter uppercase code", () => {
  for (const currency of ["usd", "US", "USDX", "", 840, null])
    rejects(() => parsePricingRecordInput({ ...validRecord(), currency }), "INVALID_PRICING_RECORD");
  assert.equal(parsePricingRecordInput({ ...validRecord(), currency: "EUR" }).currency, "EUR");
});

test("pricing record enforces label bounds and enum membership", () => {
  rejects(() => parsePricingRecordInput({ ...validRecord(), itemLabel: "   " }), "INVALID_PRICING_RECORD");
  rejects(() => parsePricingRecordInput({ ...validRecord(), itemLabel: "x".repeat(201) }), "INVALID_PRICING_RECORD");
  assert.equal(parsePricingRecordInput({ ...validRecord(), itemLabel: "x".repeat(200) }).itemLabel.length, 200);
  rejects(() => parsePricingRecordInput({ ...validRecord(), category: "catering" }), "INVALID_PRICING_RECORD");
  rejects(() => parsePricingRecordInput({ ...validRecord(), unit: "per_week" }), "INVALID_PRICING_RECORD");
  rejects(() => parsePricingRecordInput({ ...validRecord(), dayType: "weekend" }), "INVALID_PRICING_RECORD");
  rejects(() => parsePricingRecordInput({ ...validRecord(), sourceFragmentId: "not-a-uuid" }), "INVALID_PRICING_RECORD");
  rejects(() => parsePricingRecordInput(null), "INVALID_PRICING_RECORD");
});

test("expert rule with two conditions round-trips", () => {
  const parsed = parseExpertRuleInput(validRule());
  assert.equal(parsed.ruleKey, "union_labor_uplift-1");
  assert.equal(parsed.title, "Union venue labor uplift");
  assert.equal(parsed.conditions.length, 2);
  assert.deepEqual(parsed.conditions[0], { path: "/content/venueSchedule/isUnionVenue", op: "eq", value: "YES" });
  assert.deepEqual(parsed.conditions[1], { path: "/content/venueSchedule/unionJurisdictionOther", op: "filled", value: null });
  assert.deepEqual(parsed.effect, { kind: "cost_factor", category: "labor", guidanceText: "Apply a union labor uplift to all labor lines.", factorPercent: 25 });
  const minimal = parseExpertRuleInput({
    ruleKey: "abc",
    title: "Minimal",
    effect: { kind: "recommendation", guidanceText: "Consider a backup projector." },
  });
  assert.equal(minimal.explanation, "");
  assert.deepEqual(minimal.conditions, []);
  assert.deepEqual(minimal.effect, { kind: "recommendation", category: null, guidanceText: "Consider a backup projector.", factorPercent: null });
});

test("expert rule condition validation rejects bad ops, paths, and missing values", () => {
  const withCondition = (condition) => ({ ...validRule(), conditions: [condition] });
  rejects(() => parseExpertRuleInput(withCondition({ path: "/content/event/eventFormat", op: "matches", value: "x" })), "INVALID_EXPERT_RULE");
  rejects(() => parseExpertRuleInput(withCondition({ path: "/other/event/eventFormat", op: "eq", value: "x" })), "INVALID_EXPERT_RULE");
  rejects(() => parseExpertRuleInput(withCondition({ path: "/content/event/eventFormat", op: "eq" })), "INVALID_EXPERT_RULE");
  rejects(() => parseExpertRuleInput(withCondition({ path: "/content/event/eventFormat", op: "eq", value: { nested: true } })), "INVALID_EXPERT_RULE");
  rejects(() => parseExpertRuleInput(withCondition({ path: "/content/event/eventFormat", op: "filled", value: "x" })), "INVALID_EXPERT_RULE");
  rejects(() => parseExpertRuleInput(withCondition({ path: "/content/event/eventFormat", op: "eq", value: "x".repeat(201) })), "INVALID_EXPERT_RULE");
  rejects(() => parseExpertRuleInput({ ...validRule(), conditions: Array.from({ length: 21 }, () => ({ path: "/content/event/eventName", op: "filled" })) }), "INVALID_EXPERT_RULE");
});

test("expert rule effect requires factorPercent only for cost_factor", () => {
  const withEffect = (effect) => ({ ...validRule(), effect });
  rejects(() => parseExpertRuleInput(withEffect({ kind: "cost_factor", category: "labor", guidanceText: "Uplift." })), "INVALID_EXPERT_RULE");
  rejects(() => parseExpertRuleInput(withEffect({ kind: "cost_factor", category: "labor", guidanceText: "Uplift.", factorPercent: 101 })), "INVALID_EXPERT_RULE");
  rejects(() => parseExpertRuleInput(withEffect({ kind: "cost_factor", category: "labor", guidanceText: "Uplift.", factorPercent: -51 })), "INVALID_EXPERT_RULE");
  rejects(() => parseExpertRuleInput(withEffect({ kind: "discount", guidanceText: "Nope." })), "INVALID_EXPERT_RULE");
  rejects(() => parseExpertRuleInput(withEffect({ kind: "recommendation", guidanceText: "" })), "INVALID_EXPERT_RULE");
  rejects(() => parseExpertRuleInput(withEffect({ kind: "recommendation", category: "misc", guidanceText: "Hint." })), "INVALID_EXPERT_RULE");
  const flag = parseExpertRuleInput(withEffect({ kind: "ancillary_flag", category: "rigging", guidanceText: "Rigging call likely required." }));
  assert.equal(flag.effect.factorPercent, null);
});

test("expert rule key format is enforced", () => {
  for (const ruleKey of ["ab", "Has_Upper", "has space", "x".repeat(81), "", undefined])
    rejects(() => parseExpertRuleInput({ ...validRule(), ruleKey }), "INVALID_EXPERT_RULE");
});

test("parseStatusChange only accepts allowed transitions", () => {
  assert.equal(parseStatusChange({ status: "approved" }, ["approved", "retired"]), "approved");
  assert.equal(parseStatusChange({ status: "retired" }, ["approved", "retired"]), "retired");
  rejects(() => parseStatusChange({ status: "draft" }, ["approved", "retired"]), "INVALID_STATUS");
  rejects(() => parseStatusChange({ status: "active" }, ["approved", "retired"]), "INVALID_STATUS");
  rejects(() => parseStatusChange({}, ["active", "retired"]), "INVALID_STATUS");
  rejects(() => parseStatusChange(null, ["active", "retired"]), "INVALID_STATUS");
});

test("pricing corpus is gated by environment authorization and flag", () => {
  withEnv({ AI_ENVIRONMENT: undefined, NODE_ENV: "production", PRICING_CORPUS_ENABLED: "true" }, () => assert.equal(pricingEnabled(), false));
  withEnv({ AI_ENVIRONMENT: "staging", NODE_ENV: "production", PRICING_CORPUS_ENABLED: "true" }, () => assert.equal(pricingEnabled(), true));
  withEnv({ AI_ENVIRONMENT: "staging", NODE_ENV: "production", PRICING_CORPUS_ENABLED: undefined }, () => assert.equal(pricingEnabled(), false));
  withEnv({ AI_ENVIRONMENT: "staging", NODE_ENV: "production", PRICING_CORPUS_ENABLED: "false" }, () => assert.equal(pricingEnabled(), false));
});

test("domain enums mirror the migration 020 CHECK constraints", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "postgres", "020_pricing_and_vendor_analysis.up.sql"), "utf8");
  assert.ok(migration.includes("CREATE TABLE rfpilot.pricing_records"));
  assert.ok(migration.includes("CREATE TABLE rfpilot.expert_rules"));
  assert.equal((migration.match(/FORCE ROW LEVEL SECURITY/g) || []).length, 5);
  assert.ok(migration.includes("CHECK(amount_low_minor<=amount_mid_minor AND amount_mid_minor<=amount_high_minor)"));
  for (const category of PRICING_CATEGORIES) assert.ok(migration.includes(`'${category}'`), category);
  for (const unit of PRICING_UNITS) assert.ok(migration.includes(`'${unit}'`), unit);
  for (const dayType of DAY_TYPES) assert.ok(migration.includes(`'${dayType}'`), dayType);
});

test("pricing routes wire approval permissions on status endpoints", () => {
  const route = fs.readFileSync(path.join(__dirname, "..", "routes", "pricingRoute.ts"), "utf8");
  assert.ok(route.includes('authorizeAction("knowledge:approve")'));
  assert.ok(route.includes('authorizeAction("knowledge:write")'));
  assert.ok(route.includes('authorizeAction("knowledge:read")'));
  assert.ok(route.includes("/knowledge/pricing-records/:recordId/status"));
  assert.ok(route.includes("/knowledge/expert-rules/:ruleId/status"));
  assert.ok(route.includes('securityRateLimit({ name: "pricing-admin", limit: 120, windowMs: 15 * 60_000 })'));
});
