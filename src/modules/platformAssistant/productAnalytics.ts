import { aiEnvironment } from "../../../config/aiEnvironment";
import {
  ASSISTANT_FEEDBACK_REASONS,
  ASSISTANT_FEEDBACK_VALUES,
  ASSISTANT_RESPONSE_KINDS,
  ASSISTANT_ROUTE_CATEGORIES,
  PlatformAssistantError,
  type AssistantFeedbackReason,
  type AssistantFeedbackValue,
  type AssistantResponseKind,
  type AssistantRouteCategory,
} from "./domain";
import {
  ASSISTANT_INTENTS,
  type AssistantIntent,
} from "./intentRouter";

export const ASSISTANT_PRODUCT_EVENT_SCHEMA_VERSION =
  "assistant-product-event.v1" as const;

export const ASSISTANT_PRODUCT_EVENT_TYPES = [
  "assistant_opened",
  "suggestion_shown",
  "suggestion_selected",
  "message_submitted",
  "first_token_received",
  "response_completed",
  "response_failed",
  "response_retried",
  "citation_opened",
  "internal_route_opened",
  "feedback_submitted",
  "proposal_handoff_started",
  "proposal_handoff_completed",
  "analysis_started",
  "analysis_completed",
  "finding_reviewed",
  "field_change_proposed",
  "field_change_applied",
] as const;

export const ASSISTANT_CLIENT_EVENT_TYPES = [
  "assistant_opened",
  "suggestion_shown",
  "suggestion_selected",
  "response_retried",
  "citation_opened",
  "internal_route_opened",
  "proposal_handoff_started",
  "proposal_handoff_completed",
  "finding_reviewed",
] as const;

export const ASSISTANT_COMPLETION_OUTCOMES = [
  "completed",
  "failed",
  "aborted",
  "retried",
  "navigated",
  "selected",
  "shown",
  "opened",
] as const;

export const ASSISTANT_FINDING_CATEGORIES = [
  "completeness",
  "schedule",
  "production",
  "budget",
  "risk",
  "scope",
  "room",
  "application",
  "other",
] as const;

export type AssistantProductEventType =
  (typeof ASSISTANT_PRODUCT_EVENT_TYPES)[number];
export type AssistantClientEventType =
  (typeof ASSISTANT_CLIENT_EVENT_TYPES)[number];
export type AssistantCompletionOutcome =
  (typeof ASSISTANT_COMPLETION_OUTCOMES)[number];
export type AssistantFindingCategory =
  (typeof ASSISTANT_FINDING_CATEGORIES)[number];
export type AssistantLatencyBucket =
  | "under_250_ms"
  | "250_to_999_ms"
  | "1_to_2_99_s"
  | "3_to_9_99_s"
  | "10_s_or_more"
  | "unknown";
export type AssistantErrorCategory =
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "provider"
  | "validation"
  | "knowledge"
  | "network"
  | "user_abort"
  | "internal"
  | "none";

export type AssistantProductEventInput = {
  eventType: AssistantProductEventType;
  sessionId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  routeCategory?: AssistantRouteCategory | null;
  intent?: AssistantIntent | null;
  responseKind?: AssistantResponseKind | null;
  model?: string | null;
  promptVersion?: string | null;
  knowledgeVersion?: string | null;
  ruleVersion?: string | null;
  pricingVersion?: string | null;
  cited?: boolean | null;
  firstTokenMs?: number | null;
  completionLatencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCostMicros?: number | null;
  errorCode?: string | null;
  findingCategory?: AssistantFindingCategory | null;
  completionOutcome?: AssistantCompletionOutcome | null;
  feedbackValue?: AssistantFeedbackValue | null;
  feedbackReason?: AssistantFeedbackReason | null;
  idempotencyKey: string;
};

export type AssistantClientProductEventInput = Pick<
  AssistantProductEventInput,
  | "sessionId"
  | "threadId"
  | "messageId"
  | "routeCategory"
  | "findingCategory"
> & {
  eventType: AssistantClientEventType;
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const optionalUuid = (
  value: unknown,
  code: string,
  message: string,
): string | null => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new PlatformAssistantError(code, message, 422);
  }
  return value.toLowerCase();
};

