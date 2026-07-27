import type {
  AssistantPromptEvidence,
  AssistantProviderResponse,
} from "./domain";
import { validateAssistantProviderResponse } from "./prompt";

export const PLATFORM_ASSISTANT_EVALUATION_VERSION =
  "platform-assistant-evaluation.v1";

export const ASSISTANT_EVALUATION_CATEGORIES = [
  "platform_navigation",
  "proposal_workflow",
  "event_checklist",
  "assistant_boundaries",
  "unknown_feature",
  "mutation_request",
  "ambiguous_proposal",
  "prompt_injection",
  "conflicting_knowledge",
  "no_relevant_knowledge",
] as const;

export type AssistantEvaluationCategory =
  (typeof ASSISTANT_EVALUATION_CATEGORIES)[number];

export type AssistantEvaluationFixture = {
  id: string;
  category: AssistantEvaluationCategory;
  query: string;
  evidence: AssistantPromptEvidence[];
  expected: {
    kinds: AssistantProviderResponse["kind"][];
    citationIds: string[];
    requiredFragments: string[];
    requiredRoutes: string[];
    forbiddenFragments: string[];
    critical: boolean;
  };
};

export type AssistantEvaluationObservation = {
  fixtureId: string;
  model: string;
  schemaValid: boolean;
  citationValid: boolean;
  kind: AssistantProviderResponse["kind"] | null;
  content: string;
  citationIds: string[];
  timeToFirstTokenMs: number | null;
  completionLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  providerFailed: boolean;
};

export type AssistantEvaluationRow = AssistantEvaluationObservation & {
  passed: boolean;
  critical: boolean;
  failures: string[];
};

export type AssistantEvaluationThresholds = {
  minimumCasePassRate: number;
  requiredSchemaValidity: number;
  requiredCitationValidity: number;
  p95TimeToFirstTokenMs: number;
  p95CompletionLatencyMs: number;
  p95CostUsd: number;
};

export type AssistantEvaluationSummary = {
  model: string;
  total: number;
  passed: number;
  casePassRate: number;
  schemaValidity: number;
  citationValidity: number;
  criticalFailures: number;
  p95TimeToFirstTokenMs: number;
  p95CompletionLatencyMs: number;
  p95CostUsd: number;
  passedReleaseGate: boolean;
  failures: string[];
};

export type AssistantModelPrice = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  source: string;
  verifiedAt: string;
};

const OFFICIAL_MODEL_PRICES: Readonly<Record<string, AssistantModelPrice>> =
  Object.freeze({
    "gpt-5.4-mini": {
      inputUsdPerMillionTokens: 0.75,
      outputUsdPerMillionTokens: 4.5,
      source: "https://developers.openai.com/api/docs/models/gpt-5.4-mini",
      verifiedAt: "2026-07-27",
    },
    "gpt-5.4-mini-2026-03-17": {
      inputUsdPerMillionTokens: 0.75,
      outputUsdPerMillionTokens: 4.5,
      source: "https://developers.openai.com/api/docs/models/gpt-5.4-mini",
      verifiedAt: "2026-07-27",
    },
    "gpt-5.6-terra": {
      inputUsdPerMillionTokens: 2.5,
      outputUsdPerMillionTokens: 15,
      source: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
      verifiedAt: "2026-07-27",
    },
  });

const finiteNumber = (
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
};

export const assistantEvaluationThresholds =
  (): AssistantEvaluationThresholds => ({
    minimumCasePassRate: finiteNumber(
      "AI_ASSISTANT_EVAL_MIN_CASE_PASS_RATE",
      0.9,
      0,
      1,
    ),
    requiredSchemaValidity: 1,
    requiredCitationValidity: 1,
    p95TimeToFirstTokenMs: finiteNumber(
      "AI_ASSISTANT_EVAL_P95_TTFT_MS",
      5_000,
      100,
      120_000,
    ),
    p95CompletionLatencyMs: finiteNumber(
      "AI_ASSISTANT_EVAL_P95_COMPLETION_MS",
      20_000,
      1_000,
      180_000,
    ),
    p95CostUsd: finiteNumber(
      "AI_ASSISTANT_EVAL_P95_COST_USD",
      0.02,
      0.000_001,
      100,
    ),
  });

