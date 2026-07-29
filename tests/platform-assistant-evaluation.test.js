require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ASSISTANT_EVALUATION_COVERAGE,
  PLATFORM_ASSISTANT_MINIMUM_EVALUATION_CASES,
  assistantEvaluationModels,
  assistantEvaluationThresholds,
  assistantModelPrice,
  compareAssistantEvaluationSummaries,
  estimatedAssistantCostUsd,
  parseAssistantEvaluationFixtures,
  percentile95,
  scoreAssistantEvaluation,
  summarizeAssistantEvaluation,
  validatedEvaluationResponse,
} = require("../src/modules/platformAssistant/evaluation");
const {
  platformFactsForQuery,
} = require("../src/modules/platformAssistant/platformKnowledge");
const {
  classifyAssistantIntent,
} = require("../src/modules/platformAssistant/intentRouter");

const rawFixtures = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      "fixtures/platform-assistant-evaluations.json",
    ),
    "utf8",
  ),
);

const observation = (overrides = {}) => ({
  fixtureId: "fixture",
  model: "model",
  schemaValid: true,
  citationValid: true,
  kind: "answer",
  content: "Open [Vendor Responses](/vendor-responses).",
  citationIds: ["platform:navigation:vendor-responses"],
  timeToFirstTokenMs: 500,
  completionLatencyMs: 1_000,
  inputTokens: 1_000,
  outputTokens: 100,
  estimatedCostUsd: 0.002,
  providerFailed: false,
  intentCorrect: true,
  ...overrides,
});

test("assistant evaluation fixtures cover at least 50 cases and every risk tag", () => {
  const parsed = parseAssistantEvaluationFixtures(rawFixtures);
  assert.deepEqual(parsed.errors, []);
  assert.ok(
    parsed.fixtures.length >= PLATFORM_ASSISTANT_MINIMUM_EVALUATION_CASES,
  );
  assert.equal(
    new Set(parsed.fixtures.map((fixture) => fixture.category)).size,
    10,
  );
  const coverage = new Set(parsed.fixtures.flatMap((fixture) => fixture.coverage));
  assert.deepEqual([...coverage].sort(), [...ASSISTANT_EVALUATION_COVERAGE].sort());
  assert.equal(parsed.baseline.promptVersion, "platform-assistant-prompt.v5");
  assert.ok(
    parsed.fixtures.some(
      (fixture) =>
        fixture.category === "prompt_injection" &&
        fixture.expected.critical,
    ),
  );
});

test("fixture parser rejects version drift, missing coverage, and duplicates", () => {
  const wrongVersion = parseAssistantEvaluationFixtures({
    ...rawFixtures,
    version: "old",
  });
  assert.match(wrongVersion.errors[0], /fixture version/);

  const duplicated = structuredClone(rawFixtures);
  duplicated.cases[1].id = duplicated.cases[0].id;
  duplicated.cases = duplicated.cases.slice(0, 49);
  duplicated.cases.forEach((fixture) => {
    fixture.coverage = fixture.coverage.filter(
      (tag) => tag !== "unauthorized_or_cross_tenant",
    );
  });
  const parsed = parseAssistantEvaluationFixtures(duplicated);
  assert.ok(parsed.errors.some((error) => error.includes("duplicated")));
  assert.ok(parsed.errors.some((error) => error.includes("at least 50")));
  assert.ok(
    parsed.errors.some((error) =>
      error.includes("missing coverage: unauthorized_or_cross_tenant"),
    ),
  );
});

test("evaluation scoring checks kind, grounding, route, and forbidden claims", () => {
  const fixture = parseAssistantEvaluationFixtures(rawFixtures).fixtures[0];
  const passing = scoreAssistantEvaluation(
    fixture,
    observation({ fixtureId: fixture.id }),
  );
  assert.equal(passing.passed, true);
  assert.deepEqual(passing.failures, []);

  const failing = scoreAssistantEvaluation(
    fixture,
    observation({
      fixtureId: fixture.id,
      kind: "abstention",
      content: "I sent it successfully.",
      citationIds: [],
    }),
  );
  assert.equal(failing.passed, false);
  assert.ok(failing.failures.some((failure) => failure.includes("kind")));
  assert.ok(failing.failures.some((failure) => failure.includes("citation")));
  assert.ok(failing.failures.some((failure) => failure.includes("route")));

  const wrongIntent = scoreAssistantEvaluation(
    fixture,
    observation({ fixtureId: fixture.id, intentCorrect: false }),
  );
  assert.ok(
    wrongIntent.failures.some((failure) =>
      failure.includes("intent classification"),
    ),
  );
});

test("production response validation is reused by the evaluation gate", () => {
  const evidence = platformFactsForQuery("Where are vendor responses?");
  const valid = validatedEvaluationResponse(
    {
      kind: "answer",
      content: "Open [Vendor Responses](/vendor-responses).",
      citationIds: ["platform:navigation:vendor-responses"],
    },
    evidence,
  );
  assert.equal(valid.schemaValid, true);
  assert.equal(valid.citationValid, true);

  const invalid = validatedEvaluationResponse(
    {
      kind: "answer",
      content: "Open [External](https://example.com).",
      citationIds: ["unknown"],
    },
    evidence,
  );
  assert.equal(invalid.schemaValid, false);
  assert.equal(invalid.citationValid, false);
});

