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
  questionAnswerType,
  ANSWER_TYPES,
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
    "/content/event/attendees",
    "/content/venueSchedule/numberOfEventRooms",
    "/content/venueSchedule/venueCity",
    "/content/venueSchedule/isUnionVenue",
    "/content/venue/inHouseAvRequired",
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
  assert.equal(MAX_OPEN_FIELD_QUESTIONS, 10);
});

test("answer targeting and impact tags only apply to single whitelisted-field questions", () => {
  assert.equal(answerTargetPath(["/content/venueSchedule/numberOfEventRooms"]), "/content/venueSchedule/numberOfEventRooms");
  assert.equal(answerTargetPath(["/content/event/startDate", "/content/event/endDate"]), null);
  assert.equal(answerTargetPath(["/content/event/eventTheme"]), null, "non-whitelisted paths stay chat-only");
  // The event title is asked first, so it targets its field like any other.
  assert.equal(answerTargetPath(["/content/event/eventName"]), "/content/event/eventName");
  assert.equal(answerTargetPath([]), null);
  assert.equal(questionImpact(["/content/venueSchedule/isUnionVenue"]), "cost");
  assert.equal(questionImpact(["/content/event/startDate"]), "schedule");
  assert.equal(questionImpact(["/content/event/eventTheme"]), null);
  assert.equal(questionImpact(["/content/event/eventName"]), "scope");
});

test("every whitelisted question declares an answer control, and only choices carry options", () => {
  for (const field of IMPORTANT_FIELD_QUESTIONS) {
    assert.ok(ANSWER_TYPES.includes(field.answerType), `${field.path} needs a supported answerType`);
    if (field.answerType === "choice") {
      assert.ok(Array.isArray(field.options) && field.options.length >= 2, `${field.path} choice needs options`);
      assert.ok(field.options.every((option) => typeof option === "string" && option.trim()), field.path);
    } else {
      assert.equal(field.options, undefined, `${field.path} must not carry options`);
    }
  }
  // The mapping the dashboard depends on.
  const byPath = Object.fromEntries(IMPORTANT_FIELD_QUESTIONS.map((field) => [field.path, field.answerType]));
  assert.equal(byPath["/content/event/startDate"], "date");
  assert.equal(byPath["/content/event/endDate"], "date");
  assert.equal(byPath["/content/budget/proposalSubmissionDueDate"], "date");
  assert.equal(byPath["/content/event/eventFormat"], "choice");
  assert.equal(byPath["/content/event/attendees"], "number");
  assert.equal(byPath["/content/venueSchedule/isUnionVenue"], "choice");
  assert.equal(byPath["/content/venue/inHouseAvRequired"], "choice");
  assert.equal(byPath["/content/videoRecordingStep/videoRecordingRequired"], "choice");
  assert.equal(byPath["/content/venue/riggingRequired"], "choice");
  assert.equal(byPath["/content/venue/powerDropsRequired"], "choice");
  assert.equal(byPath["/content/hybridVirtual/streamingPlatform"], "choice");
  assert.equal(byPath["/content/venueSchedule/numberOfEventRooms"], "number");
  assert.equal(byPath["/content/venueSchedule/venueCity"], "text");
  // The streaming platform pills must be the same list the wizard step offers.
  const streaming = IMPORTANT_FIELD_QUESTIONS.find((f) => f.path === "/content/hybridVirtual/streamingPlatform");
  assert.deepEqual([...streaming.options], [
    "Client-Owned Platform",
    "Attendee Hub (Cvent)",
    "Zoom Webinar",
    "ON24",
    "Hopin",
    "Webex Events",
    "YouTube Live",
    "Vendor Recommendation Needed",
    "Other",
  ]);
});