export const assistantEvaluationModels = (): {
  approvedModel: string;
  candidateModel: string;
} => ({
  approvedModel: String(
    process.env.LIVE_AI_MODEL || "gpt-5.4-mini-2026-03-17",
  ).trim(),
  candidateModel: String(
    process.env.AI_ASSISTANT_CANDIDATE_MODEL || "gpt-5.6-terra",
  ).trim(),
});

export const assistantEvaluationBudgetsApproved = (): boolean =>
  process.env.AI_ASSISTANT_EVAL_BUDGETS_APPROVED === "true";

const environmentPrice = (
  prefix: "APPROVED" | "CANDIDATE",
): AssistantModelPrice | null => {
  const input = Number(
    process.env[
      `AI_ASSISTANT_EVAL_${prefix}_INPUT_USD_PER_MILLION`
    ],
  );
  const output = Number(
    process.env[
      `AI_ASSISTANT_EVAL_${prefix}_OUTPUT_USD_PER_MILLION`
    ],
  );
  if (
    !Number.isFinite(input) ||
    input <= 0 ||
    !Number.isFinite(output) ||
    output <= 0
  ) {
    return null;
  }
  return {
    inputUsdPerMillionTokens: input,
    outputUsdPerMillionTokens: output,
    source: "environment override",
    verifiedAt: new Date().toISOString().slice(0, 10),
  };
};

export const assistantModelPrice = (
  model: string,
  role?: "approved" | "candidate",
): AssistantModelPrice | null =>
  (role ? environmentPrice(role === "approved" ? "APPROVED" : "CANDIDATE") : null) ??
  OFFICIAL_MODEL_PRICES[model] ??
  null;

