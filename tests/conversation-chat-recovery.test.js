const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("the built-in starter brief closes into extraction immediately", () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    AI_ENVIRONMENT: process.env.AI_ENVIRONMENT,
    CONVERSATION_EXTRACTION_ENABLED: process.env.CONVERSATION_EXTRACTION_ENABLED,
  };
  process.env.NODE_ENV = "test";
  process.env.AI_ENVIRONMENT = "test";
  process.env.CONVERSATION_EXTRACTION_ENABLED = "true";
  try {
    delete require.cache[require.resolve("../src/modules/conversations/segmentation")];
    const { evaluateSegment } = require("../src/modules/conversations/segmentation");
    const content = "Sales kickoff in Dallas, March 10–12, 2027, about 500 guests. One general session plus six breakouts. We need audio, projection, stage lighting, and a recording of the main stage.";
    const decision = evaluateSegment({
      turns: [{ id: "starter-message", content, createdAt: new Date("2026-09-13T08:00:00.000Z") }],
      now: new Date("2026-09-13T08:00:00.000Z"),
    });
    assert.equal(decision.extract, true);
    assert.equal(decision.reason, "rich_turn");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("an exhausted temporary chat-provider failure uses a deterministic reply", () => {
  const worker = fs.readFileSync(
    path.join(root, "src/modules/durableJobs/worker.ts"),
    "utf8",
  );
  assert.match(worker, /code === "LIVE_AI_PROVIDER_TEMPORARY"/);
  assert.match(worker, /CHAT_PROVIDER_UNAVAILABLE_REPLY/);
  assert.match(worker, /conversationRepository\.completeChatJob/);
  assert.match(worker, /conversation_chat_degraded/);
  assert.match(worker, /retryable && !chatFallbackCompleted/);
  const reply = fs.readFileSync(
    path.join(root, "src/modules/conversations/chatReply.ts"),
    "utf8",
  );
  assert.match(reply, /your message is still available in this conversation/);
  assert.doesNotMatch(reply, /CHAT_PROVIDER_UNAVAILABLE_REPLY[^\n]+(?:saved|extracted|filled in automatically)/i);
});
