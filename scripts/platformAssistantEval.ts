import "../config/env";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assistantEvaluationBudgetsApproved,
  compareAssistantEvaluationSummaries,
  assistantEvaluationModels,
  assistantEvaluationThresholds,
  assistantModelPrice,
  estimatedAssistantCostUsd,
  parseAssistantEvaluationFixtures,
  scoreAssistantEvaluation,
  summarizeAssistantEvaluation,
  validatedEvaluationResponse,
  type AssistantEvaluationFixture,
  type AssistantEvaluationObservation,
  type AssistantEvaluationRow,
  type AssistantModelPrice,
} from "../src/modules/platformAssistant/evaluation";
import {
  buildAssistantPromptInput,
} from "../src/modules/platformAssistant/prompt";
import {
  platformFactsForConversation,
} from "../src/modules/platformAssistant/platformKnowledge";
import { classifyAssistantIntent } from "../src/modules/platformAssistant/intentRouter";
import {
  OpenAiAssistantProvider,
} from "../src/modules/platformAssistant/openAiAssistantProvider";
import type {
  AssistantAttemptLedger,
} from "../src/modules/platformAssistant/assistantAttemptLedger";
import type {
  AssistantMessage,
  PlatformAssistantContext,
} from "../src/modules/platformAssistant/domain";

const fixturePath = path.join(
  __dirname,
  "..",
  "tests",
  "fixtures",
  "platform-assistant-evaluations.json",
);

const rawFixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as unknown;
const parsedFixtures = parseAssistantEvaluationFixtures(rawFixtures);
const live = process.argv.includes("--live");

