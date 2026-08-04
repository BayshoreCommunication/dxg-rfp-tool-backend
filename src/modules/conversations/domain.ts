import { aiRuntimeAuthorized } from "../../../config/aiEnvironment";
import { approvedCandidatePaths } from "../candidateApplication/canonicalMapping";

export class ConversationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}

export const conversationsEnabled = () => aiRuntimeAuthorized() && process.env.CONVERSATIONS_ENABLED === "true";

export const MESSAGE_INTENTS = ["chat", "extract_requirements", "generate_draft"] as const;
export type MessageIntent = (typeof MESSAGE_INTENTS)[number];

export const ASSISTANT_ACTION_IDS = [
  "download_room_schedule_template",
  "open_room_specifications",
] as const;
export type AssistantActionId = (typeof ASSISTANT_ACTION_IDS)[number];
export const ROOM_SCHEDULE_ASSISTANT_ACTIONS: readonly AssistantActionId[] = Object.freeze([
  "download_room_schedule_template",
  "open_room_specifications",
]);
export const ROOM_SCHEDULE_GUIDANCE_MESSAGE =
  "Now that the key event details are covered, you can add room specifications. If you have a room schedule, download the sample sheet, add one row per function, and upload it in Room Specifications. Functions with the same Room Name will share AV specifications.";

export const parseAssistantActions = (value: unknown): AssistantActionId[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value)]
    .filter((item): item is AssistantActionId =>
      typeof item === "string" && ASSISTANT_ACTION_IDS.includes(item as AssistantActionId))
    .slice(0, 2);
};

