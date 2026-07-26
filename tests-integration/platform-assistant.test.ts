import "./env";
import {
  ensureMigrated,
  ensureServices,
  randomMongoId,
  seedTenant,
  type Tenant,
} from "./setup";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { closePostgres, postgresPool } from "../config/postgres";
import {
  platformAssistantApplication,
  platformAssistantRepository,
} from "../src/modules/platformAssistant/composition";

let tenant: Tenant;
let threadId: string;
let sameOrganizationActor: string;

process.env.LIVE_AI_KILL_SWITCH = "false";

const context = (actorUserMongoId = tenant.actorUserMongoId) => ({
  organizationMongoId: tenant.organizationMongoId,
  actorUserMongoId,
  correlationId: crypto.randomUUID(),
});

before(async () => {
  await ensureServices();
  ensureMigrated();
  tenant = await seedTenant("Platform Assistant Org");
  sameOrganizationActor = randomMongoId();
  await postgresPool().query(
    "INSERT INTO rfpilot.users(organization_id,external_mongo_id) VALUES($1,$2)",
    [tenant.organizationId, sameOrganizationActor],
  );
});

after(async () => {
  await closePostgres();
});

test("thread creation is durable and idempotent", async () => {
  const idempotencyKey = `assistant-thread:${crypto.randomUUID()}`;
  const created = await platformAssistantApplication.createThread(
    context(),
    { title: "Platform workflow" },
    idempotencyKey,
  );
  assert.equal(created.created, true);
  assert.equal(created.thread.title, "Platform workflow");
  assert.equal(created.thread.messageCount, 0);
  assert.equal(created.thread.status, "active");
  threadId = created.thread.id;

  const replay = await platformAssistantApplication.createThread(
    context(),
    { title: "Platform workflow" },
    idempotencyKey,
  );
  assert.equal(replay.created, false);
  assert.equal(replay.thread.id, threadId);

  await assert.rejects(
    platformAssistantApplication.createThread(
      context(),
      { title: "Different title" },
      idempotencyKey,
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "ASSISTANT_IDEMPOTENCY_CONFLICT",
  );
});

test("concurrent thread retries with one idempotency key create one thread", async () => {
  const idempotencyKey = `assistant-thread-concurrent:${crypto.randomUUID()}`;

  const [first, second] = await Promise.all([
    platformAssistantApplication.createThread(
      context(),
      { title: "Concurrent platform help" },
      idempotencyKey,
    ),
    platformAssistantApplication.createThread(
      context(),
      { title: "Concurrent platform help" },
      idempotencyKey,
    ),
  ]);

  assert.equal(first.thread.id, second.thread.id);
  assert.equal([first.created, second.created].filter(Boolean).length, 1);

  const result = await postgresPool().query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM rfpilot.assistant_threads AS thread
      JOIN rfpilot.organizations AS organization
        ON organization.id=thread.organization_id
      WHERE organization.external_mongo_id=$1
        AND thread.owner_external_user_id=$2
        AND thread.idempotency_key=$3
    `,
    [tenant.organizationMongoId, tenant.actorUserMongoId, idempotencyKey],
  );

  assert.equal(result.rows[0]?.count, "1");
});

test("owner can list and read the thread while another organization member cannot", async () => {
  const listed = await platformAssistantApplication.listThreads(context(), {
    limit: 25,
  });
  assert.ok(listed.some((thread) => thread.id === threadId));

  const detail = await platformAssistantApplication.getThread(context(), {
    threadId,
  });
  assert.equal(detail.thread.id, threadId);
  assert.deepEqual(detail.messages, []);

  await assert.rejects(
    platformAssistantApplication.getThread(context(sameOrganizationActor), {
      threadId,
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "ASSISTANT_THREAD_NOT_FOUND",
  );
});

test("user and assistant messages follow idempotent lifecycle contracts", async () => {
  const userKey = `assistant-message:${crypto.randomUUID()}`;
  const first = await platformAssistantApplication.appendUserMessage(context(), {
    threadId,
    body: { content: "How does the proposal workflow work?" },
    idempotencyKey: userKey,
  });
  assert.equal(first.created, true);
  assert.equal(first.message.role, "user");
  assert.equal(first.message.status, "complete");
  assert.equal(first.message.ordinal, 1);

  const replay = await platformAssistantApplication.appendUserMessage(context(), {
    threadId,
    body: { content: "How does the proposal workflow work?" },
    idempotencyKey: userKey,
  });
  assert.equal(replay.created, false);
  assert.equal(replay.message.id, first.message.id);

  await assert.rejects(
    platformAssistantApplication.appendUserMessage(context(), {
      threadId,
      body: { content: "A different request" },
      idempotencyKey: userKey,
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "ASSISTANT_IDEMPOTENCY_CONFLICT",
  );

  const assistant = await platformAssistantRepository.createAssistantMessage({
    ...context(),
    threadId,
    idempotencyKey: `assistant-response:${first.message.id}`,
  });
  assert.equal(assistant.created, true);
  assert.equal(assistant.message.role, "assistant");
  assert.equal(assistant.message.status, "pending");
  assert.equal(assistant.message.ordinal, 2);

  const streaming = await platformAssistantRepository.updateAssistantMessage({
    ...context(),
    threadId,
    messageId: assistant.message.id,
    status: "streaming",
    content: "The proposal workflow",
  });
  assert.equal(streaming.status, "streaming");

  const completed = await platformAssistantRepository.updateAssistantMessage({
    ...context(),
    threadId,
    messageId: assistant.message.id,
    status: "complete",
    content: "The proposal workflow moves from requirements through review and publication.",
    citations: [{ sourceId: "platform:proposal-workflow", title: "Proposal workflow" }],
    providerResponseId: "response_test",
    model: "deterministic-test",
    inputTokens: 20,
    outputTokens: 12,
  });
  assert.equal(completed.status, "complete");
  assert.equal(completed.citations.length, 1);
  assert.ok(completed.completedAt);

  await assert.rejects(
    platformAssistantRepository.updateAssistantMessage({
      ...context(),
      threadId,
      messageId: assistant.message.id,
      status: "streaming",
      content: completed.content,
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "INVALID_ASSISTANT_MESSAGE_STATE",
  );

  const detail = await platformAssistantApplication.getThread(context(), {
    threadId,
  });
  assert.equal(detail.thread.messageCount, 2);
  assert.deepEqual(detail.messages.map((message) => message.role), ["user", "assistant"]);
});

test("deterministic guidance persists a grounded response and replays idempotently", async () => {
  const idempotencyKey = `assistant-guidance:${crypto.randomUUID()}`;
  const generated = await platformAssistantApplication.generateGuidance(context(), {
    threadId,
    body: { content: "Explain the proposal review workflow." },
    idempotencyKey,
  });

  assert.equal(generated.knowledge.state, "unavailable");
  assert.equal(generated.assistantMessage.status, "complete");
  assert.equal(
    generated.assistantMessage.model,
    "platform-assistant-deterministic-v1",
  );
  assert.ok(
    generated.assistantMessage.citations.some(
      (citation) => citation.sourceId === "platform:proposal:workflow",
    ),
  );

  const replay = await platformAssistantApplication.generateGuidance(context(), {
    threadId,
    body: { content: "Explain the proposal review workflow." },
    idempotencyKey,
  });
  assert.equal(replay.knowledge.state, "not_requested");
  assert.equal(replay.userMessage.id, generated.userMessage.id);
  assert.equal(replay.assistantMessage.id, generated.assistantMessage.id);

  const detail = await platformAssistantApplication.getThread(context(), {
    threadId,
  });
  assert.equal(detail.thread.messageCount, 4);
  assert.equal(detail.messages.at(-1)?.id, generated.assistantMessage.id);
});

test("archived threads remain readable but reject new messages", async () => {
  const archived = await platformAssistantApplication.archiveThread(context(), threadId);
  assert.equal(archived.status, "archived");

  const detail = await platformAssistantApplication.getThread(context(), {
    threadId,
  });
  assert.equal(detail.thread.status, "archived");

  await assert.rejects(
    platformAssistantApplication.appendUserMessage(context(), {
      threadId,
      body: { content: "This should not be accepted" },
      idempotencyKey: crypto.randomUUID(),
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "ASSISTANT_THREAD_ARCHIVED",
  );
});
