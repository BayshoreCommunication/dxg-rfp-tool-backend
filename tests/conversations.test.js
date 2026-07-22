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
  IMPORTANT_FIELD_QUESTIONS,
  MAX_OPEN_FIELD_QUESTIONS,
  isCatchAllIssue,
  fieldQuestionCode,
  questionImpact,
  answerTargetPath,
} = require("../src/modules/conversations/domain");
const { approvedCandidatePaths, normalizeCandidate } = require("../src/modules/candidateApplication/canonicalMapping");

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

test("important-field whitelist only contains approved candidate paths with plain prompts", () => {
  assert.ok(IMPORTANT_FIELD_QUESTIONS.length >= 8);
  const seen = new Set();
  for (const field of IMPORTANT_FIELD_QUESTIONS) {
    assert.ok(approvedCandidatePaths.includes(field.path), `${field.path} must be an approved candidate path`);
    assert.ok(!seen.has(field.path), `${field.path} listed twice`);
    seen.add(field.path);
    assert.ok(field.prompt.length > 0 && field.prompt.length <= 1000, field.path);
    assert.ok(["schedule", "cost", "production", "scope"].includes(field.impact), field.path);
    assert.ok(fieldQuestionCode(field.path).length <= 100, field.path);
  }
  // Cost drivers and schedule anchors are present.
  for (const path of [
    "/content/event/startDate",
    "/content/event/endDate",
    "/content/venueSchedule/numberOfEventRooms",
    "/content/venueSchedule/isUnionVenue",
    "/content/budget/proposalSubmissionDueDate",
    "/content/venue/riggingRequired",
    "/content/venue/powerDropsRequired",
  ])
    assert.ok(seen.has(path), path);
});

test("catch-all detection targets broad missing-field issues, not small conflicts", () => {
  const manyPaths = Array.from({ length: 12 }, (_, i) => `/content/event/field${i}`);
  assert.equal(isCatchAllIssue("SOME_ISSUE", manyPaths), true, "more than 8 paths explodes");
  assert.equal(isCatchAllIssue("MISSING_SUPPORTED_FIELDS", ["/content/event/startDate"]), true);
  assert.equal(isCatchAllIssue("MISSING_FIELDS", []), true);
  assert.equal(isCatchAllIssue("missing-fields", []), true);
  assert.equal(isCatchAllIssue("CROSS_SOURCE_CONFLICT", ["/content/event/startDate"]), false);
  assert.equal(isCatchAllIssue("MISSING_ROOM_COUNT", ["/content/venueSchedule/numberOfEventRooms"]), false);
  assert.equal(MAX_OPEN_FIELD_QUESTIONS, 5);
});

test("answer targeting and impact tags only apply to single whitelisted-field questions", () => {
  assert.equal(answerTargetPath(["/content/venueSchedule/numberOfEventRooms"]), "/content/venueSchedule/numberOfEventRooms");
  assert.equal(answerTargetPath(["/content/event/startDate", "/content/event/endDate"]), null);
  assert.equal(answerTargetPath(["/content/event/eventName"]), null, "non-whitelisted paths stay chat-only");
  assert.equal(answerTargetPath([]), null);
  assert.equal(questionImpact(["/content/venueSchedule/isUnionVenue"]), "cost");
  assert.equal(questionImpact(["/content/event/startDate"]), "schedule");
  assert.equal(questionImpact(["/content/event/eventName"]), null);
});

test("whitelisted answers normalize through the candidate mapping as human data entry", () => {
  const rooms = normalizeCandidate("/content/venueSchedule/numberOfEventRooms", "6");
  assert.equal(rooms.mongoPath, "venueSchedule.numberOfEventRooms");
  assert.equal(rooms.mongoValue, "6");
  const union = normalizeCandidate("/content/venueSchedule/isUnionVenue", "yes");
  assert.equal(union.mongoValue, "YES");
  const start = normalizeCandidate("/content/event/startDate", "2026-09-01");
  assert.equal(start.mongoValue, "2026-09-01");
  assert.throws(() => normalizeCandidate("/content/event/startDate", "next Tuesday"), /YYYY-MM-DD/);
  assert.throws(() => normalizeCandidate("/content/venueSchedule/numberOfEventRooms", "lots"), /between 1 and 200/);
});

test("catch-all explosion and answer field writing are wired into repository and controller", () => {
  const repository = fs.readFileSync(path.join(root, "src/modules/conversations/postgresConversationRepository.ts"), "utf8");
  // The catch-all card is never inserted: explosion happens before the generic insert.
  assert.ok(repository.includes("isCatchAllIssue"), "repository must detect catch-all issues");
  assert.ok(repository.includes("MISSING_FIELD:"), "repository must count open exploded questions");
  assert.ok(repository.includes("MAX_OPEN_FIELD_QUESTIONS"), "repository must cap open field questions");
  assert.ok(repository.indexOf("isCatchAllIssue(issue.code") < repository.indexOf("insertQuestion(issue.code"), "explosion must be checked before the generic insert");
  const controller = fs.readFileSync(path.join(root, "controller/conversationsController.ts"), "utf8");
  assert.ok(controller.includes("applyAnswerToProposalField"), "controller must write single-field answers into the proposal");
  assert.ok(controller.indexOf("applyAnswerToProposalField") < controller.indexOf("updateQuestion"), "field write must precede resolving the question so invalid values re-ask");
  const writer = fs.readFileSync(path.join(root, "src/modules/conversations/answerFieldWriter.ts"), "utf8");
  for (const guard of ["normalizeCandidate", "status: \"unsubmitted\"", "isDraft: true", "$ifNull: [\"$version\", 1]"])
    assert.ok(writer.includes(guard), guard);
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
