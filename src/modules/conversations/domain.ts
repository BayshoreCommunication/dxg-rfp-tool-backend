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
  if (known) return known;
  const fields = paths.map((path) => path.split("/").pop() || path).join(", ");
  const readable = code.toLowerCase().replace(/_/g, " ");
  return fields ? `Please review: ${readable} (${fields}).` : `Please review: ${readable}.`;
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
