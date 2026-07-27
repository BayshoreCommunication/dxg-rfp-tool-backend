import "./env";
import {
  ensureMigrated,
  ensureServices,
  seedTenant,
  type Tenant,
} from "./setup";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { closePostgres, postgresPool } from "../config/postgres";
import {
  createPlatformAssistantApplication,
} from "../src/modules/platformAssistant/application";
import { OpenAiAssistantProvider } from "../src/modules/platformAssistant/openAiAssistantProvider";
import { postgresAssistantRepository } from "../src/modules/platformAssistant/postgresAssistantRepository";
import { createPlatformAssistantStreamingApplication } from "../src/modules/platformAssistant/streamingApplication";

let tenant: Tenant;

Object.assign(process.env, {
  AI_ASSISTANT_ENABLED: "true",
  AI_ASSISTANT_KILL_SWITCH: "false",
  LIVE_AI_KILL_SWITCH: "false",
  LIVE_AI_PILOT_ENABLED: "true",
  LIVE_AI_PROVIDER: "openai",
  AI_ASSISTANT_MODEL: "integration-requested-model",
  OPENAI_API_KEY: "integration-fake-key",
  AI_SAFETY_IDENTIFIER_SECRET: "integration-safety-secret-".repeat(2),
  AI_ASSISTANT_PROVIDER_MAX_ATTEMPTS: "2",
  AI_ASSISTANT_STREAM_TIMEOUT_MS: "5000",
});

const context = () => ({
  organizationMongoId: tenant.organizationMongoId,
  actorUserMongoId: tenant.actorUserMongoId,
  correlationId: crypto.randomUUID(),
});

const output = (content: string) =>
  JSON.stringify({
    kind: "answer",
    content,
    citationIds: ["platform:navigation:proposals"],
  });

async function* successEvents(content: string, responseId: string) {
  const body = output(content);
  yield {
    type: "response.created",
    response: { id: responseId, model: "integration-effective-model" },
  };
  yield {
    type: "response.output_text.delta",
    delta: body.slice(0, 35),
  };
  yield {
    type: "response.output_text.delta",
    delta: body.slice(35),
  };
  yield {
    type: "response.completed",
    response: {
      id: responseId,
      model: "integration-effective-model",
      output_text: body,
      usage: { input_tokens: 31, output_tokens: 9 },
    },
  };
}

const createThread = async (title: string): Promise<string> => {
  const application = createPlatformAssistantApplication(
    postgresAssistantRepository,
  );
  const created = await application.createThread(
    context(),
    { title },
    `assistant-thread:${crypto.randomUUID()}`,
  );
  return created.thread.id;
};

const availableKnowledge = {
  async retrieve() {
    return {
      status: {
        state: "available" as const,
        policyVersion: null,
        resultCount: 0,
      },
      evidence: [],
    };
  },
};

before(async () => {
  await ensureServices();
  ensureMigrated();
  tenant = await seedTenant("Platform Assistant Streaming Org");
});

after(async () => {
  await closePostgres();
});