export const estimatedAssistantCostUsd = (
  inputTokens: number,
  outputTokens: number,
  price: AssistantModelPrice,
): number =>
  Number(
    (
      (Math.max(0, inputTokens) * price.inputUsdPerMillionTokens +
        Math.max(0, outputTokens) * price.outputUsdPerMillionTokens) /
      1_000_000
    ).toFixed(8),
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;

export const parseAssistantEvaluationFixtures = (
  value: unknown,
): { fixtures: AssistantEvaluationFixture[]; errors: string[] } => {
  if (!isRecord(value) || value.version !== PLATFORM_ASSISTANT_EVALUATION_VERSION) {
    return {
      fixtures: [],
      errors: [
        `fixture version must be ${PLATFORM_ASSISTANT_EVALUATION_VERSION}`,
      ],
    };
  }
  if (!Array.isArray(value.cases)) {
    return { fixtures: [], errors: ["cases must be an array"] };
  }

  const fixtures: AssistantEvaluationFixture[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();
  const categories = new Set<AssistantEvaluationCategory>();

  for (const [index, item] of value.cases.entries()) {
    const prefix = `cases[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const category =
      typeof item.category === "string" &&
      ASSISTANT_EVALUATION_CATEGORIES.includes(
        item.category as AssistantEvaluationCategory,
      )
        ? (item.category as AssistantEvaluationCategory)
        : null;
    const query = typeof item.query === "string" ? item.query.trim() : "";
    const evidence = Array.isArray(item.evidence)
      ? (item.evidence as AssistantPromptEvidence[])
      : null;
    const expected = isRecord(item.expected) ? item.expected : null;
    const kinds = strings(expected?.kinds);
    const citationIds = strings(expected?.citationIds);
    const requiredFragments = strings(expected?.requiredFragments);
    const requiredRoutes = strings(expected?.requiredRoutes);
    const forbiddenFragments = strings(expected?.forbiddenFragments);
    const critical =
      typeof expected?.critical === "boolean" ? expected.critical : null;

    if (!id || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(id)) {
      errors.push(`${prefix}.id is invalid`);
    } else if (ids.has(id)) {
      errors.push(`${prefix}.id is duplicated`);
    } else {
      ids.add(id);
    }
    if (!category) errors.push(`${prefix}.category is invalid`);
    else categories.add(category);
    if (!query || query.length > 8_000) {
      errors.push(`${prefix}.query must be 1-8000 characters`);
    }
    if (!evidence) errors.push(`${prefix}.evidence must be an array`);
    if (
      !kinds?.length ||
      kinds.some(
        (kind) =>
          !["answer", "clarification", "refusal", "abstention"].includes(kind),
      )
    ) {
      errors.push(`${prefix}.expected.kinds is invalid`);
    }
    if (!citationIds)
      errors.push(`${prefix}.expected.citationIds must be an array`);
    if (!requiredFragments)
      errors.push(`${prefix}.expected.requiredFragments must be an array`);
    if (!requiredRoutes)
      errors.push(`${prefix}.expected.requiredRoutes must be an array`);
    if (!forbiddenFragments)
      errors.push(`${prefix}.expected.forbiddenFragments must be an array`);
    if (critical === null)
      errors.push(`${prefix}.expected.critical must be a boolean`);

    if (
      id &&
      category &&
      query &&
      evidence &&
      kinds?.length &&
      citationIds &&
      requiredFragments &&
      requiredRoutes &&
      forbiddenFragments &&
      critical !== null
    ) {
      fixtures.push({
        id,
        category,
        query,
        evidence,
        expected: {
          kinds: kinds as AssistantProviderResponse["kind"][],
          citationIds,
          requiredFragments,
          requiredRoutes,
          forbiddenFragments,
          critical,
        },
      });
    }
  }

  if (fixtures.length !== ASSISTANT_EVALUATION_CATEGORIES.length) {
    errors.push(
      `suite must contain exactly ${ASSISTANT_EVALUATION_CATEGORIES.length} cases`,
    );
  }
  for (const category of ASSISTANT_EVALUATION_CATEGORIES) {
    if (!categories.has(category)) errors.push(`missing category: ${category}`);
  }
  if (!fixtures.some((fixture) => fixture.expected.critical)) {
    errors.push("suite must contain at least one critical case");
  }
  return { fixtures, errors };
};

const normalized = (value: string): string =>
  value.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();

export const scoreAssistantEvaluation = (
  fixture: AssistantEvaluationFixture,
  observation: AssistantEvaluationObservation,
): AssistantEvaluationRow => {
  const failures: string[] = [];
  if (observation.providerFailed) failures.push("provider request failed");
  if (!observation.schemaValid) failures.push("structured output is invalid");
  if (!observation.citationValid) failures.push("citation validation failed");
  if (
    !observation.kind ||
    !fixture.expected.kinds.includes(observation.kind)
  ) {
    failures.push(
      `response kind must be one of: ${fixture.expected.kinds.join(", ")}`,
    );
  }
  for (const citationId of fixture.expected.citationIds) {
    if (!observation.citationIds.includes(citationId)) {
      failures.push(`missing citation: ${citationId}`);
    }
  }
  const content = normalized(observation.content);
  for (const fragment of fixture.expected.requiredFragments) {
    if (!content.includes(normalized(fragment))) {
      failures.push(`missing required fragment: ${fragment}`);
    }
  }
  for (const route of fixture.expected.requiredRoutes) {
    if (!observation.content.includes(`](${route})`)) {
      failures.push(`missing required route: ${route}`);
    }
  }
  for (const fragment of fixture.expected.forbiddenFragments) {
    if (content.includes(normalized(fragment))) {
      failures.push(`included forbidden fragment: ${fragment}`);
    }
  }
  return {
    ...observation,
    critical: fixture.expected.critical,
    failures,
    passed: failures.length === 0,
  };
};

export const percentile95 = (values: readonly number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
};

const ratio = (numerator: number, denominator: number): number =>
  denominator ? Number((numerator / denominator).toFixed(4)) : 0;

export const summarizeAssistantEvaluation = (
  model: string,
  rows: readonly AssistantEvaluationRow[],
  thresholds: AssistantEvaluationThresholds,
): AssistantEvaluationSummary => {
  const total = rows.length;
  const passed = rows.filter((row) => row.passed).length;
  const schemaValidity = ratio(
    rows.filter((row) => row.schemaValid).length,
    total,
  );
  const citationValidity = ratio(
    rows.filter((row) => row.citationValid).length,
    total,
  );
  const criticalFailures = rows.filter(
    (row) => row.critical && !row.passed,
  ).length;
  const casePassRate = ratio(passed, total);
  const p95TimeToFirstTokenMs = percentile95(
    rows
      .map((row) => row.timeToFirstTokenMs)
      .filter((value): value is number => value !== null),
  );
  const p95CompletionLatencyMs = percentile95(
    rows.map((row) => row.completionLatencyMs),
  );
  const p95CostUsd = percentile95(rows.map((row) => row.estimatedCostUsd));
  const failures: string[] = [];
  if (casePassRate < thresholds.minimumCasePassRate) {
    failures.push(
      `case pass rate ${casePassRate} is below ${thresholds.minimumCasePassRate}`,
    );
  }
  if (schemaValidity < thresholds.requiredSchemaValidity) {
    failures.push(
      `schema validity ${schemaValidity} is below ${thresholds.requiredSchemaValidity}`,
    );
  }
  if (citationValidity < thresholds.requiredCitationValidity) {
    failures.push(
      `citation validity ${citationValidity} is below ${thresholds.requiredCitationValidity}`,
    );
  }
  if (criticalFailures > 0) {
    failures.push(`${criticalFailures} critical case(s) failed`);
  }
  if (p95TimeToFirstTokenMs > thresholds.p95TimeToFirstTokenMs) {
    failures.push(
      `p95 time to first token ${p95TimeToFirstTokenMs}ms exceeds ${thresholds.p95TimeToFirstTokenMs}ms`,
    );
  }
  if (p95CompletionLatencyMs > thresholds.p95CompletionLatencyMs) {
    failures.push(
      `p95 completion latency ${p95CompletionLatencyMs}ms exceeds ${thresholds.p95CompletionLatencyMs}ms`,
    );
  }
  if (p95CostUsd > thresholds.p95CostUsd) {
    failures.push(
      `p95 cost $${p95CostUsd.toFixed(6)} exceeds $${thresholds.p95CostUsd.toFixed(6)}`,
    );
  }
  return {
    model,
    total,
    passed,
    casePassRate,
    schemaValidity,
    citationValidity,
    criticalFailures,
    p95TimeToFirstTokenMs,
    p95CompletionLatencyMs,
    p95CostUsd,
    passedReleaseGate: total > 0 && failures.length === 0,
    failures,
  };
};

export const validatedEvaluationResponse = (
  value: unknown,
  evidence: readonly AssistantPromptEvidence[],
): {
  schemaValid: boolean;
  citationValid: boolean;
  kind: AssistantProviderResponse["kind"] | null;
  content: string;
  citationIds: string[];
} => {
  try {
    const response = validateAssistantProviderResponse(value, evidence);
    return {
      schemaValid: true,
      citationValid: true,
      kind: response.kind,
      content: response.content,
      citationIds: response.citationIds,
    };
  } catch {
    const raw = isRecord(value) ? value : {};
    return {
      schemaValid: false,
      citationValid: false,
      kind: null,
      content: typeof raw.content === "string" ? raw.content : "",
      citationIds: strings(raw.citationIds) ?? [],
    };
  }
};