test("every choice option round-trips through the candidate normalizer for its own path", () => {
  // A pill the UI shows is submitted verbatim, so it must be a value the
  // proposal writer accepts — otherwise the answer bounces with a 422.
  for (const field of IMPORTANT_FIELD_QUESTIONS.filter((f) => f.answerType === "choice"))
    for (const option of field.options) {
      const normalized = normalizeCandidate(field.path, option);
      assert.equal(normalized.sourcePath, field.path);
      assert.ok(normalized.mongoValue !== undefined, `${field.path} / ${option}`);
    }
  assert.equal(normalizeCandidate("/content/event/eventFormat", "In-Person").mongoValue, "In-Person");
  assert.equal(normalizeCandidate("/content/venue/riggingRequired", "Not sure").mongoValue, "NOT_SURE");
  assert.equal(normalizeCandidate("/content/hybridVirtual/streamingPlatform", "Vendor Recommendation Needed").mongoValue, "Vendor Recommendation Needed");
});

test("answer controls are only typed for single whitelisted-field questions", () => {
  assert.deepEqual(questionAnswerType(["/content/event/startDate"]), { answerType: "date" });
  assert.deepEqual(questionAnswerType(["/content/venueSchedule/numberOfEventRooms"]), { answerType: "number" });
  assert.deepEqual(questionAnswerType(["/content/venueSchedule/isUnionVenue"]), { answerType: "choice", options: ["Yes", "No", "Not sure"] });
  assert.equal(questionAnswerType(["/content/hybridVirtual/streamingPlatform"]).options.length, 9);
  // Non-whitelisted, multi-path and empty questions stay free text.
  assert.deepEqual(questionAnswerType(["/content/event/eventName"]), { answerType: "text" });
  assert.deepEqual(questionAnswerType(["/content/event/startDate", "/content/event/endDate"]), { answerType: "text" });
  assert.deepEqual(questionAnswerType([]), { answerType: "text" });
});

test("the conversation read payload carries the answer control alongside the impact tag", () => {
  const repository = fs.readFileSync(path.join(root, "src/modules/conversations/postgresConversationRepository.ts"), "utf8");
  for (const value of ["questionAnswerType", "answerType,", "options: options ? [...options] : []"])
    assert.ok(repository.includes(value), value);
  // The answer message pairing lets the thread show the question above the answer.
  assert.ok(repository.includes("answeredMessageId: q.answered_message_id ?? null"), "read must expose answeredMessageId");
  assert.ok(/SELECT[^;]*answered_message_id[^;]*FROM rfpilot\.clarification_questions/.test(repository), "the column must be selected");
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
  for (const guard of ["normalizeCandidate", "status: \"unsubmitted\"", "isDraft: true", "$ifNull: [\"$version\", 1]", "$cond", "$eq"])
    assert.ok(writer.includes(guard), guard);
  for (const recoveryGuard of ["supersededByThisAnswer", "row.canonical_paths.includes(ctx.appliedPath)"])
    assert.ok(repository.includes(recoveryGuard), recoveryGuard);
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

test("key questions are generated from empty high-impact fields, with no run required", () => {
  const source = fs.readFileSync(path.join(root, "src/modules/conversations/fieldGapQuestions.ts"), "utf8");
  // A proposal started by conversation alone must still be asked what matters.
  assert.ok(source.includes("context_run_id"), "field-gap questions attach to no run");
  assert.ok(source.includes("NULL,$5,'question'"), "the run reference must be inserted as NULL");
  assert.ok(source.includes("MAX_OPEN_FIELD_QUESTIONS"), "open questions stay capped");
  assert.ok(source.includes("status='superseded'"), "a field that gets filled retires its question");
  assert.ok(source.includes("untitled proposal"), "the creation placeholder counts as empty");
  const repository = fs.readFileSync(path.join(root, "src/modules/conversations/postgresConversationRepository.ts"), "utf8");
  assert.equal((repository.match(/syncFieldGapQuestions\(/g) || []).length, 2, "wired into both read and snapshot");
  const migration = fs.readFileSync(path.join(root, "migrations/postgres/025_field_gap_questions.up.sql"), "utf8");
  assert.ok(migration.includes("ALTER COLUMN context_run_id DROP NOT NULL"));
  assert.ok(migration.includes("WHERE context_run_id IS NULL"), "field-gap questions dedupe on a partial unique index");
});

test("the assistant never claims to be extracting when there are no sources", () => {
  const operations = fs.readFileSync(path.join(root, "src/modules/liveAi/operations.ts"), "utf8");
  assert.ok(operations.includes("When there are NO sources, never claim to be reading, extracting or processing anything"));
});