test("official model prices produce a conservative uncached token cost", () => {
  const approved = assistantModelPrice("gpt-5.4-mini-2026-03-17");
  const candidate = assistantModelPrice("gpt-5.6-terra");
  assert.ok(approved);
  assert.ok(candidate);
  assert.equal(estimatedAssistantCostUsd(1_000, 100, approved), 0.0012);
  assert.equal(estimatedAssistantCostUsd(1_000, 100, candidate), 0.004);
  assert.equal(assistantModelPrice("unknown-model"), null);
});

test("release summary enforces quality, critical, latency, and cost gates", () => {
  const thresholds = {
    ...assistantEvaluationThresholds(),
    minimumCasePassRate: 0.9,
    p95TimeToFirstTokenMs: 5_000,
    p95CompletionLatencyMs: 20_000,
    p95CostUsd: 0.02,
  };
  const rows = Array.from({ length: 10 }, (_, index) => ({
    ...observation({
      fixtureId: `fixture-${index}`,
      timeToFirstTokenMs: 1_000 + index,
      completionLatencyMs: 2_000 + index,
      estimatedCostUsd: 0.005,
    }),
    passed: true,
    critical: index < 3,
    failures: [],
  }));
  const passing = summarizeAssistantEvaluation("model", rows, thresholds);
  assert.equal(passing.passedReleaseGate, true);
  assert.equal(passing.casePassRate, 1);
  assert.equal(passing.criticalFailures, 0);
  assert.equal(passing.intentAccuracy, 1);

  rows[0] = {
    ...rows[0],
    passed: false,
    failures: ["critical failure"],
  };
  rows[9] = {
    ...rows[9],
    timeToFirstTokenMs: 5_001,
    completionLatencyMs: 20_001,
    estimatedCostUsd: 0.020_001,
  };
  const failing = summarizeAssistantEvaluation("model", rows, thresholds);
  assert.equal(failing.passedReleaseGate, false);
  assert.equal(failing.criticalFailures, 1);
  assert.ok(failing.failures.some((failure) => failure.includes("critical")));
  assert.ok(
    failing.failures.some((failure) =>
      failure.includes("time to first token"),
    ),
  );
  assert.ok(
    failing.failures.some((failure) =>
      failure.includes("completion latency"),
    ),
  );
  assert.ok(failing.failures.some((failure) => failure.includes("p95 cost")));
});

test("candidate comparison rejects quality, grounding, intent, or critical regressions", () => {
  const thresholds = assistantEvaluationThresholds();
  const rows = Array.from({ length: 50 }, (_, index) => ({
    ...observation({ fixtureId: `fixture-${index}` }),
    passed: true,
    critical: index < 10,
    failures: [],
  }));
  const baseline = summarizeAssistantEvaluation("baseline", rows, thresholds);
  const candidate = summarizeAssistantEvaluation("candidate", rows, thresholds);
  assert.deepEqual(compareAssistantEvaluationSummaries(baseline, candidate), {
    passedPromotionGate: true,
    failures: [],
  });

  const regressedRows = [...rows];
  regressedRows[0] = {
    ...regressedRows[0],
    passed: false,
    intentCorrect: false,
    failures: ["intent classification mismatch"],
  };
  const regression = compareAssistantEvaluationSummaries(
    baseline,
    summarizeAssistantEvaluation("candidate", regressedRows, thresholds),
  );
  assert.equal(regression.passedPromotionGate, false);
  assert.ok(regression.failures.some((failure) => failure.includes("pass rate")));
  assert.ok(regression.failures.some((failure) => failure.includes("intent")));
  assert.ok(regression.failures.some((failure) => failure.includes("critical")));
});

test("provider empty and citation-manipulated outputs fail closed", () => {
  const parsed = parseAssistantEvaluationFixtures(rawFixtures);
  const invalidCases = parsed.fixtures.filter((fixture) =>
    fixture.coverage.includes("provider_invalid_output"),
  );
  assert.ok(invalidCases.length >= 2);
  for (const fixture of invalidCases) {
    const invalid = validatedEvaluationResponse(
      { kind: "answer", content: "", citationIds: ["invented:citation"] },
      [],
    );
    const row = scoreAssistantEvaluation(
      fixture,
      observation({
        fixtureId: fixture.id,
        schemaValid: invalid.schemaValid,
        citationValid: invalid.citationValid,
        kind: invalid.kind,
        content: invalid.content,
        citationIds: invalid.citationIds,
        providerFailed: true,
      }),
    );
    assert.equal(row.passed, false);
    assert.ok(row.failures.includes("provider request failed"));
    assert.ok(row.failures.includes("structured output is invalid"));
    assert.ok(row.failures.includes("citation validation failed"));
  }
});

test("all fixtures declare the deterministic intent produced by the runtime router", () => {
  const parsed = parseAssistantEvaluationFixtures(rawFixtures);
  const mismatches = parsed.fixtures.flatMap((fixture) => {
    const history = fixture.history.map((message, index) => ({
      id: `history-${index}`,
      role: message.role,
      content: message.content,
      status: "complete",
      intent: message.intent ?? null,
    }));
    const actual = classifyAssistantIntent({
      query: fixture.query,
      uiContext: null,
      history,
    }).intent;
    return actual === fixture.expected.intent
      ? []
      : [`${fixture.id}: expected ${fixture.expected.intent}, received ${actual}`];
  });
  assert.deepEqual(mismatches, []);
});

test("percentile and model defaults remain deterministic", () => {
  assert.equal(percentile95([]), 0);
  assert.equal(percentile95([1, 2, 3, 4, 5]), 5);
  const models = assistantEvaluationModels();
  assert.ok(models.approvedModel);
  assert.ok(models.candidateModel);
});