test("real repository and attempt ledger persist a completed streamed response", async () => {
  const threadId = await createThread("Streaming success");
  let providerCalls = 0;
  const provider = new OpenAiAssistantProvider({
    async streamFactory() {
      providerCalls += 1;
      return successEvents(
        "Open [Proposals](/proposals).",
        "resp_integration_success",
      );
    },
  });
  const application = createPlatformAssistantStreamingApplication(
    postgresAssistantRepository,
    { knowledgeSource: availableKnowledge, responseProvider: provider },
  );
  const events: Array<{ type: string; delta?: string }> = [];
  const idempotencyKey = `assistant-stream:${crypto.randomUUID()}`;
  const result = await application.streamGuidance(context(), {
    threadId,
    body: { content: "Where are proposals?" },
    idempotencyKey,
    signal: new AbortController().signal,
    emit(event) {
      events.push(event);
    },
  });

  assert.equal(providerCalls, 1);
  assert.equal(events[0]?.type, "message.accepted");
  assert.equal(events[1]?.type, "response.started");
  assert.equal(events.at(-1)?.type, "response.completed");
  assert.equal(
    events
      .filter((event) => event.type === "response.delta")
      .map((event) => event.delta ?? "")
      .join(""),
    "Open [Proposals](/proposals).",
  );
  assert.equal(result.assistantMessage.status, "complete");
  assert.equal(
    result.assistantMessage.content,
    "Open [Proposals](/proposals).",
  );
  assert.equal(
    result.assistantMessage.providerResponseId,
    "resp_integration_success",
  );
  assert.equal(result.assistantMessage.model, "integration-effective-model");
  assert.equal(result.assistantMessage.inputTokens, 31);
  assert.equal(result.assistantMessage.outputTokens, 9);
  assert.equal(
    result.assistantMessage.citations[0]?.sourceId,
    "platform:navigation:proposals",
  );

  const attempts = await postgresPool().query<{
    state: string;
    attempt_number: number;
    provider: string;
    model: string;
    operation: string;
    provider_request_id: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
  }>(
    `SELECT state,attempt_number,provider,model,operation,provider_request_id,
            input_tokens,output_tokens
     FROM rfpilot.ai_provider_attempts
     WHERE run_type='platform_assistant' AND run_id=$1
     ORDER BY attempt_number`,
    [result.assistantMessage.id],
  );
  assert.deepEqual(attempts.rows, [
    {
      state: "succeeded",
      attempt_number: 1,
      provider: "openai",
      model: "integration-requested-model",
      operation: "generateFromEvidence",
      provider_request_id: "resp_integration_success",
      input_tokens: 31,
      output_tokens: 9,
    },
  ]);

  const replayEvents: Array<{ type: string }> = [];
  const replay = await application.streamGuidance(context(), {
    threadId,
    body: { content: "Where are proposals?" },
    idempotencyKey,
    signal: new AbortController().signal,
    emit(event) {
      replayEvents.push(event);
    },
  });
  assert.equal(providerCalls, 1);
  assert.equal(replay.assistantMessage.id, result.assistantMessage.id);
  assert.deepEqual(replayEvents.map((event) => event.type), [
    "message.accepted",
    "response.completed",
  ]);
});

test("pre-delta retry writes a failed attempt followed by a succeeded attempt", async () => {
  const threadId = await createThread("Streaming retry");
  let providerCalls = 0;
  const provider = new OpenAiAssistantProvider({
    async streamFactory() {
      providerCalls += 1;
      if (providerCalls === 1) {
        throw Object.assign(new Error("private temporary provider detail"), {
          status: 503,
        });
      }
      return successEvents(
        "Open [Proposals](/proposals).",
        "resp_integration_retry",
      );
    },
    async sleep() {},
    random: () => 0,
  });
  const application = createPlatformAssistantStreamingApplication(
    postgresAssistantRepository,
    { knowledgeSource: availableKnowledge, responseProvider: provider },
  );
  const result = await application.streamGuidance(context(), {
    threadId,
    body: { content: "Where are proposals?" },
    idempotencyKey: `assistant-stream:${crypto.randomUUID()}`,
    signal: new AbortController().signal,
    emit() {},
  });
  assert.equal(providerCalls, 2);
  assert.equal(result.assistantMessage.status, "complete");

  const attempts = await postgresPool().query<{
    attempt_number: number;
    state: string;
    error_code: string | null;
  }>(
    `SELECT attempt_number,state,error_code
     FROM rfpilot.ai_provider_attempts
     WHERE run_type='platform_assistant' AND run_id=$1
     ORDER BY attempt_number`,
    [result.assistantMessage.id],
  );
  assert.deepEqual(attempts.rows, [
    {
      attempt_number: 1,
      state: "failed",
      error_code: "ASSISTANT_PROVIDER_TEMPORARY",
    },
    { attempt_number: 2, state: "succeeded", error_code: null },
  ]);
});

