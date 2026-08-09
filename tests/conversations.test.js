const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const {
  parseMessageInput,
  parseQuestionUpdate,
  questionAnswerText,
  questionPrompt,
  runStatusMessage,
  conversationsEnabled,
  ConversationError,
  IMPORTANT_FIELD_QUESTIONS,
  MAX_ADAPTIVE_VENUE_QUESTIONS,
  MAX_OPEN_FIELD_QUESTIONS,
  isSelectedVenueName,
  venueNeedsOperationalFollowUp,
  isCatchAllIssue,
  fieldQuestionCode,
  questionImpact,
  questionAnswerType,
  importantFieldPaths,
  ANSWER_TYPES,
  answerTargetPath,
  answerTargetPaths,
  isLoadInAfterShow,
  asksForRoomScheduleHelp,
  parseAssistantActions,
} = require("../src/modules/conversations/domain");
const { approvedCandidatePaths, normalizeCandidate } = require("../src/modules/candidateApplication/canonicalMapping");
const { resolveVenueLocation } = require("../src/modules/conversations/venueLocationResolver");

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

test("room schedule help selects only allowlisted assistant actions", () => {
  assert.equal(asksForRoomScheduleHelp("Can I upload an Excel room schedule?"), true);
  assert.equal(asksForRoomScheduleHelp("Tell me about the event schedule"), false);
  // Naming the feature without a spreadsheet word used to fall through to the
  // generic acknowledgement, which is how planners actually phrase the ask.
  assert.equal(asksForRoomScheduleHelp("Can you help me set up the room schedule?"), true);
  assert.equal(asksForRoomScheduleHelp("How do I fill in the room by room?"), true);
  assert.equal(asksForRoomScheduleHelp("I need to import my schedule template"), true);
  assert.equal(asksForRoomScheduleHelp("What time does the room open?"), false);
  assert.deepEqual(
    parseAssistantActions(["download_room_schedule_template", "delete_proposal", "open_room_specifications"]),
    ["download_room_schedule_template", "open_room_specifications"],
  );
});

