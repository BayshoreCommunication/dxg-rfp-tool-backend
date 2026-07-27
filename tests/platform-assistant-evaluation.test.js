require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  assistantEvaluationModels,
  assistantEvaluationThresholds,
  assistantModelPrice,
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
  ...overrides,
});

test("assistant evaluation fixtures cover every required category exactly once", () => {
  const parsed = parseAssistantEvaluationFixtures(rawFixtures);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.fixtures.length, 10);
  assert.equal(
    new Set(parsed.fixtures.map((fixture) => fixture.category)).size,
    10,
  );
  assert.ok(
    parsed.fixtures.some(
      (fixture) =>
        fixture.category === "prompt_injection" &&
        fixture.expected.critical,
    ),
  );
});

test("fixture parser rejects version drift, missing categories, and duplicates", () => {
  const wrongVersion = parseAssistantEvaluationFixtures({
    ...rawFixtures,
    version: "old",
  });
  assert.match(wrongVersion.errors[0], /fixture version/);

  const duplicated = structuredClone(rawFixtures);
  duplicated.cases[1].id = duplicated.cases[0].id;
  duplicated.cases.pop();
  const parsed = parseAssistantEvaluationFixtures(duplicated);
  assert.ok(parsed.errors.some((error) => error.includes("duplicated")));
  assert.ok(parsed.errors.some((error) => error.includes("exactly 10")));
  assert.ok(parsed.errors.some((error) => error.includes("missing category")));
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

test("percentile and model defaults remain deterministic", () => {
  assert.equal(percentile95([]), 0);
  assert.equal(percentile95([1, 2, 3, 4, 5]), 5);
  const models = assistantEvaluationModels();
  assert.ok(models.approvedModel);
  assert.ok(models.candidateModel);
});
