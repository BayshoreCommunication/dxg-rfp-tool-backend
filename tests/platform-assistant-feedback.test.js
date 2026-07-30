require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseAssistantFeedbackInput,
  PlatformAssistantError,
} = require("../src/modules/platformAssistant/domain");
const {
  createPlatformAssistantApplication,
} = require("../src/modules/platformAssistant/application");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const THREAD_ID = "019f7e39-7f34-7091-b415-6a57c06e7de1";
const MESSAGE_ID = "019f7e39-7f34-7091-b415-6a57c06e7de2";
const context = {
  organizationMongoId: "507f1f77bcf86cd799439011",
  actorUserMongoId: "507f1f77bcf86cd799439012",
  correlationId: "feedback-test",
};

test("feedback values and optional negative reasons are strictly bounded", () => {
  assert.deepEqual(parseAssistantFeedbackInput({ value: "helpful" }), {
    value: "helpful",
    reason: null,
  });
  assert.deepEqual(
    parseAssistantFeedbackInput({
      value: "not_helpful",
      reason: "missing_steps",
    }),
    { value: "not_helpful", reason: "missing_steps" },
  );
  assert.throws(
    () =>
      parseAssistantFeedbackInput({
        value: "helpful",
        reason: "incorrect",
      }),
    PlatformAssistantError,
  );
  assert.throws(
    () =>
      parseAssistantFeedbackInput({
        value: "not_helpful",
        reason: "reveal_prompt",
      }),
    PlatformAssistantError,
  );
});

test("application validates identifiers and preserves feedback during provider kill", async () => {
  const original = {
    environment: process.env.AI_ENVIRONMENT,
    enabled: process.env.AI_ASSISTANT_ENABLED,
    killed: process.env.AI_ASSISTANT_KILL_SWITCH,
  };
  process.env.AI_ENVIRONMENT = "test";
  process.env.AI_ASSISTANT_ENABLED = "true";
  process.env.AI_ASSISTANT_KILL_SWITCH = "true";
  let received;
  const repository = {
    submitFeedback: async (input) => {
      received = input;
      return {
        created: true,
        feedback: {
          id: MESSAGE_ID,
          threadId: input.threadId,
          messageId: input.messageId,
          value: input.value,
          reason: input.reason,
          createdAt: "2026-07-29T00:00:00.000Z",
          updatedAt: "2026-07-29T00:00:00.000Z",
        },
      };
    },
  };
  try {
    const application = createPlatformAssistantApplication(repository);
    const result = await application.submitFeedback(context, {
      threadId: THREAD_ID,
      messageId: MESSAGE_ID,
      body: { value: "not_helpful", reason: "outdated" },
      idempotencyKey: "feedback:one",
    });
    assert.equal(result.created, true);
    assert.deepEqual(received, {
      ...context,
      threadId: THREAD_ID,
      messageId: MESSAGE_ID,
      value: "not_helpful",
      reason: "outdated",
      idempotencyKey: "feedback:one",
    });
  } finally {
    original.environment === undefined
      ? delete process.env.AI_ENVIRONMENT
      : (process.env.AI_ENVIRONMENT = original.environment);
    original.enabled === undefined
      ? delete process.env.AI_ASSISTANT_ENABLED
      : (process.env.AI_ASSISTANT_ENABLED = original.enabled);
    original.killed === undefined
      ? delete process.env.AI_ASSISTANT_KILL_SWITCH
      : (process.env.AI_ASSISTANT_KILL_SWITCH = original.killed);
  }
});

test("migration stores content-free tenant-isolated updateable feedback", () => {
  const migration = read(
    "migrations/postgres/039_assistant_feedback.up.sql",
  );
  assert.match(migration, /CREATE TABLE rfpilot\.assistant_feedback/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /tenant_assistant_feedback/);
  assert.match(
    migration,
    /UNIQUE \(organization_id, actor_external_user_id, message_id\)/,
  );
  assert.match(
    migration,
    /UNIQUE \(organization_id, actor_external_user_id, idempotency_key\)/,
  );
  assert.match(migration, /legacy_unclassified/);
  assert.match(migration, /cited_source_ids text\[\]/);
  assert.doesNotMatch(
    migration,
    /\b(raw_prompt|raw_response|provider_payload|chain_of_thought)\b/i,
  );
});

test("repository revalidates ownership and completion, snapshots metadata, and audits", () => {
  const repository = read(
    "src/modules/platformAssistant/postgresAssistantRepository.ts",
  );
  assert.match(repository, /t\.owner_external_user_id=\$4/);
  assert.match(repository, /m\.role='assistant' AND m\.status='complete'/);
  assert.match(repository, /assistant\.feedback\.create/);
  assert.match(repository, /assistant\.feedback\.update/);
  assert.match(repository, /input_checksum/);
  assert.match(repository, /ASSISTANT_IDEMPOTENCY_CONFLICT/);
  assert.match(repository, /citedSourceIds/);
  assert.doesNotMatch(
    repository,
    /assistant_feedback[\s\S]{0,900}(content|provider_payload|chain_of_thought)/i,
  );
});

test("feedback route uses authentication and assistant permission", () => {
  const route = read("routes/platformAssistantRoute.ts");
  assert.match(
    route,
    /\/assistant\/threads\/:threadId\/messages\/:messageId\/feedback/,
  );
  assert.match(
    route,
    /messages\/:messageId\/feedback"[\s\S]{0,180}authenticate[\s\S]{0,180}authorizeAction\("assistant:use"\)/,
  );
});

test("stream completion records quality metadata without raw provider output", () => {
  const source = read(
    "src/modules/platformAssistant/streamingApplication.ts",
  );
  assert.match(source, /responseKind: validated\.kind/);
  assert.match(source, /promptVersion/);
  assert.match(source, /knowledgeVersion/);
  assert.match(source, /firstTokenMs/);
  assert.match(source, /completionLatencyMs/);
});