test("post-delta provider failure durably preserves the interrupted response", async () => {
  const threadId = await createThread("Streaming interruption");
  const provider = new OpenAiAssistantProvider({
    async streamFactory() {
      return (async function* () {
        yield {
          type: "response.created",
          response: {
            id: "resp_integration_partial",
            model: "integration-effective-model",
          },
        };
        yield {
          type: "response.output_text.delta",
          delta: '{"kind":"answer","content":"Partial durable text',
        };
        yield {
          type: "error",
          code: "server_error",
          message: "private provider error",
        };
      })();
    },
  });
  const application = createPlatformAssistantStreamingApplication(
    postgresAssistantRepository,
    { knowledgeSource: availableKnowledge, responseProvider: provider },
  );
  const result = await application.streamGuidance(context(), {
    threadId,
    body: { content: "Where are proposals?" },
    idempotencyKey: `assistant-stream:${crypto.randomUUID()}`,
    signal: new AbortController().signal,
    emit() {},
  });

  assert.equal(result.assistantMessage.status, "failed");
  assert.equal(result.assistantMessage.content, "Partial durable text");
  assert.equal(
    result.assistantMessage.safeErrorCode,
    "ASSISTANT_STREAM_INTERRUPTED",
  );
  const attempt = await postgresPool().query<{
    state: string;
    error_code: string;
  }>(
    `SELECT state,error_code
     FROM rfpilot.ai_provider_attempts
     WHERE run_type='platform_assistant' AND run_id=$1`,
    [result.assistantMessage.id],
  );
  assert.deepEqual(attempt.rows[0], {
    state: "failed",
    error_code: "ASSISTANT_STREAM_INTERRUPTED",
  });
});

test("explicit retry keeps one user message and creates a new assistant attempt", async () => {
  const threadId = await createThread("Explicit response retry");
  let providerCalls = 0;
  const provider = {
    provider: "integration-fake",
    model: "integration-fake-model",
    async *stream() {
      providerCalls += 1;
      if (providerCalls === 1) {
        yield {
          type: "failed" as const,
          providerResponseId: null,
          model: "integration-fake-model",
          code: "ASSISTANT_PROVIDER_TEMPORARY",
          message: "The assistant provider is temporarily unavailable.",
          retryable: true,
        };
        return;
      }
      yield {
        type: "started" as const,
        providerResponseId: "resp_explicit_retry",
        model: "integration-fake-model",
      };
      yield {
        type: "text_delta" as const,
        delta: "Open [Proposals](/proposals).",
      };
      yield {
        type: "completed" as const,
        providerResponseId: "resp_explicit_retry",
        model: "integration-fake-model",
        usage: { inputTokens: 18, outputTokens: 7 },
        output: {
          kind: "answer",
          content: "Open [Proposals](/proposals).",
          citationIds: ["platform:navigation:proposals"],
        },
      };
    },
  };
  const application = createPlatformAssistantStreamingApplication(
    postgresAssistantRepository,
    { knowledgeSource: availableKnowledge, responseProvider: provider },
  );
  const userIdempotencyKey = `assistant-stream:${crypto.randomUUID()}`;
  const first = await application.streamGuidance(context(), {
    threadId,
    body: { content: "Where are proposals?" },
    idempotencyKey: userIdempotencyKey,
    responseIdempotencyKey: `assistant-response:${crypto.randomUUID()}`,
    signal: new AbortController().signal,
    emit() {},
  });
  assert.equal(first.assistantMessage.status, "failed");

  const retried = await application.streamGuidance(context(), {
    threadId,
    body: { content: "Where are proposals?" },
    idempotencyKey: userIdempotencyKey,
    responseIdempotencyKey: `assistant-response:${crypto.randomUUID()}`,
    signal: new AbortController().signal,
    emit() {},
  });
  assert.equal(retried.assistantMessage.status, "complete");
  assert.equal(providerCalls, 2);

  const messages = await postgresPool().query<{
    role: string;
    status: string;
    content: string;
  }>(
    `SELECT role,status,content
     FROM rfpilot.assistant_messages
     WHERE thread_id=$1
     ORDER BY ordinal`,
    [threadId],
  );
  assert.deepEqual(messages.rows, [
    {
      role: "user",
      status: "complete",
      content: "Where are proposals?",
    },
    { role: "assistant", status: "failed", content: "" },
    {
      role: "assistant",
      status: "complete",
      content: "Open [Proposals](/proposals).",
    },
  ]);
});
