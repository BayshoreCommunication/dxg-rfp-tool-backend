const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
require("ts-node/register");

const {
  ASSISTANT_CLIENT_EVENT_TYPES,
  ASSISTANT_PRODUCT_EVENT_TYPES,
  assistantErrorCategory,
  assistantLatencyBucket,
  parseAssistantClientProductEvent,
} = require("../src/modules/platformAssistant/productAnalytics");
const {
  createPlatformAssistantApplication,
} = require("../src/modules/platformAssistant/application");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const uuid = "019fb8c4-35d0-7cc9-8a6f-2cb5a164cf63";
const messageId = "019fb8c4-35d0-7cc9-8a6f-2cb5a164cf64";
const organizationMongoId = "507f1f77bcf86cd799439011";
const actorUserMongoId = "507f191e810c19729de860ea";

test("client event parser accepts only bounded content-free events", () => {
  const parsed = parseAssistantClientProductEvent({
    eventType: "citation_opened",
    sessionId: uuid,
    threadId: uuid,
    messageId,
    routeCategory: "proposals",
    prompt: "private question",
    response: "private answer",
    email: "person@example.test",
  });
  assert.deepEqual(parsed, {
    eventType: "citation_opened",
    sessionId: uuid,
    threadId: uuid,
    messageId,
    routeCategory: "proposals",
    findingCategory: null,
  });
  assert.throws(
    () =>
      parseAssistantClientProductEvent({
        eventType: "message_submitted",
        sessionId: uuid,
      }),
    /event type is not allowed/,
  );
  assert.throws(
    () =>
      parseAssistantClientProductEvent({
        eventType: "citation_opened",
        sessionId: uuid,
        messageId,
      }),
    /requires its conversation/,
  );
  assert.equal(ASSISTANT_CLIENT_EVENT_TYPES.length, 9);
  assert.equal(ASSISTANT_PRODUCT_EVENT_TYPES.length, 18);
});

test("latency and error dimensions collapse to stable bounded buckets", () => {
  assert.equal(assistantLatencyBucket(120), "under_250_ms");
  assert.equal(assistantLatencyBucket(999), "250_to_999_ms");
  assert.equal(assistantLatencyBucket(2_999), "1_to_2_99_s");
  assert.equal(assistantLatencyBucket(7_000), "3_to_9_99_s");
  assert.equal(assistantLatencyBucket(10_000), "10_s_or_more");
  assert.equal(assistantLatencyBucket(null), "unknown");
  assert.equal(
    assistantErrorCategory("ASSISTANT_RATE_LIMITED"),
    "rate_limit",
  );
  assert.equal(
    assistantErrorCategory("ASSISTANT_RESPONSE_INVALID"),
    "validation",
  );
  assert.equal(
    assistantErrorCategory("secret dependency detail"),
    "internal",
  );
});

test("analytics application is flag-gated, idempotent, and available during provider kill", async () => {
  const original = { ...process.env };
  const calls = [];
  process.env.AI_ENVIRONMENT = "test";
  process.env.AI_ASSISTANT_ENABLED = "true";
  process.env.AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS = "";
  process.env.AI_ASSISTANT_KILL_SWITCH = "true";
  process.env.AI_ASSISTANT_ANALYTICS_ENABLED = "true";
  try {
    const application = createPlatformAssistantApplication({
      recordProductEvent: async (input) => {
        calls.push(input);
        return { created: true };
      },
    });
    const result = await application.recordProductEvent(
      {
        organizationMongoId,
        actorUserMongoId,
        correlationId: uuid,
      },
      parseAssistantClientProductEvent({
        eventType: "assistant_opened",
        sessionId: uuid,
        routeCategory: "dashboard",
      }),
      "assistant-event:test",
    );
    assert.deepEqual(result, { created: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].idempotencyKey, "assistant-event:test");
    assert.equal(calls[0].eventType, "assistant_opened");
  } finally {
    process.env = original;
  }
});

test("migration is tenant isolated and excludes direct resource and content identifiers", () => {
  const migration = read(
    "migrations/postgres/040_assistant_product_analytics.up.sql",
  );
  assert.match(migration, /CREATE TABLE rfpilot\.assistant_product_events/);
  assert.match(migration, /actor_pseudonym char\(16\)/);
  assert.match(migration, /session_key char\(32\)/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /tenant_assistant_product_events/);
  assert.match(migration, /input_tokens integer/);
  assert.match(migration, /estimated_cost_micros bigint/);
  for (const prohibited of [
    "raw_prompt",
    "raw_response",
    "provider_payload",
    "chain_of_thought",
    "phone",
    "proposal_text",
    "client_identifier",
    "thread_id uuid",
    "message_id uuid",
    "actor_external_user_id",
  ]) {
    assert.equal(migration.includes(prohibited), false, prohibited);
  }
});

test("repository revalidates ownership, pseudonymizes sessions, and stores allowlisted metadata", () => {
  const source = read(
    "src/modules/platformAssistant/postgresAssistantRepository.ts",
  );
  const analytics = source.slice(source.indexOf("recordProductEvent(input)"));
  assert.match(analytics, /await ownedThread/);
  assert.match(analytics, /t\.owner_external_user_id=\$4/);
  assert.match(analytics, /analyticsPseudonym/);
  assert.match(analytics, /assistantErrorCategory/);
  assert.match(analytics, /assistantLatencyBucket/);
  assert.match(analytics, /assistantModelPrice/);
  assert.match(analytics, /ON CONFLICT/);
  assert.match(analytics, /input_checksum/);
  assert.doesNotMatch(analytics, /SELECT m\.\*/);
  const insertColumns = analytics.match(
    /INSERT INTO rfpilot\.assistant_product_events\(([\s\S]*?)\)\s+VALUES/,
  )?.[1] ?? "";
  assert.doesNotMatch(
    insertColumns,
    /content|raw_prompt|raw_response|provider_payload|thread_id|message_id|actor_external_user_id/,
  );
});

test("server lifecycle records submission, first token, completion, failure, retry, and feedback", () => {
  const streaming = read(
    "src/modules/platformAssistant/streamingApplication.ts",
  );
  const application = read(
    "src/modules/platformAssistant/application.ts",
  );
  for (const event of [
    "message_submitted",
    "first_token_received",
    "response_completed",
    "response_failed",
  ]) {
    assert.match(streaming, new RegExp(`eventType: \"${event}\"`));
  }
  assert.match(application, /eventType: "feedback_submitted"/);
  assert.match(application, /Product analytics is non-authoritative/);
});

test("analytics endpoint requires authentication and assistant permission", () => {
  const route = read("routes/platformAssistantRoute.ts");
  const controller = read("controller/platformAssistantController.ts");
  assert.match(
    route,
    /"\/assistant\/analytics\/events",[\s\S]{0,180}authenticate,[\s\S]{0,180}authorizeAction\("assistant:use"\)/,
  );
  assert.match(controller, /parseAssistantClientProductEvent/);
  assert.match(controller, /idempotencyKey\(req\)/);
  assert.match(controller, /assistant-analytics-session-id/);
});

test("resolved-session definition is explicit and never infers success from silence", () => {
  const architecture = read("docs/architecture/PLATFORM_ASSISTANT.md");
  assert.match(architecture, /### Resolved-session metric/);
  assert.match(architecture, /at\s+least one `message_submitted`/);
  assert.match(architecture, /at\s+least one `response_completed`/);
  assert.match(architecture, /does not infer success from silence/);
  assert.match(architecture, /Cost per resolved\s+session/);
});
