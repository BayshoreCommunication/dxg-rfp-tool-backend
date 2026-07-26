import { aiRuntimeAuthorized } from "../../../config/aiEnvironment";

export const ASSISTANT_THREAD_TITLE_MAX_LENGTH = 200;
export const ASSISTANT_MESSAGE_MAX_LENGTH = 8_000;
export const ASSISTANT_IDEMPOTENCY_KEY_MAX_LENGTH = 200;
export const ASSISTANT_THREAD_LIST_MAX_LIMIT = 100;
export const ASSISTANT_MESSAGE_LIST_MAX_LIMIT = 200;
export const ASSISTANT_HISTORY_MAX_MESSAGES = 30;
export const ASSISTANT_HISTORY_MAX_CHARACTERS = 24_000;
export const ASSISTANT_KNOWLEDGE_MAX_RESULTS = 8;
export const ASSISTANT_EVIDENCE_MAX_CHARACTERS = 20_000;
export const ASSISTANT_EVIDENCE_ITEM_MAX_CHARACTERS = 3_000;
export const ASSISTANT_RESPONSE_MAX_CHARACTERS = 12_000;
export const ASSISTANT_RESPONSE_MAX_CITATIONS = 12;

export const ASSISTANT_THREAD_STATUSES = ["active", "archived"] as const;
export const ASSISTANT_MESSAGE_ROLES = ["user", "assistant", "system_event"] as const;
export const ASSISTANT_MESSAGE_STATUSES = [
  "pending",
  "streaming",
  "complete",
  "failed",
  "aborted",
] as const;
export const ASSISTANT_RESPONSE_KINDS = [
  "answer",
  "clarification",
  "refusal",
  "abstention",
] as const;

export type AssistantThreadStatus = (typeof ASSISTANT_THREAD_STATUSES)[number];
export type AssistantMessageRole = (typeof ASSISTANT_MESSAGE_ROLES)[number];
export type AssistantMessageStatus = (typeof ASSISTANT_MESSAGE_STATUSES)[number];
export type AssistantResponseKind = (typeof ASSISTANT_RESPONSE_KINDS)[number];

export type AssistantCitation = {
  sourceId: string;
  title: string;
  href?: string;
  releaseId?: string;
  fragmentId?: string;
};

export type AssistantThread = {
  id: string;
  title: string;
  status: AssistantThreadStatus;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AssistantMessage = {
  id: string;
  threadId: string;
  ordinal: number;
  role: AssistantMessageRole;
  content: string;
  status: AssistantMessageStatus;
  providerResponseId: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  safeErrorCode: string | null;
  citations: AssistantCitation[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type AssistantThreadDetail = {
  thread: AssistantThread;
  messages: AssistantMessage[];
};

export type AssistantPromptEvidence = {
  id: string;
  sourceType: "platform_fact" | "operating_guidance";
  trust: "trusted_platform_fact" | "untrusted_retrieved_content";
  title: string;
  content: string;
  href?: string;
  releaseId?: string;
  fragmentId?: string;
};

export type AssistantPromptMessage = {
  role: Extract<AssistantMessageRole, "user" | "assistant">;
  content: string;
};

export type AssistantPromptInput = {
  schemaVersion: "platform-assistant-prompt.v1";
  platformKnowledgeVersion: string;
  userMessage: string;
  history: AssistantPromptMessage[];
  evidence: AssistantPromptEvidence[];
  instructions: readonly string[];
};

export type AssistantProviderResponse = {
  kind: AssistantResponseKind;
  content: string;
  citationIds: string[];
};

export type AssistantKnowledgeStatus =
  | {
      state: "available";
      policyVersion: string | null;
      resultCount: number;
    }
  | {
      state: "unavailable";
      safeCode: "ASSISTANT_KNOWLEDGE_UNAVAILABLE";
      diagnosticCode: string;
    }
  | {
      state: "not_requested";
    };

export type PlatformAssistantContext = {
  organizationMongoId: string;
  actorUserMongoId: string;
  correlationId: string;
};

export class PlatformAssistantError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422,
    public readonly retryable = false,
  ) {
    super(message);
  }
}

export const platformAssistantEnabled = (): boolean =>
  aiRuntimeAuthorized() && process.env.AI_ASSISTANT_ENABLED === "true";

export const platformAssistantKilled = (): boolean =>
  process.env.AI_ASSISTANT_KILL_SWITCH !== "false" ||
  process.env.LIVE_AI_KILL_SWITCH === "true";

export const assertPlatformAssistantEnabled = (): void => {
  if (!platformAssistantEnabled()) {
    throw new PlatformAssistantError(
      "AI_ASSISTANT_DISABLED",
      "The AI Assistant is not available in this environment.",
      503,
    );
  }
};

export const assertPlatformAssistantAvailable = (): void => {
  assertPlatformAssistantEnabled();
  if (platformAssistantKilled()) {
    throw new PlatformAssistantError(
      "AI_ASSISTANT_KILLED",
      "The AI Assistant is temporarily unavailable.",
      503,
    );
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const parseAssistantThreadId = (value: unknown): string => {
  const id = String(value ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new PlatformAssistantError(
      "ASSISTANT_THREAD_NOT_FOUND",
      "The assistant conversation was not found.",
      404,
    );
  }
  return id;
};

export const parseAssistantIdempotencyKey = (value: unknown): string => {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key || key.length > ASSISTANT_IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new PlatformAssistantError(
      "ASSISTANT_IDEMPOTENCY_KEY_REQUIRED",
      "A valid idempotency key is required.",
      400,
    );
  }
  return key;
};

export const parseCreateAssistantThreadInput = (
  value: unknown,
): { title: string } => {
  const body = isRecord(value) ? value : {};
  const supplied = typeof body.title === "string" ? body.title.trim().replace(/\s+/g, " ") : "";
  const title = supplied || "New conversation";
  if (title.length > ASSISTANT_THREAD_TITLE_MAX_LENGTH) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_THREAD",
      `Conversation titles must be ${ASSISTANT_THREAD_TITLE_MAX_LENGTH} characters or fewer.`,
    );
  }
  return { title };
};

export const parseAssistantMessageInput = (
  value: unknown,
): { content: string } => {
  const body = isRecord(value) ? value : {};
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_MESSAGE",
      "Enter a message before sending.",
    );
  }
  if (content.length > ASSISTANT_MESSAGE_MAX_LENGTH) {
    throw new PlatformAssistantError(
      "ASSISTANT_MESSAGE_TOO_LARGE",
      `Messages must be ${ASSISTANT_MESSAGE_MAX_LENGTH.toLocaleString("en-US")} characters or fewer.`,
      413,
    );
  }
  return { content };
};

export const parseAssistantListLimit = (
  value: unknown,
  maximum: number,
  fallback: number,
): number => {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_PAGINATION",
      `The result limit must be between 1 and ${maximum}.`,
    );
  }
  return parsed;
};

export const parseAssistantBeforeOrdinal = (value: unknown): number | null => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 2) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_PAGINATION",
      "The message cursor is invalid.",
    );
  }
  return parsed;
};

const allowedTransitions: Record<AssistantMessageStatus, readonly AssistantMessageStatus[]> = {
  pending: ["streaming", "complete", "failed", "aborted"],
  streaming: ["complete", "failed", "aborted"],
  complete: [],
  failed: [],
  aborted: [],
};

export const canTransitionAssistantMessage = (
  from: AssistantMessageStatus,
  to: AssistantMessageStatus,
): boolean =>
  (from === to && (from === "pending" || from === "streaming")) ||
  allowedTransitions[from].includes(to);