test("question updates require an answer only when marking answered", () => {
  assert.deepEqual(parseQuestionUpdate({ status: "dismissed" }), { status: "dismissed", answer: "" });
  assert.deepEqual(parseQuestionUpdate({ status: "answered", answer: "300 guests" }), { status: "answered", answer: "300 guests" });
  assert.deepEqual(parseQuestionUpdate({ status: "answered", answer: { date: "2026-09-01", time: "07:30" } }), {
    status: "answered",
    answer: { date: "2026-09-01", time: "07:30" },
  });
  assert.equal(questionAnswerText({ date: "2026-09-01", time: "07:30" }), "2026-09-01 at 07:30");
  assert.throws(() => parseQuestionUpdate({ status: "answered", answer: { date: "2026-09-01" } }), ConversationError);
  assert.throws(() => parseQuestionUpdate({ status: "answered", answer: { time: "07:30" } }), ConversationError);
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

test("combined load-in answers cannot fall after show start", () => {
  assert.equal(isLoadInAfterShow({ loadInDate: "2026-09-01", loadInTime: "07:30", showDate: "2026-09-02", showTime: "09:00" }), false);
  assert.equal(isLoadInAfterShow({ loadInDate: "2026-09-02", loadInTime: "07:30", showDate: "2026-09-02", showTime: "09:00" }), false);
  assert.equal(isLoadInAfterShow({ loadInDate: "2026-09-02", loadInTime: "09:30", showDate: "2026-09-02", showTime: "09:00" }), true);
  assert.equal(isLoadInAfterShow({ loadInDate: "2026-09-03", loadInTime: "07:30", showDate: "2026-09-02" }), true);
});

test("important-field whitelist only contains approved candidate paths with plain prompts", () => {
  assert.ok(IMPORTANT_FIELD_QUESTIONS.length >= 8);
  const seen = new Set();
  for (const field of IMPORTANT_FIELD_QUESTIONS) {
    for (const fieldPath of importantFieldPaths(field)) {
      assert.ok(approvedCandidatePaths.includes(fieldPath), `${fieldPath} must be an approved candidate path`);
      assert.ok(!seen.has(fieldPath), `${fieldPath} listed twice`);
      seen.add(fieldPath);
    }
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

test("the opening question set covers attendance, the biggest cost driver", () => {
  const opening = IMPORTANT_FIELD_QUESTIONS.slice(0, MAX_OPEN_FIELD_QUESTIONS).map((field) => field.path);
  // Attendance used to rank below venue state — which the city answer fills in
  // automatically — and so fell outside the cap and was never asked at all.
  assert.ok(opening.includes("/content/event/attendees"), "attendance must be asked before the first draft");
  assert.ok(opening.includes("/content/event/eventName"));
  assert.ok(opening.includes("/content/event/startDate"));
  assert.ok(opening.includes("/content/event/endDate"));
  assert.ok(opening.includes("/content/venueSchedule/venueCity"));
});

test("guided intake asks event type using the editor's supported choices", () => {
  const question = IMPORTANT_FIELD_QUESTIONS.find((item) => item.path === "/content/event/eventType/eventType");
  assert.ok(question);
  assert.equal(question.answerType, "choice");
  assert.ok(question.options.includes("Corporate Conference"));
  assert.ok(question.options.includes("Hybrid Broadcast / Studio Production"));
  assert.ok(question.options.includes("Other"));
  assert.ok(IMPORTANT_FIELD_QUESTIONS.indexOf(question) < MAX_OPEN_FIELD_QUESTIONS);
});

test("catch-all detection targets broad missing-field issues, not small conflicts", () => {
  const manyPaths = Array.from({ length: 12 }, (_, i) => `/content/event/field${i}`);
  assert.equal(isCatchAllIssue("SOME_ISSUE", manyPaths), true, "more than 8 paths explodes");
  assert.equal(isCatchAllIssue("MISSING_SUPPORTED_FIELDS", ["/content/event/startDate"]), true);
  assert.equal(isCatchAllIssue("MISSING_FIELDS", []), true);
  assert.equal(isCatchAllIssue("missing-fields", []), true);
  assert.equal(isCatchAllIssue("CROSS_SOURCE_CONFLICT", ["/content/event/startDate"]), false);
  assert.equal(isCatchAllIssue("MISSING_ROOM_COUNT", ["/content/venueSchedule/numberOfEventRooms"]), false);
  assert.equal(MAX_OPEN_FIELD_QUESTIONS, 8);
  assert.ok(IMPORTANT_FIELD_QUESTIONS.slice(0, MAX_OPEN_FIELD_QUESTIONS).some((field) => field.path === "/content/venueSchedule/venueName"));
  const venueQuestion = IMPORTANT_FIELD_QUESTIONS.find((field) => field.path === "/content/venueSchedule/venueName");
  assert.match(venueQuestion.prompt, /use Skip/i);
  assert.doesNotMatch(venueQuestion.prompt, /Not selected/i);
  const stateIndex = IMPORTANT_FIELD_QUESTIONS.findIndex((field) => field.path === "/content/venueSchedule/venueState");
  const cityIndex = IMPORTANT_FIELD_QUESTIONS.findIndex((field) => field.path === "/content/venueSchedule/venueCity");
  assert.ok(cityIndex >= 0 && cityIndex < stateIndex, "city is asked before the state fallback");
  const venueType = IMPORTANT_FIELD_QUESTIONS.find((field) => field.path === "/content/venueSchedule/venueType");
  assert.equal(venueType.answerType, "choice");
  assert.ok(venueType.options.includes("Convention Center"));
});

test("city answers derive state and time zone without guessing ambiguous names", () => {
  assert.deepEqual(resolveVenueLocation("Chicago"), {
    city: "Chicago",
    state: "IL",
    timeZone: "Central Time (CT)",
  });
  assert.deepEqual(resolveVenueLocation("Portland, Oregon"), {
    city: "Portland",
    state: "OR",
    timeZone: "Pacific Time (PT)",
  });
  assert.deepEqual(resolveVenueLocation("Washington, DC"), {
    city: "Washington",
    state: "DC",
    timeZone: "Eastern Time (ET)",
  });
  assert.equal(resolveVenueLocation("Portland"), null);
  assert.equal(resolveVenueLocation("Springfield"), null);
  assert.deepEqual(resolveVenueLocation("Paris, France"), {
    city: "Paris",
    state: "OTHER",
    timeZone: "Other / International",
  });
  assert.equal(resolveVenueLocation("Chicago, ZZ"), null);
});

test("venue follow-up questions activate only for a selected venue", () => {
  assert.equal(MAX_ADAPTIVE_VENUE_QUESTIONS, 19);
  assert.equal(isSelectedVenueName("Hyatt Regency Chicago"), true);
  for (const deferred of ["", "Not selected", "TBD", "undecided", "unknown", "N/A"])
    assert.equal(isSelectedVenueName(deferred), false, deferred);
  assert.equal(venueNeedsOperationalFollowUp("Hyatt Regency Chicago", undefined), true);
  assert.equal(venueNeedsOperationalFollowUp("Hyatt Regency Chicago", "CONTRACT_SIGNED"), true);
  assert.equal(venueNeedsOperationalFollowUp("Hyatt Regency Chicago", "NOT_SELECTED"), false);
  const adaptivePaths = IMPORTANT_FIELD_QUESTIONS
    .slice(MAX_OPEN_FIELD_QUESTIONS, MAX_ADAPTIVE_VENUE_QUESTIONS)
    .flatMap(importantFieldPaths);
  for (const path of [
    "/content/venueSchedule/venueConfirmedStatus",
    "/content/venueSchedule/isUnionVenue",
    "/content/venue/inHouseAvRequired",
    "/content/venue/riggingRequired",
    "/content/venue/powerDropsRequired",
    "/content/venueSchedule/loadInDate",
    "/content/venueSchedule/loadInTime",
    "/content/venue/venueAccessRequirements",
  ]) assert.ok(adaptivePaths.includes(path), path);
});

test("answer targeting and impact tags only apply to single whitelisted-field questions", () => {
  assert.equal(answerTargetPath(["/content/venueSchedule/numberOfEventRooms"]), "/content/venueSchedule/numberOfEventRooms");
  assert.equal(answerTargetPath(["/content/event/startDate", "/content/event/endDate"]), null);
  assert.deepEqual(answerTargetPaths([
    "/content/venueSchedule/loadInDate",
    "/content/venueSchedule/loadInTime",
  ]), [
    "/content/venueSchedule/loadInDate",
    "/content/venueSchedule/loadInTime",
  ]);
  assert.deepEqual(answerTargetPaths(["/content/event/startDate", "/content/event/endDate"]), []);
  // Any applicable path is writable, not just the 14 the assistant asks
  // proactively. eventTheme is on the candidate whitelist but not in that list,
  // and used to return null — so a CROSS_SOURCE_CONFLICT naming it could be
  // answered and nothing was ever written. The write guard is normalizeCandidate,
  // not membership of the proactive question set.
  assert.ok(approvedCandidatePaths.includes("/content/event/eventTheme"));
  assert.equal(answerTargetPath(["/content/event/eventTheme"]), "/content/event/eventTheme");
  // Genuinely unmappable paths still stay chat-only.
  assert.equal(answerTargetPath(["/content/event/notARealField"]), null);
  assert.equal(answerTargetPath(["/content/roomByRoom/0/audio"]), null, "array paths are not applicable");
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
  const byPath = Object.fromEntries(IMPORTANT_FIELD_QUESTIONS.flatMap((field) =>
    importantFieldPaths(field).map((fieldPath) => [fieldPath, field.answerType])));
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
  assert.equal(byPath["/content/venueSchedule/loadInDate"], "date_time");
  assert.equal(byPath["/content/venueSchedule/loadInTime"], "date_time");
  const loadInQuestions = IMPORTANT_FIELD_QUESTIONS.filter((field) =>
    importantFieldPaths(field).some((fieldPath) => fieldPath.includes("/loadIn")));
  assert.equal(loadInQuestions.length, 1);
  assert.equal(loadInQuestions[0].prompt, "What date and time can production load-in?");
  assert.deepEqual(importantFieldPaths(loadInQuestions[0]), [
    "/content/venueSchedule/loadInDate",
    "/content/venueSchedule/loadInTime",
  ]);
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
  assert.deepEqual(questionAnswerType([
    "/content/venueSchedule/loadInDate",
    "/content/venueSchedule/loadInTime",
  ]), { answerType: "date_time" });
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

test("the conversation endpoint exposes runtime chat-extraction capability", () => {
  const controller = fs.readFileSync(path.join(root, "controller/conversationsController.ts"), "utf8");
  assert.ok(controller.includes("conversationExtractionEnabled"));
  assert.ok(controller.includes("capabilities: { conversationExtraction:"));
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
  assert.ok(controller.includes("applyAnswersToProposalFields"), "controller must write typed answers into the proposal");
  assert.ok(controller.indexOf("applyAnswersToProposalFields") < controller.indexOf("updateQuestion"), "field writes must precede resolving the question so invalid values re-ask");
  assert.ok(controller.includes("appendRoomScheduleSuggestionWhenReady"), "finishing guided intake must offer the room schedule workflow");
  const writer = fs.readFileSync(path.join(root, "src/modules/conversations/answerFieldWriter.ts"), "utf8");
  for (const guard of ["normalizeCandidate", "status: \"unsubmitted\"", "isDraft: true", "$ifNull: [\"$version\", 1]", "$cond", "$eq"])
    assert.ok(writer.includes(guard), guard);
  for (const locationBehavior of ["resolveVenueLocation", "venueSchedule.venueState", "venueSchedule.timeZone", "...derivedSet"])
    assert.ok(writer.includes(locationBehavior), locationBehavior);
  for (const recoveryGuard of ["supersededByThisAnswer", "appliedPaths.every((path) => row.canonical_paths.includes(path))"])
    assert.ok(repository.includes(recoveryGuard), recoveryGuard);
  for (const compositeGuard of ["applyAnswersToProposalFields", "questionAnswerText", "appliedFields"])
    assert.ok(controller.includes(compositeGuard), compositeGuard);
  for (const delayedSuggestionGuard of ["questions_open", "already_suggested", "actions @>", "ROOM_SCHEDULE_GUIDANCE_MESSAGE"])
    assert.ok(repository.includes(delayedSuggestionGuard), delayedSuggestionGuard);
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

test("plain chat replies are accepted into the durable job pipeline", () => {
  const repository = fs.readFileSync(path.join(root, "src/modules/conversations/postgresConversationRepository.ts"), "utf8");
  const controller = fs.readFileSync(path.join(root, "controller/conversationsController.ts"), "utf8");
  const worker = fs.readFileSync(path.join(root, "src/modules/durableJobs/worker.ts"), "utf8");
  const handler = fs.readFileSync(path.join(root, "src/modules/durableJobs/conversationChatHandler.ts"), "utf8");
  const jobDomain = fs.readFileSync(path.join(root, "src/modules/durableJobs/domain.ts"), "utf8");

  // The user turn, pending assistant placeholder, job row, and outbox event
  // share one Postgres transaction. The generation/job ID therefore exists
  // before a provider can be called, and Redis remains recoverable transport.
  for (const value of [
    "'conversation_chat','queued'",
    "conversation-chat.v1",
    "INSERT INTO rfpilot.outbox_events",
    "job.queued",
    'status: "pending"',
    "jobId = uuidv7()",
  ])
    assert.ok(repository.includes(value), value);
  assert.ok(repository.indexOf("jobId = uuidv7()") < repository.indexOf("INSERT INTO rfpilot.ai_jobs"));

  // HTTP acceptance is bounded; neither the model nor segment extraction can
  // keep the request open. Duplicate sends retain the same persisted job.
  assert.ok(controller.includes('input.intent === "chat" && exchange.created'));
  assert.ok(controller.includes("durableJobDispatcher.dispatch()"));
  assert.ok(controller.includes("res.status(status)"));
  assert.ok(controller.includes("? 202"));
  assert.ok(controller.includes("void maybeExtractSegment"));
  assert.ok(!controller.includes("appendChatReply"));
  assert.ok(repository.includes("assistantMessageId: assistant.rows[0]?.id"));
  assert.ok(repository.includes("jobId: assistant.rows[0]?.job_id"));

  // The durable worker reloads authoritative state, writes into the existing
  // placeholder, and materializes a visible failure after retry exhaustion.
  assert.ok(jobDomain.includes('"conversation_chat"'));
  for (const value of ["handleConversationChat", '"conversation_chat"', "failChatJob", "UNSUPPORTED_JOB_TYPE"])
    assert.ok(worker.includes(value), value);
  for (const value of ["readChatJob", "buildChatReply", "completeChatJob", "message.jobId"])
    assert.ok(handler.includes(value), value);
  for (const value of ["materializeChatJobs", "dead_letter", "conversation_chat_failed"])
    assert.ok(repository.includes(value), value);
});

test("key questions are generated from empty high-impact fields, with no run required", () => {
  const source = fs.readFileSync(path.join(root, "src/modules/conversations/fieldGapQuestions.ts"), "utf8");
  // A proposal started by conversation alone must still be asked what matters.
  assert.ok(source.includes("context_run_id"), "field-gap questions attach to no run");
  assert.ok(source.includes("NULL,$5,'question'"), "the run reference must be inserted as NULL");
  assert.ok(source.includes("MAX_OPEN_FIELD_QUESTIONS"), "open questions stay capped");
  assert.ok(source.includes("status='superseded'"), "a field that gets filled retires its question");
  assert.ok(source.includes("untitled proposal"), "the creation placeholder counts as empty");
  assert.ok(source.includes("importantFieldPaths"), "composite questions evaluate and persist every canonical path");
  assert.ok(source.includes("WHERE NOT EXISTS"), "field-gap sync must not duplicate an open extraction question");
  const repository = fs.readFileSync(path.join(root, "src/modules/conversations/postgresConversationRepository.ts"), "utf8");
  assert.ok(repository.includes('field.answerType === "date_time"'), "specific load-in issues must also become one composite question");
  assert.equal((repository.match(/syncFieldGapQuestions\(/g) || []).length, 2, "wired into both read and snapshot");
  const migration = fs.readFileSync(path.join(root, "migrations/postgres/025_field_gap_questions.up.sql"), "utf8");
  assert.ok(migration.includes("ALTER COLUMN context_run_id DROP NOT NULL"));
  assert.ok(migration.includes("WHERE context_run_id IS NULL"), "field-gap questions dedupe on a partial unique index");
});

test("the assistant never claims to be extracting when there are no sources", () => {
  const operations = fs.readFileSync(path.join(root, "src/modules/liveAi/operations.ts"), "utf8");
  assert.ok(operations.includes("When there are NO sources, never claim to be reading, extracting or processing anything"));
  assert.ok(operations.includes("never say that you recorded, captured, saved, added, or applied its details to the proposal"));
  assert.ok(operations.includes("persistenceClaim"));
});

test("deterministic chat fallbacks welcome the planner without false persistence claims", () => {
  const replySource = fs.readFileSync(path.join(root, "src/modules/conversations/chatReply.ts"), "utf8");
  assert.match(replySource, /I’ll help you build this proposal/);
  assert.match(replySource, /Answer the first question below/);
  assert.doesNotMatch(replySource, /I've saved that to this proposal/);
  assert.doesNotMatch(replySource, /I’ve saved that to this proposal/);
});

test("source extraction explicitly preserves discrete high-value facts embedded in prose", () => {
  const operations = fs.readFileSync(path.join(root, "src/modules/liveAi/operations.ts"), "utf8");
  for (const field of [
    "in-person attendee count",
    "virtual attendee count",
    "event-room count",
    "proposal response deadline",
    "stated budget tier",
  ])
    assert.ok(operations.includes(field), field);
});

test("suggested answers convert extraction candidates into submittable answer strings", () => {
  const { suggestedAnswerFor } = require("../src/modules/conversations/domain");
  // Typed fields pass their canonical form straight through.
  assert.equal(suggestedAnswerFor(["/content/event/startDate"], "2026-10-15"), "2026-10-15");
  assert.equal(suggestedAnswerFor(["/content/event/attendees"], 300), "300");
  assert.equal(suggestedAnswerFor(["/content/event/attendees"], "300"), "300");
  assert.equal(suggestedAnswerFor(["/content/event/eventName"], "  DEMO Town Hall  "), "DEMO Town Hall");
  // Choice questions must suggest one of their own options, mapped from the
  // candidate's canonical/boolean form ("in_person" -> "In-Person").
  assert.equal(suggestedAnswerFor(["/content/event/eventFormat"], "in_person"), "In-Person");
  assert.equal(suggestedAnswerFor(["/content/venueSchedule/isUnionVenue"], true), "Yes");
  assert.equal(suggestedAnswerFor(["/content/venueSchedule/isUnionVenue"], "no"), "No");
  assert.equal(suggestedAnswerFor(["/content/venue/riggingRequired"], "not_sure"), "Not sure");
  assert.equal(
    suggestedAnswerFor(["/content/hybridVirtual/streamingPlatform"], "vendor recommendation needed"),
    "Vendor Recommendation Needed",
  );
});

test("suggested answers refuse anything the answer flow could not accept", () => {
  const { suggestedAnswerFor } = require("../src/modules/conversations/domain");
  // A prefill the confirm step would 422 on is worse than none.
  assert.equal(suggestedAnswerFor(["/content/event/startDate"], "October 15, 2026"), null);
  assert.equal(suggestedAnswerFor(["/content/event/attendees"], "around three hundred"), null);
  // A choice value matching none of the offered pills cannot be submitted.
  assert.equal(suggestedAnswerFor(["/content/hybridVirtual/streamingPlatform"], "Twitch Prime Special"), null);
  // Unknown paths, multi-path and empty questions never get suggestions.
  assert.equal(suggestedAnswerFor(["/content/not/a/path"], "x"), null);
  assert.equal(suggestedAnswerFor(["/content/event/startDate", "/content/event/endDate"], "2026-10-15"), null);
  assert.equal(suggestedAnswerFor([], "x"), null);
});

test("every non-null suggestion round-trips through the candidate normalizer", () => {
  const { suggestedAnswerFor } = require("../src/modules/conversations/domain");
  const samples = [
    [["/content/event/startDate"], "2026-10-15"],
    [["/content/event/attendees"], 300],
    [["/content/event/eventFormat"], "hybrid"],
    [["/content/venueSchedule/isUnionVenue"], false],
    [["/content/budget/proposalSubmissionDueDate"], "2026-08-20"],
  ];
  for (const [paths, raw] of samples) {
    const suggestion = suggestedAnswerFor(paths, raw);
    assert.ok(suggestion !== null, `${paths[0]} should produce a suggestion`);
    assert.ok(normalizeCandidate(paths[0], suggestion), `${paths[0]} suggestion must re-normalize`);
  }
});

test("the conversation read payload pre-fills open questions from the latest extraction run", () => {
  const repository = fs.readFileSync(path.join(root, "src/modules/conversations/postgresConversationRepository.ts"), "utf8");
  // The suggestion is sourced from the newest succeeded run's operations,
  // keyed by path (field-gap questions carry no run id), and conflict
  // questions are excluded because their candidates disagree by definition.
  for (const value of [
    "suggestedAnswerFor",
    "latestSucceededContextRun(c, proposalRefId)",
    "suggestedAnswer:",
    'q.issue_code !== "CROSS_SOURCE_CONFLICT"',
  ])
    assert.ok(repository.includes(value), value);
});

test("a prose count from live extraction still seeds the number question", () => {
  const { suggestedAnswerFor } = require("../src/modules/conversations/domain");
  // The model sometimes emits "approximately 300 attendees" for a count field;
  // the digits are seeded and the planner confirms or edits them.
  assert.equal(suggestedAnswerFor(["/content/event/attendees"], "approximately 300 attendees"), "300");
  assert.equal(suggestedAnswerFor(["/content/venueSchedule/numberOfEventRooms"], "about 12 rooms"), "12");
  // No digits, still no guess — and non-number fields never get the retry.
  assert.equal(suggestedAnswerFor(["/content/event/attendees"], "several hundred"), null);
  assert.equal(suggestedAnswerFor(["/content/event/startDate"], "week 42 of 2026"), null);
});
