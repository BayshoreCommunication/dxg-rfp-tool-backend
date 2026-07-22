import { aiRuntimeAuthorized } from "../../../config/aiEnvironment";

export class ConversationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}

export const conversationsEnabled = () => aiRuntimeAuthorized() && process.env.CONVERSATIONS_ENABLED === "true";

export const MESSAGE_INTENTS = ["chat", "extract_requirements", "generate_draft"] as const;
export type MessageIntent = (typeof MESSAGE_INTENTS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MessageInput = {
  content: string;
  intent: MessageIntent;
  sourceIds: string[];
  expectedProposalVersion: number | null;
};

export const parseMessageInput = (value: Record<string, unknown>): MessageInput => {
  const content = typeof value.content === "string" ? value.content.trim() : "";
  const intent = String(value.intent || "chat") as MessageIntent;
  if (!MESSAGE_INTENTS.includes(intent))
    throw new ConversationError("INVALID_MESSAGE_INTENT", "Message intent is not supported.", 422);
  if (content.length > 8000)
    throw new ConversationError("INVALID_MESSAGE_CONTENT", "Message content exceeds 8000 characters.", 422);
  if (!content && intent === "chat")
    throw new ConversationError("INVALID_MESSAGE_CONTENT", "Message content is required.", 422);
  const raw = Array.isArray(value.sourceIds) ? value.sourceIds.map(String) : [];
  const sourceIds = [...new Set(raw)];
  if (sourceIds.length > 5 || sourceIds.some((id) => !UUID.test(id)))
    throw new ConversationError("INVALID_MESSAGE_SOURCES", "Select up to five valid sources.", 422);
  if (intent === "extract_requirements" && !sourceIds.length)
    throw new ConversationError("INVALID_MESSAGE_SOURCES", "Requirement extraction needs at least one ready source.", 422);
  const expectedProposalVersion = value.expectedProposalVersion === undefined || value.expectedProposalVersion === null
    ? null
    : Number(value.expectedProposalVersion);
  if (expectedProposalVersion !== null && (!Number.isInteger(expectedProposalVersion) || expectedProposalVersion < 1))
    throw new ConversationError("INVALID_PROPOSAL_VERSION", "Expected proposal version is invalid.", 422);
  if (intent === "generate_draft" && expectedProposalVersion === null)
    throw new ConversationError("INVALID_PROPOSAL_VERSION", "Draft generation requires the expected proposal version.", 422);
  return { content, intent, sourceIds, expectedProposalVersion };
};

export const parseQuestionUpdate = (value: Record<string, unknown>) => {
  const status = String(value.status || "");
  if (!["answered", "dismissed"].includes(status))
    throw new ConversationError("INVALID_QUESTION_STATUS", "Question status must be answered or dismissed.", 422);
  const answer = typeof value.answer === "string" ? value.answer.trim() : "";
  if (answer.length > 4000)
    throw new ConversationError("INVALID_QUESTION_ANSWER", "Answer exceeds 4000 characters.", 422);
  if (status === "answered" && !answer)
    throw new ConversationError("INVALID_QUESTION_ANSWER", "An answer is required to mark a question answered.", 422);
  return { status: status as "answered" | "dismissed", answer };
};

// Ordered whitelist of high-impact fields the assistant proactively asks about
// when extraction reports a broad "missing fields" issue. Each path MUST be an
// approved candidate path from canonicalMapping.approvedCandidatePaths so an
// answer can be written straight into the proposal. Order is priority order.
export type ImportantFieldImpact = "schedule" | "cost" | "production" | "scope";
export type ImportantFieldQuestion = { path: string; prompt: string; impact: ImportantFieldImpact };
export const IMPORTANT_FIELD_QUESTIONS: readonly ImportantFieldQuestion[] = Object.freeze([
  { path: "/content/event/startDate", prompt: "When does the event start? (YYYY-MM-DD)", impact: "schedule" },
  { path: "/content/event/endDate", prompt: "When does the event end? (YYYY-MM-DD)", impact: "schedule" },
  { path: "/content/event/eventFormat", prompt: "Is the event in-person, hybrid, or virtual?", impact: "scope" },
  { path: "/content/venueSchedule/numberOfEventRooms", prompt: "How many event rooms are required?", impact: "cost" },
  { path: "/content/venueSchedule/isUnionVenue", prompt: "Is the venue a union venue? (yes / no / not sure)", impact: "cost" },
  { path: "/content/budget/proposalSubmissionDueDate", prompt: "When is the proposal due? (YYYY-MM-DD)", impact: "schedule" },
  { path: "/content/hybridVirtual/streamingPlatform", prompt: "Which streaming platform will the event use?", impact: "production" },
  { path: "/content/videoRecordingStep/videoRecordingRequired", prompt: "Do you need video recording? (yes / no / not sure)", impact: "production" },
  { path: "/content/venue/riggingRequired", prompt: "Does the venue require rigging? (yes / no / not sure)", impact: "cost" },
  { path: "/content/venue/powerDropsRequired", prompt: "Are power drops required? (yes / no / not sure)", impact: "cost" },
]);

export const importantFieldQuestionByPath = (path: string): ImportantFieldQuestion | null =>
  IMPORTANT_FIELD_QUESTIONS.find((field) => field.path === path) ?? null;

// A catch-all extraction issue (e.g. "missing supported fields" listing dozens
// of canonical paths) is never shown as one giant card: it is exploded into
// individual whitelist questions instead.
export const CATCH_ALL_PATH_THRESHOLD = 8;
export const isCatchAllIssue = (code: string, paths: string[]): boolean =>
  paths.length > CATCH_ALL_PATH_THRESHOLD || /missing[_-]?(supported[_-]?)?fields/i.test(code);

export const MAX_OPEN_FIELD_QUESTIONS = 5;

// Deterministic per-field issue code so the (proposal, run, issue_code) unique
// key deduplicates exploded questions. Clamped to the 100-char column limit.
export const fieldQuestionCode = (path: string): string => `MISSING_FIELD:${path}`.slice(0, 100);

// Impact tag surfaced to the UI ("affects cost") for single-field questions.
export const questionImpact = (paths: string[]): ImportantFieldImpact | null =>
  paths.length === 1 ? importantFieldQuestionByPath(paths[0])?.impact ?? null : null;

// The canonical path an answer should be written to — only when the question
// targets exactly one whitelisted field, so free-form answers stay chat-only.
export const answerTargetPath = (paths: string[]): string | null =>
  paths.length === 1 && importantFieldQuestionByPath(paths[0]) ? paths[0] : null;

// Plain-language prompts for machine issue codes shown as clarification cards.
const QUESTION_PROMPTS: Record<string, string> = {
  MISSING_EVENT_OVERVIEW: "What is this event about? A name and a short overview unlock the rest of the draft.",
  MISSING_EVENT_OBJECTIVES: "What are the objectives of this event?",
  MISSING_EVENT_DATES: "When does the event take place?",
  MISSING_ROOM_COUNT: "How many event rooms are required?",
  CROSS_SOURCE_CONFLICT: "Your sources disagree on this detail. Which value is correct?",
  PROMPT_INJECTION_IGNORED: "One source contained embedded instructions, which were ignored. Please verify the extracted values.",
};

export const questionPrompt = (code: string, paths: string[]): string => {
  const known = QUESTION_PROMPTS[code];
  if (known) return known.slice(0, 1000);
  const fields = paths.slice(0, 8).map((path) => path.split("/").pop() || path).join(", ");
  const readable = code.toLowerCase().replace(/_/g, " ");
  // The clarification_questions table enforces char_length(prompt) <= 1000.
  return (fields ? `Please review: ${readable} (${fields}).` : `Please review: ${readable}.`).slice(0, 1000);
};

export const runStatusMessage = (runType: "proposal_context" | "proposal_draft", status: string): string => {
  if (runType === "proposal_context") {
    if (status === "succeeded") return "I reviewed your sources and extracted the requirements below.";
    if (status === "failed") return "Requirement extraction failed. You can try again.";
    if (status === "conflict") return "The proposal changed while I was reading it. Please retry the extraction.";
    return "Reading your sources and extracting requirements…";
  }
  if (status === "succeeded") return "Here is a cited draft based on the current proposal information.";
  if (status === "failed") return "Draft generation failed. You can try again.";
  if (status === "conflict") return "The proposal changed while drafting. Please regenerate the draft.";
  return "Writing a cited draft from the current proposal information…";
};
