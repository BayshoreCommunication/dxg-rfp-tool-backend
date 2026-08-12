const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { buildAssessments, buildRisks, calculateContribution, normalizeCommercial, rubricMaximum } = require("../src/modules/evaluationEngine/domain");

const mapping = (overrides = {}) => ({ mappingId: "mapping", requirementId: "requirement", title: "Provide staffing coverage", mandatory: false, eligibility: false, relationship: "supports", confidence: 0.95, fragmentIds: ["fragment"], ...overrides });
const moneyFact = (overrides = {}) => ({ factId: "fact", factKey: "commercial.total", family: "commercial", factType: "commercial_total", statement: "Total is USD 100,000", valueKind: "money", normalizedValue: "USD 100000", typedValue: { kind: "money", number: 100000, currency: "USD" }, currency: "USD", contradictionGroup: null, fragmentIds: ["fragment"], ...overrides });

test("assessment verdicts are deterministic and confidence only creates review metadata", () => {
  const high = buildAssessments([mapping({ confidence: 0.99 })])[0];
  const low = buildAssessments([mapping({ confidence: 0.2 })])[0];
  assert.equal(high.verdict, "addressed"); assert.equal(low.verdict, "addressed");
  assert.equal(high.reviewReasons.includes("low_extraction_confidence"), false);
  assert.equal(low.reviewReasons.includes("low_extraction_confidence"), true);
});

test("assessable statuses require citations and mandatory gaps never auto-disqualify", () => {
  assert.throws(() => buildAssessments([mapping({ fragmentIds: [] })]), (error) => error.code === "ASSESSMENT_CITATION_INVALID");
  const assessments = buildAssessments([mapping({ mandatory: true, relationship: "none", fragmentIds: [] })]);
  const risks = buildRisks([mapping({ mandatory: true, relationship: "none", fragmentIds: [] })], []);
  assert.equal(assessments[0].verdict, "missing");
  assert.equal(risks[0].category, "mandatory_gap");
  assert.match(risks[0].basis, /not an automatic disqualification/i);
  assert.equal(Object.hasOwn(assessments[0], "eligible"), false);
});

test("submitted and normalized price stay separate and unsafe normalization refuses", () => {
  const safe = normalizeCommercial([moneyFact()]);
  assert.equal(safe.submittedTotal, 100000); assert.equal(safe.normalizedTotal, 100000); assert.equal(safe.comparable, true);
  const refused = normalizeCommercial([moneyFact(), moneyFact({ factId: "option", factKey: "commercial.option", factType: "commercial_option", statement: "Travel is optional", valueKind: "string", typedValue: { kind: "string", text: "Travel optional" }, currency: null })]);
  assert.equal(refused.submittedTotal, 100000); assert.equal(refused.normalizedTotal, null); assert.equal(refused.comparable, false);
  assert.ok(refused.refusalCodes.includes("UNRESOLVED_OPTIONS_OR_EXCLUSIONS"));
});

test("confirmed rubric contribution ignores confidence and uses only score, maximum, and weight", () => {
  assert.equal(rubricMaximum({ maximum: 10 }), 10); assert.equal(rubricMaximum({}), 5);
  assert.equal(calculateContribution({ score: 4, rubricMaximum: 5, weight: 25 }), 20);
  assert.throws(() => calculateContribution({ score: 6, rubricMaximum: 5, weight: 25 }), (error) => error.code === "SCORE_OUT_OF_RANGE");
});

test("migration makes derived output and score events tenant-isolated and immutable", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/postgres/048_evaluation_engine.up.sql"), "utf8");
  for (const table of ["vendor_evaluation_runs", "ai_assessments", "evaluation_risks", "commercial_submissions", "commercial_normalizations", "evaluation_assignments", "commercial_access_events", "evaluator_score_events"]) {
    assert.match(sql, new RegExp(`ALTER TABLE rfpilot\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`ALTER TABLE rfpilot\\.${table} FORCE ROW LEVEL SECURITY`));
  }
  assert.match(sql, /evaluator_score_events_immutable/);
  assert.match(sql, /commercial_access_events_immutable/);
  assert.match(sql, /event_type IN \('draft','submitted','reopened','superseded'\)/);
});

test("repository separates sealed price authorization and never calculates with confidence", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/evaluationEngine/postgresEvaluationEngineRepository.ts"), "utf8");
  assert.match(source, /commercial_access_events/);
  assert.match(source, /canViewCommercial/);
  assert.match(source, /calculateContribution\(\{ score: input\.score, rubricMaximum: maximum, weight \}\)/);
  assert.doesNotMatch(source, /calculateContribution\([^\n]*confidence/);
  assert.doesNotMatch(source, /aiRecommendedWinner|shortlist|awardWinner/);
});

test("evaluation APIs separate assigned scoring from owner-only management", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../routes/evaluationEngineRoute.ts"), "utf8");
  assert.match(routes, /score-events[^\n]+authorizeAction\("proposal:read"\)/);
  assert.match(routes, /assignments[^\n]+authorizeAction\("proposal:write"\)/);
  assert.match(routes, /commercial-access-events[^\n]+authorizeAction\("proposal:write"\)/);
});
