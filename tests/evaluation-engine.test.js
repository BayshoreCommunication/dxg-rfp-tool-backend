const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { aggregateCriterionScores, applyHumanReviews, buildAssessments, buildRisks, calculateContribution, coverageEligibility, normalizeCommercial, rubricMaximum } = require("../src/modules/evaluationEngine/domain");

const mapping = (overrides = {}) => ({ mappingId: "mapping", requirementId: "requirement", title: "Provide staffing coverage", mandatory: false, eligibility: false, relationship: "supports", confidence: 0.95, fragmentIds: ["fragment"], ...overrides });
const moneyFact = (overrides = {}) => ({ factId: "fact", factKey: "commercial.total", family: "commercial", factType: "commercial_total", statement: "Total is USD 100,000", valueKind: "money", normalizedValue: "USD 100000", typedValue: { kind: "money", number: 100000, currency: "USD" }, currency: "USD", contradictionGroup: null, fragmentIds: ["fragment"], ...overrides });
const review = (overrides = {}) => ({ reviewId: "review", targetType: "mapping", targetId: "mapping", decision: "accepted", correctedPayload: null, ...overrides });

test("assessment verdicts are deterministic and confidence only creates review metadata", () => {
  const high = buildAssessments([mapping({ confidence: 0.99 })])[0];
  const low = buildAssessments([mapping({ confidence: 0.2 })])[0];
  assert.equal(high.verdict, "addressed"); assert.equal(low.verdict, "addressed");
  assert.equal(high.reviewReasons.includes("low_extraction_confidence"), false);
  assert.equal(low.reviewReasons.includes("low_extraction_confidence"), true);
});