const printTable = (headers: string[], rows: string[][]): void => {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  console.log(line(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
};

const fail = (message: string, exitCode = 1): never => {
  console.error(`FAILED ${message}`);
  process.exit(exitCode);
};

const requiredModelPrice = (
  model: string,
  role: "approved" | "candidate",
): AssistantModelPrice => {
  const price = assistantModelPrice(model, role);
  if (price) return price;
  return fail(
    `pricing is unavailable for ${model}; set the ${role.toUpperCase()} input/output price environment overrides`,
  );
};

const assertFixtureIntegrity = (): AssistantEvaluationFixture[] => {
  if (parsedFixtures.errors.length) {
    for (const error of parsedFixtures.errors) console.error(`FAILED ${error}`);
    process.exit(1);
  }
  return parsedFixtures.fixtures;
};

const offline = (fixtures: AssistantEvaluationFixture[]): void => {
  console.log("Platform Assistant evaluation — offline integrity mode\n");
  printTable(
    ["fixture", "category", "coverage", "critical", "evidence", "integrity"],
    fixtures.map((fixture) => [
      fixture.id,
      fixture.category,
      String(fixture.coverage.length),
      fixture.expected.critical ? "yes" : "no",
      String(fixture.evidence.length),
      "ok",
    ]),
  );
  console.log(
    `\nPASS ${fixtures.length} versioned fixtures cover every production-copilot evaluation category and risk tag.`,
  );
  console.log(
    "Run `npm run eval:assistant:live` only in staging after setting the explicit live-evaluation gate and provider credential.",
  );
};

const context = (): PlatformAssistantContext => ({
  organizationMongoId: "eeeeeeeeeeeeeeeeeeeeeeee",
  actorUserMongoId: "ffffffffffffffffffffffff",
  correlationId: crypto.randomUUID(),
});

const userMessage = (
  fixture: AssistantEvaluationFixture,
): AssistantMessage => {
  const stamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    threadId: crypto.randomUUID(),
    ordinal: 1,
    role: "user",
    content: fixture.query,
    status: "complete",
    providerResponseId: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    safeErrorCode: null,
    intent: null,
    intentVersion: null,
    intentSource: null,
    intentConfidence: null,
    responseKind: null,
    promptVersion: null,
    knowledgeVersion: null,
    firstTokenMs: null,
    completionLatencyMs: null,
    citations: [],
    feedback: null,
    createdAt: stamp,
    updatedAt: stamp,
    completedAt: stamp,
  };
};

const historyMessages = (
  fixture: AssistantEvaluationFixture,
): AssistantMessage[] => {
  const threadId = crypto.randomUUID();
  const stamp = new Date().toISOString();
  return fixture.history.map((message, index) => ({
    id: crypto.randomUUID(),
    threadId,
    ordinal: index + 1,
    role: message.role,
    content: message.content,
    status: "complete",
    providerResponseId: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    safeErrorCode: null,
    intent: message.intent ?? null,
    intentVersion: message.intent ? "assistant-intent-router.v1" : null,
    intentSource: message.intent ? "deterministic" : null,
    intentConfidence: message.intent ? "high" : null,
    responseKind: null,
    promptVersion: null,
    knowledgeVersion: null,
    firstTokenMs: null,
    completionLatencyMs: null,
    citations: [],
    feedback: null,
    createdAt: stamp,
    updatedAt: stamp,
    completedAt: stamp,
  }));
};

const evaluationLedger = (): AssistantAttemptLedger => ({
  async begin(input) {
    return {
      id: crypto.randomUUID(),
      fingerprint: `assistant-eval:${crypto.randomUUID()}`,
      attemptNumber: 1,
      context: {
        runType: "platform_assistant",
        runId: input.assistantMessageId,
        organizationId: crypto.randomUUID(),
      },
    };
  },
  async complete() {},
});

const runFixture = async (
  fixture: AssistantEvaluationFixture,
  model: string,
  role: "approved" | "candidate",
): Promise<AssistantEvaluationRow> => {
  const price = requiredModelPrice(model, role);
  const previousModel = process.env.AI_ASSISTANT_MODEL;
  process.env.AI_ASSISTANT_MODEL = model;
  const startedAt = performance.now();
  let firstTokenAt: number | null = null;
  let output: unknown = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let providerFailed = false;
  let streamedContent = "";
  const promptUser = userMessage(fixture);
  const history = historyMessages(fixture);
  const intent = classifyAssistantIntent({
    query: fixture.query,
    uiContext: null,
    history,
    currentUserMessageId: promptUser.id,
  });
  const prompt = buildAssistantPromptInput({
    userMessage: promptUser,
    history,
    platformFacts: platformFactsForConversation(
      fixture.query,
      history,
      promptUser.id,
    ),
    operatingGuidance: fixture.evidence,
    intent,
  });

  try {
    const provider = new OpenAiAssistantProvider({
      ledger: evaluationLedger(),
    });
    for await (const event of provider.stream(prompt, {
      context: context(),
      assistantMessageId: crypto.randomUUID(),
      signal: new AbortController().signal,
    })) {
      if (event.type === "text_delta") {
        firstTokenAt ??= performance.now();
        streamedContent += event.delta;
      } else if (event.type === "completed") {
        output = event.output;
        inputTokens = event.usage.inputTokens;
        outputTokens = event.usage.outputTokens;
      } else if (event.type === "failed") {
        providerFailed = true;
      }
    }
  } finally {
    if (previousModel === undefined) delete process.env.AI_ASSISTANT_MODEL;
    else process.env.AI_ASSISTANT_MODEL = previousModel;
  }

  const completedAt = performance.now();
  const validated = validatedEvaluationResponse(output, prompt.evidence);
  const observation: AssistantEvaluationObservation = {
    fixtureId: fixture.id,
    model,
    schemaValid: validated.schemaValid,
    citationValid: validated.citationValid,
    kind: validated.kind,
    content: validated.content || streamedContent,
    citationIds: validated.citationIds,
    timeToFirstTokenMs:
      firstTokenAt === null ? null : Math.round(firstTokenAt - startedAt),
    completionLatencyMs: Math.round(completedAt - startedAt),
    inputTokens,
    outputTokens,
    estimatedCostUsd: estimatedAssistantCostUsd(
      inputTokens,
      outputTokens,
      price,
    ),
    providerFailed,
    intentCorrect: intent.intent === fixture.expected.intent,
  };
  return scoreAssistantEvaluation(fixture, observation);
};

const assertLiveEnvironment = (): void => {
  const missing: string[] = [];
  if (process.env.AI_ENVIRONMENT !== "staging") {
    missing.push("AI_ENVIRONMENT=staging");
  }
  if (process.env.AI_ASSISTANT_EVAL_LIVE !== "true") {
    missing.push("AI_ASSISTANT_EVAL_LIVE=true");
  }
  if (process.env.AI_ASSISTANT_ENABLED !== "true") {
    missing.push("AI_ASSISTANT_ENABLED=true");
  }
  if (process.env.AI_ASSISTANT_KILL_SWITCH !== "false") {
    missing.push("AI_ASSISTANT_KILL_SWITCH=false");
  }
  if (process.env.LIVE_AI_KILL_SWITCH !== "false") {
    missing.push("LIVE_AI_KILL_SWITCH=false");
  }
  if (process.env.LIVE_AI_PILOT_ENABLED !== "true") {
    missing.push("LIVE_AI_PILOT_ENABLED=true");
  }
  if (process.env.LIVE_AI_PROVIDER !== "openai") {
    missing.push("LIVE_AI_PROVIDER=openai");
  }
  if (!String(process.env.OPENAI_API_KEY || "").trim()) {
    missing.push("OPENAI_API_KEY");
  }
  if (String(process.env.AI_SAFETY_IDENTIFIER_SECRET || "").length < 32) {
    missing.push("AI_SAFETY_IDENTIFIER_SECRET (at least 32 characters)");
  }
  if (missing.length) {
    fail(
      `live evaluation is deny-by-default; missing: ${missing.join(", ")}`,
      2,
    );
  }
};

const runModel = async (
  fixtures: AssistantEvaluationFixture[],
  model: string,
  role: "approved" | "candidate",
): Promise<AssistantEvaluationRow[]> => {
  const rows: AssistantEvaluationRow[] = [];
  for (const fixture of fixtures) {
    rows.push(await runFixture(fixture, model, role));
  }
  return rows;
};

const liveEvaluation = async (
  fixtures: AssistantEvaluationFixture[],
): Promise<void> => {
  assertLiveEnvironment();
  const thresholds = assistantEvaluationThresholds();
  const models = assistantEvaluationModels();
  const targets = [
    { model: models.approvedModel, role: "approved" as const },
    ...(models.candidateModel === models.approvedModel
      ? []
      : [{ model: models.candidateModel, role: "candidate" as const }]),
  ];

  console.log("Platform Assistant evaluation — staging model comparison\n");
  console.log(
    `Thresholds: pass>=${thresholds.minimumCasePassRate}, schema=${thresholds.requiredSchemaValidity}, citations=${thresholds.requiredCitationValidity}, intent=${thresholds.requiredIntentAccuracy}, p95 TTFT<=${thresholds.p95TimeToFirstTokenMs}ms, p95 completion<=${thresholds.p95CompletionLatencyMs}ms, p95 cost<=$${thresholds.p95CostUsd.toFixed(6)}.`,
  );
  console.log(
    `Budget approval: ${assistantEvaluationBudgetsApproved() ? "approved" : "pending"}\n`,
  );

  const summaries = [];
  for (const target of targets) {
    const rows = await runModel(fixtures, target.model, target.role);
    printTable(
      ["model", "fixture", "quality", "ttft", "complete", "tokens", "cost"],
      rows.map((row) => [
        row.model,
        row.fixtureId,
        row.passed ? "PASS" : `FAIL (${row.failures.join("; ")})`,
        row.timeToFirstTokenMs === null
          ? "n/a"
          : `${row.timeToFirstTokenMs}ms`,
        `${row.completionLatencyMs}ms`,
        `${row.inputTokens}/${row.outputTokens}`,
        `$${row.estimatedCostUsd.toFixed(6)}`,
      ]),
    );
    const summary = summarizeAssistantEvaluation(
      target.model,
      rows,
      thresholds,
    );
    summaries.push({ ...summary, role: target.role });
    console.log(
      `\n${target.role.toUpperCase()} ${target.model}: ${summary.passedReleaseGate ? "PASS" : "FAIL"}; cases=${summary.passed}/${summary.total}, p95 TTFT=${summary.p95TimeToFirstTokenMs}ms, p95 completion=${summary.p95CompletionLatencyMs}ms, p95 cost=$${summary.p95CostUsd.toFixed(6)}.`,
    );
    for (const failure of summary.failures) console.error(`FAILED ${failure}`);
    console.log("");
  }

  const approved =
    summaries.find((summary) => summary.role === "approved") ??
    fail("the approved assistant model did not produce an evaluation summary");
  if (!approved.passedReleaseGate) {
    fail("the approved assistant model did not pass its release gate");
  }
  if (!assistantEvaluationBudgetsApproved()) {
    fail(
      "latency and cost budgets are measured but not approved; set AI_ASSISTANT_EVAL_BUDGETS_APPROVED=true only after product-owner approval",
      2,
    );
  }
  console.log(
    "PASS the approved model satisfies the Phase 5 quality, latency, and cost release gate.",
  );
  const candidate = summaries.find((summary) => summary.role === "candidate");
  if (candidate) {
    const comparison = compareAssistantEvaluationSummaries(approved, candidate);
    for (const failure of comparison.failures) {
      console.error(`FAILED candidate comparison: ${failure}`);
    }
    console.log(
      comparison.passedPromotionGate
        ? "Candidate passed the non-regression comparison gate. Promotion remains an explicit, human-approved configuration decision."
        : "Candidate did not pass its comparison gate. Keep the approved model unchanged.",
    );
  }
};

const fixtures = assertFixtureIntegrity();
if (!live) offline(fixtures);
else {
  liveEvaluation(fixtures).catch((error: unknown) => {
    console.error(
      `FAILED ${error instanceof Error ? error.message : "live evaluation failed"}`,
    );
    process.exitCode = 1;
  });
}