export const asksForRoomScheduleHelp = (message: string): boolean => {
  const normalized = message.trim().toLowerCase();
  // Naming the feature is enough on its own: planners ask for help with "the
  // room schedule" far more often than they mention a spreadsheet, and the old
  // room-word AND sheet-word pairing sent those turns to the generic fallback.
  if (/\broom (schedule|schedules|by room|grid|matrix)\b/.test(normalized)) return true;
  if (/\b(schedule|function) (template|sheet|spreadsheet|upload|import)\b/.test(normalized)) return true;
  const roomContext = /\b(room|rooms|function|functions|schedule)\b/.test(normalized);
  const sheetContext = /\b(excel|xlsx|spreadsheet|sheet|template|upload|download|import)\b/.test(normalized);
  return roomContext && sheetContext;
};

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
// The control the dashboard renders for a question. `options` are submitted
// verbatim, so every option string MUST be accepted by
// canonicalMapping.normalizeCandidate for that path (covered by tests).
export type ImportantFieldAnswerType = "date" | "time" | "choice" | "number" | "text";
export const ANSWER_TYPES: readonly ImportantFieldAnswerType[] = Object.freeze(["date", "time", "choice", "number", "text"]);
export type ImportantFieldQuestion = {
  path: string;
  prompt: string;
  impact: ImportantFieldImpact;
  answerType: ImportantFieldAnswerType;
  options?: readonly string[];
};
const YES_NO = Object.freeze(["Yes", "No", "Not sure"]);
// Mirrors streamingPlatformOptions in the dashboard wizard
// (components/proposals/ProposalsProcess.tsx/HybridVirtualStep.tsx) so the
// assistant and the form offer the same list.
const STREAMING_PLATFORMS = Object.freeze([
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
const VENUE_TYPES = Object.freeze([
  "Convention Center",
  "Hotel Ballroom",
  "Resort / Conference Center",
  "Theater / Performing Arts Venue",
  "Arena / Stadium",
  "Corporate Campus / HQ",
  "Outdoor Venue / Tent",
  "Broadcast Studio",
  "Restaurant / Private Event Space",
  "Cruise Ship",
  "Other",
]);
const EVENT_TYPES = Object.freeze([
  "Corporate Conference",
  "User / Customer Summit",
  "Sales Kickoff (SKO)",
  "Annual Meeting / Shareholder Event",
  "Product Launch",
  "Awards Show / Gala",
  "Trade Show / Exhibition",
  "Internal Town Hall",
  "Training / Certification Event",
  "Association / Member Conference",
  "Industry Symposium",
  "Hybrid Broadcast / Studio Production",
  "Other",
]);
export const IMPORTANT_FIELD_QUESTIONS: readonly ImportantFieldQuestion[] = Object.freeze([
  // Asked first: the proposal is created with a placeholder title, and every
  // downstream surface (breadcrumb, draft, exports) reads better once it is real.
  { path: "/content/event/eventName", prompt: "What is this event called?", impact: "scope", answerType: "text" },
  { path: "/content/event/startDate", prompt: "When does the event start? (YYYY-MM-DD)", impact: "schedule", answerType: "date" },
  { path: "/content/event/endDate", prompt: "When does the event end? (YYYY-MM-DD)", impact: "schedule", answerType: "date" },
  { path: "/content/event/eventFormat", prompt: "Is the event in-person, hybrid, or virtual?", impact: "scope", answerType: "choice", options: Object.freeze(["In-Person", "Hybrid", "Virtual"]) },
  { path: "/content/event/eventType/eventType", prompt: "What type of event are you planning?", impact: "scope", answerType: "choice", options: EVENT_TYPES },
  { path: "/content/venueSchedule/venueName", prompt: "Which venue will host the event? Enter the venue name, or use Skip if it is still undecided.", impact: "cost", answerType: "text" },
  { path: "/content/venueSchedule/venueCity", prompt: "Which city will host the event? Add the state for ambiguous city names (for example, Portland, OR).", impact: "cost", answerType: "text" },
  // Attendance drives room sizing, crew and nearly every line a vendor quotes,
  // so it belongs in the opening set. It used to sit below venue state — which
  // the city answer fills in automatically — and fell outside the cap, leaving
  // the readiness check and the investment estimate to guess at head count.
  { path: "/content/event/attendees", prompt: "How many in-person attendees are expected?", impact: "cost", answerType: "number" },
  { path: "/content/venueSchedule/venueState", prompt: "Which state or region will host the event?", impact: "cost", answerType: "text" },
  { path: "/content/venueSchedule/venueType", prompt: "What type of venue will host the event?", impact: "cost", answerType: "choice", options: VENUE_TYPES },
  { path: "/content/venueSchedule/numberOfEventRooms", prompt: "How many event rooms are required?", impact: "cost", answerType: "number" },
  // Asked only after a real venue is selected.
  { path: "/content/venueSchedule/venueConfirmedStatus", prompt: "What is the venue status?", impact: "cost", answerType: "choice", options: Object.freeze(["Contract signed", "Verbally confirmed", "Preferred", "Not selected"]) },
  { path: "/content/venueSchedule/isUnionVenue", prompt: "Is the venue a union venue? (yes / no / not sure)", impact: "cost", answerType: "choice", options: YES_NO },
  { path: "/content/venue/inHouseAvRequired", prompt: "Must the venue's in-house AV provider be used? (yes / no / not sure)", impact: "cost", answerType: "choice", options: YES_NO },
  { path: "/content/venue/riggingRequired", prompt: "Will this venue require rigging? (yes / no / not sure)", impact: "cost", answerType: "choice", options: YES_NO },
  { path: "/content/venue/powerDropsRequired", prompt: "Will dedicated power drops be required? (yes / no / not sure)", impact: "cost", answerType: "choice", options: YES_NO },
  { path: "/content/venueSchedule/loadInDate", prompt: "When can production load in? (YYYY-MM-DD)", impact: "schedule", answerType: "date" },
  { path: "/content/venueSchedule/loadInTime", prompt: "What time can production load in? (HH:MM)", impact: "schedule", answerType: "time" },
  { path: "/content/venue/venueAccessRequirements", prompt: "Are there loading dock, freight elevator, security, parking, or access restrictions?", impact: "production", answerType: "text" },
  { path: "/content/budget/proposalSubmissionDueDate", prompt: "When is the proposal due? (YYYY-MM-DD)", impact: "schedule", answerType: "date" },
  { path: "/content/hybridVirtual/streamingPlatform", prompt: "Which streaming platform will the event use?", impact: "production", answerType: "choice", options: STREAMING_PLATFORMS },
  { path: "/content/videoRecordingStep/videoRecordingRequired", prompt: "Do you need video recording? (yes / no / not sure)", impact: "production", answerType: "choice", options: YES_NO },
]);

export const importantFieldQuestionByPath = (path: string): ImportantFieldQuestion | null =>
  IMPORTANT_FIELD_QUESTIONS.find((field) => field.path === path) ?? null;

// A catch-all extraction issue (e.g. "missing supported fields" listing dozens
// of canonical paths) is never shown as one giant card: it is exploded into
// individual whitelist questions instead.
export const CATCH_ALL_PATH_THRESHOLD = 8;
export const isCatchAllIssue = (code: string, paths: string[]): boolean =>
  paths.length > CATCH_ALL_PATH_THRESHOLD || /missing[_-]?(supported[_-]?)?fields/i.test(code);

// A beginner can produce a useful first draft after the eight highest-impact
// facts. Remaining fields become prioritized improvements after the draft
// instead of an apparently endless intake interview.
export const MAX_OPEN_FIELD_QUESTIONS = 8;
export const MAX_ADAPTIVE_VENUE_QUESTIONS = 19;
export const ADAPTIVE_VENUE_FIELD_PATHS = Object.freeze(
  IMPORTANT_FIELD_QUESTIONS
    .slice(MAX_OPEN_FIELD_QUESTIONS, MAX_ADAPTIVE_VENUE_QUESTIONS)
    .map((field) => field.path),
);

export const isSelectedVenueName = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && !["not selected", "tbd", "undecided", "unknown", "n/a"].includes(normalized);
};

export const venueNeedsOperationalFollowUp = (name: unknown, confirmationStatus: unknown): boolean =>
  isSelectedVenueName(name) &&
  !(typeof confirmationStatus === "string" && ["not_selected", "not selected"].includes(confirmationStatus.trim().toLowerCase()));

// Deterministic per-field issue code so the (proposal, run, issue_code) unique
// key deduplicates exploded questions. Clamped to the 100-char column limit.
export const fieldQuestionCode = (path: string): string => `MISSING_FIELD:${path}`.slice(0, 100);

// Impact tag surfaced to the UI ("affects cost") for single-field questions.
export const questionImpact = (paths: string[]): ImportantFieldImpact | null =>
  paths.length === 1 ? importantFieldQuestionByPath(paths[0])?.impact ?? null : null;

// The answer control the UI should render for a question. Only single
// whitelisted-field questions get a typed control; anything else stays a
// free-text box.
export const questionAnswerType = (paths: string[]): { answerType: ImportantFieldAnswerType; options?: readonly string[] } => {
  const field = paths.length === 1 ? importantFieldQuestionByPath(paths[0]) : null;
  if (!field) return { answerType: "text" };
  return field.options ? { answerType: field.answerType, options: field.options } : { answerType: field.answerType };
};

// The canonical path an answer should be written to — only when the question
// targets exactly one applicable field, so free-form answers stay chat-only.
//
// This used to require membership of IMPORTANT_FIELD_QUESTIONS, the 14-question
// list the assistant asks proactively. That list was doing double duty as both
// "questions we ask" and "answers we are willing to write", and only the first
// is correct: a CROSS_SOURCE_CONFLICT question can name any of the ~114
// whitelisted paths, so for roughly a hundred of them the planner answered and
// nothing was written — the conflict stayed unresolved forever. The write guard
// is normalizeCandidate, which rejects an invalid value with a 422 before the
// question resolves; membership of the proactive list is not a safety property.
export const answerTargetPath = (paths: string[]): string | null =>
  paths.length === 1 && approvedCandidatePaths.includes(paths[0]) ? paths[0] : null;

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