test("terminal human mapping review resolves model uncertainty without erasing the verdict", () => {
  const reviewed = buildAssessments([mapping({ confidence: 0.2, mandatory: true, relationship: "partially_supports", humanReviewDecision: "accepted" })])[0];
  assert.equal(reviewed.verdict, "partially_addressed");
  assert.equal(reviewed.needsHumanReview, false);
  assert.deepEqual(reviewed.reviewReasons, []);
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

test("criterion aggregation averages eligible evaluators and excludes observers and conflicts", () => {
  const aggregates = aggregateCriterionScores({
    criterionIds: ["technical", "commercial"],
    assignments: [
      { assignmentId: "evaluator-a", role: "combined", conflictStatus: "clear", criterionIds: ["technical", "commercial"] },
      { assignmentId: "evaluator-b", role: "technical", conflictStatus: "clear", criterionIds: ["technical"] },
      { assignmentId: "observer", role: "observer", conflictStatus: "clear", criterionIds: ["technical"] },
      { assignmentId: "conflicted", role: "combined", conflictStatus: "conflict", criterionIds: ["technical"] },
    ],
    scores: [
      { assignmentId: "evaluator-a", criterionId: "technical", eventType: "submitted", score: 4, weightedContribution: 20 },
      { assignmentId: "evaluator-b", criterionId: "technical", eventType: "submitted", score: 2, weightedContribution: 10 },
      { assignmentId: "observer", criterionId: "technical", eventType: "submitted", score: 5, weightedContribution: 25 },
      { assignmentId: "conflicted", criterionId: "technical", eventType: "submitted", score: 5, weightedContribution: 25 },
      { assignmentId: "evaluator-a", criterionId: "commercial", eventType: "submitted", score: 3, weightedContribution: 30 },
    ],
  });

  assert.deepEqual(aggregates, [
    { criterionId: "technical", submittedCount: 2, assignedCount: 2, mean: 3, minimum: 2, maximum: 4, spread: 2, meanWeightedContribution: 15 },
    { criterionId: "commercial", submittedCount: 1, assignedCount: 1, mean: 3, minimum: 3, maximum: 3, spread: 0, meanWeightedContribution: 30 },
  ]);
});

test("incomplete or bounded source coverage is ineligible for evaluation", () => {
  assert.deepEqual(coverageEligibility([]), { eligible: true, blockingCodes: [] });
  assert.deepEqual(coverageEligibility([
    { code: "PAGE_COVERAGE_INCOMPLETE" },
    { code: "SOURCE_COVERAGE_INCOMPLETE" },
    { code: "EVIDENCE_COVERAGE_BOUNDED" },
    { code: "SOURCE_COVERAGE_INCOMPLETE" },
  ]), { eligible: false, blockingCodes: ["EVIDENCE_COVERAGE_BOUNDED", "SOURCE_COVERAGE_INCOMPLETE"] });
});

test("coverage eligibility is a versioned assessment policy", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../migrations/postgres/055_evaluation_coverage_eligibility.up.sql"), "utf8");
  const domain = fs.readFileSync(path.join(__dirname, "../src/modules/evaluationEngine/domain.ts"), "utf8");
  assert.match(domain, /vendor-assessment\.v3/);
  assert.match(migration, /vendor-assessment\.v3/);
});

test("rejected mappings become cited-safe missing assessments instead of retaining model compliance", () => {
  const effective = applyHumanReviews({
    mappings: [mapping()],
    facts: [],
    reviews: [review({ decision: "rejected" })],
  });
  const assessment = buildAssessments(effective.mappings)[0];

  assert.equal(assessment.verdict, "missing");
  assert.deepEqual(assessment.fragmentIds, []);
  assert.match(assessment.rationale, /human reviewer rejected/i);
});

test("corrected mappings replace the model relationship and citations downstream", () => {
  const effective = applyHumanReviews({
    mappings: [mapping({ relationship: "supports", fragmentIds: ["model-fragment"] })],
    facts: [],
    reviews: [review({
      decision: "corrected",
      correctedPayload: { relationship: "partially_supports", fragmentIds: ["reviewed-fragment"] },
    })],
  });
  const assessment = buildAssessments(effective.mappings)[0];

  assert.equal(assessment.verdict, "partially_addressed");
  assert.deepEqual(assessment.fragmentIds, ["reviewed-fragment"]);
  assert.equal(assessment.confidence, 1);
  assert.match(assessment.rationale, /human reviewer corrected/i);
});

test("rejected facts are excluded and no longer leave false contradiction or price flags", () => {
  const first = moneyFact({ factId: "fact-1", normalizedValue: "USD 100000", typedValue: { kind: "money", number: 100000, currency: "USD" }, contradictionGroup: "contradiction:old" });
  const second = moneyFact({ factId: "fact-2", normalizedValue: "USD 120000", typedValue: { kind: "money", number: 120000, currency: "USD" }, contradictionGroup: "contradiction:old" });
  const effective = applyHumanReviews({
    mappings: [],
    facts: [first, second],
    reviews: [review({ targetType: "fact", targetId: "fact-2", decision: "rejected" })],
  });
  const commercial = normalizeCommercial(effective.facts);

  assert.deepEqual(effective.facts.map((fact) => fact.factId), ["fact-1"]);
  assert.equal(effective.facts[0].contradictionGroup, null);
  assert.equal(commercial.comparable, true);
  assert.equal(commercial.normalizedTotal, 100000);
});

test("corrected typed facts drive deterministic commercial normalization", () => {
  const effective = applyHumanReviews({
    mappings: [],
    facts: [moneyFact()],
    reviews: [review({
      targetType: "fact",
      targetId: "fact",
      decision: "corrected",
      correctedPayload: {
        normalizedValue: "USD 125000",
        typedValue: { kind: "money", number: 125000, currency: "USD" },
      },
    })],
  });
  const commercial = normalizeCommercial(effective.facts);

  assert.equal(effective.facts[0].normalizedValue, "USD 125000");
  assert.equal(commercial.submittedTotal, 125000);
  assert.equal(commercial.normalizedTotal, 125000);
});

test("invalid human correction payloads fail evaluation instead of silently corrupting totals", () => {
  assert.throws(
    () => applyHumanReviews({
      mappings: [],
      facts: [moneyFact()],
      reviews: [review({
        targetType: "fact",
        targetId: "fact",
        decision: "corrected",
        correctedPayload: {
          normalizedValue: "USD 125000",
          typedValue: { kind: "string", text: "USD 125000" },
        },
      })],
    }),
    (error) => error.code === "REVIEW_CORRECTION_INVALID",
  );
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

test("evaluation review inputs are checksummed and can create a superseding evaluation snapshot", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../migrations/postgres/054_evaluation_review_score_freshness.up.sql"), "utf8");
  const repository = fs.readFileSync(path.join(__dirname, "../src/modules/evaluationEngine/postgresEvaluationEngineRepository.ts"), "utf8");
  assert.match(migration, /review_input_checksum/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS vendor_evaluation_runs_intelligence_run_id_key/);
  assert.match(repository, /reviewInputChecksum/);
  assert.match(repository, /INTELLIGENCE_COVERAGE_INCOMPLETE/);
  assert.match(repository, /intelligence_run_id=\$1 AND review_input_checksum=\$2 AND scoring_policy_version=\$3/);
});

test("repository separates sealed price authorization and never calculates with confidence", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/evaluationEngine/postgresEvaluationEngineRepository.ts"), "utf8");
  assert.match(source, /commercial_access_events/);
  assert.match(source, /canViewCommercial/);
  assert.match(source, /calculateContribution\(\{ score: input\.score, rubricMaximum: maximum, weight \}\)/);
  assert.doesNotMatch(source, /calculateContribution\([^\n]*confidence/);
  assert.doesNotMatch(source, /aiRecommendedWinner|shortlist|awardWinner/);
});

test("observer assignments are read-only at the score mutation boundary", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/evaluationEngine/postgresEvaluationEngineRepository.ts"), "utf8");
  const scoreBoundary = source.slice(source.indexOf("async score("), source.indexOf("async reopen("));
  assert.match(scoreBoundary, /role === "observer"/);
  assert.match(scoreBoundary, /OBSERVER_SCORING_FORBIDDEN/);
});

test("repository applies append-only evidence reviews before assessments, risks, and pricing", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/evaluationEngine/postgresEvaluationEngineRepository.ts"), "utf8");
  const reviewRead = source.indexOf("FROM rfpilot.human_review_events");
  const projection = source.indexOf("applyHumanReviews({", reviewRead);
  const assessment = source.indexOf("buildAssessments(mappings)", projection);
  const commercial = source.indexOf("normalizeCommercial(facts)", projection);
  assert.ok(reviewRead >= 0 && projection > reviewRead);
  assert.ok(assessment > projection && commercial > projection);
});

test("evaluation APIs separate assigned scoring from owner-only management", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../routes/evaluationEngineRoute.ts"), "utf8");
  assert.match(routes, /score-events[^\n]+authorizeAction\("proposal:read"\)/);
  assert.match(routes, /assignments[^\n]+authorizeAction\("proposal:write"\)/);
  assert.match(routes, /commercial-access-events[^\n]+authorizeAction\("proposal:write"\)/);
});
