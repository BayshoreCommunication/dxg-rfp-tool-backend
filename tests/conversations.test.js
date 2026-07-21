const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const {
  parseMessageInput,
  parseQuestionUpdate,
  questionPrompt,
  runStatusMessage,
  conversationsEnabled,
  ConversationError,
} = require("../src/modules/conversations/domain");

const root = path.join(__dirname, "..");

test("conversations are gated by environment authorization and flag", () => {
  const saved = { n: process.env.NODE_ENV, f: process.env.CONVERSATIONS_ENABLED, a: process.env.AI_ENVIRONMENT };
  delete process.env.AI_ENVIRONMENT;
  process.env.NODE_ENV = "production";
  process.env.CONVERSATIONS_ENABLED = "true";
  assert.equal(conversationsEnabled(), false);
  process.env.NODE_ENV = "test";
  assert.equal(conversationsEnabled(), true);
  process.env.CONVERSATIONS_ENABLED = "false";
  assert.equal(conversationsEnabled(), false);
  for (const [key, env] of [["NODE_ENV", saved.n], ["CONVERSATIONS_ENABLED", saved.f], ["AI_ENVIRONMENT", saved.a]])
    env === undefined ? delete process.env[key] : (process.env[key] = env);
});

test("message input validation bounds content, intent, sources and version", () => {
  assert.deepEqual(parseMessageInput({ content: " hello ", intent: "chat" }), { content: "hello", intent: "chat", sourceIds: [], expectedProposalVersion: null });
  assert.throws(() => parseMessageInput({ content: "", intent: "chat" }), ConversationError);
  assert.throws(() => parseMessageInput({ content: "x".repeat(8001), intent: "chat" }), ConversationError);
  assert.throws(() => parseMessageInput({ content: "x", intent: "delete_everything" }), ConversationError);
  assert.throws(() => parseMessageInput({ content: "x", intent: "extract_requirements", sourceIds: [] }), ConversationError);
  assert.throws(() => parseMessageInput({ content: "x", intent: "extract_requirements", sourceIds: ["not-a-uuid"] }), ConversationError);
  assert.throws(() => parseMessageInput({ content: "x", intent: "generate_draft" }), ConversationError);
  const uuid = "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e6f";
  const parsed = parseMessageInput({ content: "extract these", intent: "extract_requirements", sourceIds: [uuid, uuid] });
  assert.deepEqual(parsed.sourceIds, [uuid]);
  assert.equal(parseMessageInput({ content: "", intent: "generate_draft", expectedProposalVersion: 3 }).expectedProposalVersion, 3);
});

test("question updates require an answer only when marking answered", () => {
  assert.deepEqual(parseQuestionUpdate({ status: "dismissed" }), { status: "dismissed", answer: "" });
  assert.deepEqual(parseQuestionUpdate({ status: "answered", answer: "300 guests" }), { status: "answered", answer: "300 guests" });
  assert.throws(() => parseQuestionUpdate({ status: "answered" }), ConversationError);
  assert.throws(() => parseQuestionUpdate({ status: "open" }), ConversationError);
  assert.throws(() => parseQuestionUpdate({ status: "answered", answer: "x".repeat(4001) }), ConversationError);
});

test("question prompts are plain language for known and unknown codes", () => {
  assert.match(questionPrompt("MISSING_ROOM_COUNT", []), /how many event rooms/i);
  const fallback = questionPrompt("MISSING_LOAD_IN_TIME", ["/content/venueSchedule/loadInTime"]);
  assert.match(fallback, /missing load in time/);
  assert.match(fallback, /loadInTime/);
});

test("run status narration covers every lifecycle state", () => {
  for (const runType of ["proposal_context", "proposal_draft"])
    for (const status of ["queued", "running", "succeeded", "failed", "conflict"])
      assert.ok(runStatusMessage(runType, status).length > 10, `${runType}:${status}`);
  assert.match(runStatusMessage("proposal_context", "succeeded"), /extracted/i);
  assert.match(runStatusMessage("proposal_draft", "succeeded"), /cited draft/i);
});

test("conversation migration enforces tenancy, ordinals and question lifecycle", () => {
  const up = fs.readFileSync(path.join(root, "migrations/postgres/017_conversations.up.sql"), "utf8");
  for (const value of [
    "rfpilot.conversations",
    "rfpilot.conversation_messages",
    "rfpilot.conversation_message_attachments",
    "rfpilot.clarification_questions",
    "UNIQUE(conversation_id,ordinal)",
    "UNIQUE(proposal_reference_id)",
    "UNIQUE(message_id,source_id)",
    "'open','answered','dismissed','superseded'",
    "conversation_messages_idempotency_idx",
  ])
    assert.ok(up.includes(value), value);
  assert.equal((up.match(/FORCE ROW LEVEL SECURITY/g) || []).length, 4);
  assert.equal((up.match(/current_organization_id\(\)/g) || []).length, 8);
});

test("SSE endpoint and message route are wired with authentication", () => {
  const route = fs.readFileSync(path.join(root, "routes/conversationsRoute.ts"), "utf8");
  for (const value of ["conversation/events", "conversation/messages", "authenticate", "authorizeAction(\"proposal:write\")"])
    assert.ok(route.includes(value), value);
  const controller = fs.readFileSync(path.join(root, "controller/conversationsController.ts"), "utf8");
  assert.ok(controller.includes("text/event-stream"));
  assert.ok(controller.indexOf("appendExchange") > controller.indexOf("proposalContextRepository.create"), "run creation must precede message append");
});