export const parseAssistantClientProductEvent = (
  value: unknown,
): AssistantClientProductEventInput => {
  const input = record(value);
  if (!input) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_ANALYTICS_EVENT",
      "The assistant analytics event is invalid.",
      422,
    );
  }
  const eventType = ASSISTANT_CLIENT_EVENT_TYPES.includes(
    input.eventType as AssistantClientEventType,
  )
    ? (input.eventType as AssistantClientEventType)
    : null;
  if (!eventType) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_ANALYTICS_EVENT",
      "The assistant analytics event type is not allowed.",
      422,
    );
  }
  const sessionId = optionalUuid(
    input.sessionId,
    "INVALID_ASSISTANT_ANALYTICS_SESSION",
    "The assistant analytics session is invalid.",
  );
  if (!sessionId) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_ANALYTICS_SESSION",
      "The assistant analytics session is required.",
      422,
    );
  }
  const threadId = optionalUuid(
    input.threadId,
    "ASSISTANT_THREAD_NOT_FOUND",
    "The assistant conversation was not found.",
  );
  const messageId = optionalUuid(
    input.messageId,
    "ASSISTANT_MESSAGE_NOT_FOUND",
    "The assistant message was not found.",
  );
  if (messageId && !threadId) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_ANALYTICS_EVENT",
      "A message event requires its conversation.",
      422,
    );
  }
  const routeCategory =
    input.routeCategory === undefined || input.routeCategory === null
      ? null
      : ASSISTANT_ROUTE_CATEGORIES.includes(
            input.routeCategory as AssistantRouteCategory,
          )
        ? (input.routeCategory as AssistantRouteCategory)
        : null;
  if (
    input.routeCategory !== undefined &&
    input.routeCategory !== null &&
    routeCategory === null
  ) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_ANALYTICS_EVENT",
      "The assistant route category is invalid.",
      422,
    );
  }
  const findingCategory =
    input.findingCategory === undefined || input.findingCategory === null
      ? null
      : ASSISTANT_FINDING_CATEGORIES.includes(
            input.findingCategory as AssistantFindingCategory,
          )
        ? (input.findingCategory as AssistantFindingCategory)
        : null;
  if (
    input.findingCategory !== undefined &&
    input.findingCategory !== null &&
    findingCategory === null
  ) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_ANALYTICS_EVENT",
      "The assistant finding category is invalid.",
      422,
    );
  }
  return {
    eventType,
    sessionId,
    threadId,
    messageId,
    routeCategory,
    findingCategory,
  };
};

export const assistantProductAnalyticsEnabled = (): boolean =>
  process.env.AI_ASSISTANT_ANALYTICS_ENABLED === "true";

export const assistantOrganizationCohort = (): string => {
  const environment = aiEnvironment();
  const allowlist = String(
    process.env.AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS || "",
  ).trim();
  const scope = allowlist
    ? allowlist === "*"
      ? "all"
      : "limited"
    : environment === "production"
      ? "blocked"
      : "default";
  return `${environment}_${scope}`;
};

export const assistantLatencyBucket = (
  value: number | null | undefined,
): AssistantLatencyBucket => {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "unknown";
  }
  if (value < 250) return "under_250_ms";
  if (value < 1_000) return "250_to_999_ms";
  if (value < 3_000) return "1_to_2_99_s";
  if (value < 10_000) return "3_to_9_99_s";
  return "10_s_or_more";
};

export const assistantErrorCategory = (
  value: string | null | undefined,
): AssistantErrorCategory => {
  const code = String(value || "").toUpperCase();
  if (!code) return "none";
  if (code.includes("AUTHENTICATION") || code.includes("SESSION")) {
    return "authentication";
  }
  if (
    code.includes("AUTHORIZATION") ||
    code.includes("DENIED") ||
    code.includes("NOT_ENABLED")
  ) {
    return "authorization";
  }
  if (code.includes("RATE") || code.includes("LIMIT")) return "rate_limit";
  if (code.includes("ABORT")) return "user_abort";
  if (code.includes("KNOWLEDGE")) return "knowledge";
  if (
    code.includes("NETWORK") ||
    code.includes("UPSTREAM") ||
    code.includes("CONNECTION")
  ) {
    return "network";
  }
  if (
    code.includes("INVALID") ||
    code.includes("SCHEMA") ||
    code.includes("CITATION")
  ) {
    return "validation";
  }
  if (
    code.includes("PROVIDER") ||
    code.includes("CREDENTIAL") ||
    code.includes("RESPONSE")
  ) {
    return "provider";
  }
  return "internal";
};

export const isAssistantIntent = (
  value: unknown,
): value is AssistantIntent =>
  ASSISTANT_INTENTS.includes(value as AssistantIntent);

export const isAssistantResponseKind = (
  value: unknown,
): value is AssistantResponseKind =>
  ASSISTANT_RESPONSE_KINDS.includes(value as AssistantResponseKind);

export const isAssistantFeedbackValue = (
  value: unknown,
): value is AssistantFeedbackValue =>
  ASSISTANT_FEEDBACK_VALUES.includes(value as AssistantFeedbackValue);

export const isAssistantFeedbackReason = (
  value: unknown,
): value is AssistantFeedbackReason =>
  ASSISTANT_FEEDBACK_REASONS.includes(value as AssistantFeedbackReason);
