import {
  aiEnvironment,
  aiRuntimeAuthorized,
} from "../../../config/aiEnvironment";
import { proposalFormGuidanceForField } from "./proposalFormGuidance";
import type {
  AssistantIntent,
  AssistantIntentClassification,
  AssistantIntentSource,
} from "./intentRouter";
import { proposalWorkflowSectionEnabled } from "../proposals/domain/workflowSections";

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
export const ASSISTANT_UI_CONTEXT_ROOM_IDENTIFIER_MAX_LENGTH = 64;
export const ASSISTANT_UI_CONTEXT_FIELD_LABEL_MAX_LENGTH = 120;
export const ASSISTANT_UI_CONTEXT_FIELD_HELP_MAX_LENGTH = 600;
export const ASSISTANT_UI_CONTEXT_FIELD_PLACEHOLDER_MAX_LENGTH = 160;
export const ASSISTANT_UI_CONTEXT_FIELD_OPTION_MAX_LENGTH = 100;
export const ASSISTANT_UI_CONTEXT_FIELD_OPTIONS_MAX_ITEMS = 30;

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
export const ASSISTANT_FEEDBACK_VALUES = [
  "helpful",
  "not_helpful",
] as const;
export const ASSISTANT_FEEDBACK_REASONS = [
  "incorrect",
  "outdated",
  "did_not_understand",
  "missing_steps",
  "irrelevant",
  "other",
] as const;

export type AssistantThreadStatus = (typeof ASSISTANT_THREAD_STATUSES)[number];
export type AssistantMessageRole = (typeof ASSISTANT_MESSAGE_ROLES)[number];
export type AssistantMessageStatus = (typeof ASSISTANT_MESSAGE_STATUSES)[number];
export type AssistantResponseKind = (typeof ASSISTANT_RESPONSE_KINDS)[number];
export type AssistantFeedbackValue =
  (typeof ASSISTANT_FEEDBACK_VALUES)[number];
export type AssistantFeedbackReason =
  (typeof ASSISTANT_FEEDBACK_REASONS)[number];

export const ASSISTANT_ROUTE_CATEGORIES = [
  "dashboard",
  "proposals",
  "proposal_creation",
  "proposal_detail",
  "proposal_assistant",
  "email",
  "vendor_responses",
  "settings",
  "other",
] as const;
export const ASSISTANT_WORKFLOWS = [
  "proposal_intake",
  "proposal_review",
  "proposal_assistant",
  "proposal_email",
  "vendor_response_review",
] as const;
export const ASSISTANT_FORM_SECTION_IDS = [
  "event_overview",
  "venue_schedule",
  "room_specifications",
  "hybrid_virtual",
  "content_creative",
  "video_recording",
  "venue_technical",
  "investment_evaluation",
  "uploads_covendors",
  "contact_submit",
] as const;
export const ASSISTANT_EVENT_FORMATS = [
  "in_person",
  "hybrid",
  "virtual",
] as const;
export const ASSISTANT_FIELD_CONTROL_TYPES = [
  "text",
  "long_text",
  "number",
  "date",
  "email",
  "phone",
  "select",
  "radio",
  "multi_select",
  "option_buttons",
  "file",
] as const;
export const ASSISTANT_FIELD_REQUIREMENTS = [
  "required",
  "optional",
  "conditional",
] as const;

export type AssistantRouteCategory = (typeof ASSISTANT_ROUTE_CATEGORIES)[number];
export type AssistantWorkflow = (typeof ASSISTANT_WORKFLOWS)[number];
export type AssistantFormSectionId = (typeof ASSISTANT_FORM_SECTION_IDS)[number];
export type AssistantEventFormat = (typeof ASSISTANT_EVENT_FORMATS)[number];
export type AssistantFieldControlType =
  (typeof ASSISTANT_FIELD_CONTROL_TYPES)[number];
export type AssistantFieldRequirement =
  (typeof ASSISTANT_FIELD_REQUIREMENTS)[number];

export type AssistantFieldControlContext = {
  label: string;
  helperText: string;
  requirement?: AssistantFieldRequirement;
  controlType?: AssistantFieldControlType;
  options?: string[];
  minimumSelections?: number;
  maximumSelections?: number;
  placeholder?: string;
};

export type AssistantUiContext = {
  schemaVersion: "assistant-ui-context.v1";
  routeCategory: AssistantRouteCategory;
  workflow?: AssistantWorkflow;
  sectionId?: AssistantFormSectionId;
  fieldKey?: string;
  fieldKeyStatus: "not_provided" | "valid" | "unknown";
  eventFormat?: AssistantEventFormat;
  roomIdentifier?: string;
  fieldControl?: AssistantFieldControlContext;
};

export type AssistantCitation = {
  sourceId: string;
  title: string;
  href?: string;
  releaseId?: string;
  fragmentId?: string;
};

export type AssistantMessageFeedback = {
  value: AssistantFeedbackValue;
  reason: AssistantFeedbackReason | null;
  updatedAt: string;
};

export type AssistantFeedback = AssistantMessageFeedback & {
  id: string;
  threadId: string;
  messageId: string;
  createdAt: string;
};

export type AssistantThread = {
  id: string;
  title: string;
  status: AssistantThreadStatus;
  messageCount: number;
  lastMessageAt: string | null;
  deletedAt: string | null;
  purgeAfter: string | null;
  recoverable: boolean;
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
  intent: AssistantIntent | null;
  intentVersion: string | null;
  intentSource: AssistantIntentSource | null;
  intentConfidence: AssistantIntentClassification["confidence"] | null;
  responseKind: AssistantResponseKind | null;
  promptVersion: string | null;
  knowledgeVersion: string | null;
  firstTokenMs: number | null;
  completionLatencyMs: number | null;
  citations: AssistantCitation[];
  feedback: AssistantMessageFeedback | null;
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
  sourceType:
    | "platform_fact"
    | "operating_guidance"
    | "selected_proposal"
    | "proposal_portfolio";
  trust:
    | "trusted_platform_fact"
    | "untrusted_retrieved_content"
    | "authorized_private_data";
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
  schemaVersion: "platform-assistant-prompt.v6";
  platformKnowledgeVersion: string;
  userMessage: string;
  history: AssistantPromptMessage[];
  evidence: AssistantPromptEvidence[];
  uiContext: AssistantUiContext | null;
  intent: AssistantIntentClassification;
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
  analyticsSessionId?: string;
};

export class PlatformAssistantError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422,
    public readonly retryable = false,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export const platformAssistantEnabled = (): boolean =>
  aiRuntimeAuthorized() && process.env.AI_ASSISTANT_ENABLED === "true";

export const platformAssistantKilled = (): boolean =>
  process.env.AI_ASSISTANT_KILL_SWITCH !== "false" ||
  process.env.LIVE_AI_KILL_SWITCH === "true";

const organizationIdPattern = /^[0-9a-f]{24}$/i;

const configuredAssistantOrganizations = ():
  | { mode: "all" }
  | { mode: "limited"; ids: Set<string> }
  | { mode: "blocked" } => {
  const configured = String(
    process.env.AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS || "",
  ).trim();

  if (!configured) {
    return aiEnvironment() === "production"
      ? { mode: "blocked" }
      : { mode: "all" };
  }

  if (configured === "*") return { mode: "all" };

  const ids = configured
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (
    ids.length === 0 ||
    ids.includes("*") ||
    ids.some((value) => !organizationIdPattern.test(value))
  ) {
    return { mode: "blocked" };
  }
  return { mode: "limited", ids: new Set(ids) };
};

export const platformAssistantEnabledForOrganization = (
  organizationMongoId: string,
): boolean => {
  if (!platformAssistantEnabled()) return false;
  const organizationId = String(organizationMongoId || "")
    .trim()
    .toLowerCase();
  if (!organizationIdPattern.test(organizationId)) return false;
  const access = configuredAssistantOrganizations();
  return access.mode === "all" ||
    (access.mode === "limited" && access.ids.has(organizationId));
};

export const assertPlatformAssistantEnabled = (): void => {
  if (!platformAssistantEnabled()) {
    throw new PlatformAssistantError(
      "AI_ASSISTANT_DISABLED",
      "The AI Assistant is not available in this environment.",
      503,
    );
  }
};

export const assertPlatformAssistantOrganizationEnabled = (
  organizationMongoId: string,
): void => {
  assertPlatformAssistantEnabled();
  if (!platformAssistantEnabledForOrganization(organizationMongoId)) {
    throw new PlatformAssistantError(
      "AI_ASSISTANT_ORGANIZATION_NOT_ENABLED",
      "The AI Assistant is not enabled for this organization.",
      403,
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

export const assertPlatformAssistantOrganizationAvailable = (
  organizationMongoId: string,
): void => {
  assertPlatformAssistantOrganizationEnabled(organizationMongoId);
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

export const parseAssistantMessageId = (value: unknown): string => {
  const id = String(value ?? "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    throw new PlatformAssistantError(
      "ASSISTANT_MESSAGE_NOT_FOUND",
      "The assistant message was not found.",
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
): { content: string; uiContext: AssistantUiContext | null } => {
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
  return {
    content,
    uiContext: parseAssistantUiContext(body.uiContext),
  };
};

const oneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T => typeof value === "string" && allowed.includes(value as T);

const parseAssistantFieldControl = (
  value: unknown,
): AssistantFieldControlContext | null => {
  if (!isRecord(value) || Array.isArray(value)) return null;
  const label = typeof value.label === "string" ? value.label.trim() : "";
  const helperText =
    typeof value.helperText === "string" ? value.helperText.trim() : "";
  if (
    !label ||
    label.length > ASSISTANT_UI_CONTEXT_FIELD_LABEL_MAX_LENGTH ||
    !helperText ||
    helperText.length > ASSISTANT_UI_CONTEXT_FIELD_HELP_MAX_LENGTH
  ) {
    return null;
  }
  const requirement =
    value.requirement === undefined
      ? undefined
      : oneOf(value.requirement, ASSISTANT_FIELD_REQUIREMENTS)
        ? value.requirement
        : null;
  const controlType =
    value.controlType === undefined
      ? undefined
      : oneOf(value.controlType, ASSISTANT_FIELD_CONTROL_TYPES)
        ? value.controlType
        : null;
  const placeholder =
    value.placeholder === undefined
      ? undefined
      : typeof value.placeholder === "string" &&
          value.placeholder.length <=
            ASSISTANT_UI_CONTEXT_FIELD_PLACEHOLDER_MAX_LENGTH
        ? value.placeholder.trim()
        : null;
  const options =
    value.options === undefined
      ? undefined
      : Array.isArray(value.options) &&
          value.options.length <= ASSISTANT_UI_CONTEXT_FIELD_OPTIONS_MAX_ITEMS &&
          value.options.every(
            (option) =>
              typeof option === "string" &&
              Boolean(option.trim()) &&
              option.length <= ASSISTANT_UI_CONTEXT_FIELD_OPTION_MAX_LENGTH,
          )
        ? [...new Set(value.options.map((option) => option.trim()))]
        : null;
  const selectionLimit = (candidate: unknown): number | null | undefined =>
    candidate === undefined
      ? undefined
      : Number.isInteger(candidate) &&
          Number(candidate) >= 0 &&
          Number(candidate) <= ASSISTANT_UI_CONTEXT_FIELD_OPTIONS_MAX_ITEMS
        ? Number(candidate)
        : null;
  const minimumSelections = selectionLimit(value.minimumSelections);
  const maximumSelections = selectionLimit(value.maximumSelections);
  if (
    requirement === null ||
    controlType === null ||
    placeholder === null ||
    options === null ||
    minimumSelections === null ||
    maximumSelections === null ||
    maximumSelections === 0 ||
    (minimumSelections !== undefined &&
      maximumSelections !== undefined &&
      minimumSelections > maximumSelections)
  ) {
    return null;
  }
  return {
    label,
    helperText,
    ...(requirement ? { requirement } : {}),
    ...(controlType ? { controlType } : {}),
    ...(options?.length ? { options } : {}),
    ...(minimumSelections !== undefined ? { minimumSelections } : {}),
    ...(maximumSelections !== undefined ? { maximumSelections } : {}),
    ...(placeholder ? { placeholder } : {}),
  };
};

export const parseAssistantFeedbackInput = (
  value: unknown,
): {
  value: AssistantFeedbackValue;
  reason: AssistantFeedbackReason | null;
} => {
  const body = isRecord(value) ? value : {};
  if (!oneOf(body.value, ASSISTANT_FEEDBACK_VALUES)) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_FEEDBACK",
      "Choose Helpful or Not helpful.",
    );
  }
  const reason =
    body.reason === undefined || body.reason === null || body.reason === ""
      ? null
      : oneOf(body.reason, ASSISTANT_FEEDBACK_REASONS)
        ? body.reason
        : undefined;
  if (reason === undefined || (body.value === "helpful" && reason !== null)) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_FEEDBACK",
      "The selected feedback reason is invalid.",
    );
  }
  return { value: body.value, reason };
};

export const parseAssistantUiContext = (
  value: unknown,
): AssistantUiContext | null => {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_UI_CONTEXT",
      "The assistant page context is invalid.",
    );
  }
  if (
    value.schemaVersion !== "assistant-ui-context.v1" ||
    !oneOf(value.routeCategory, ASSISTANT_ROUTE_CATEGORIES)
  ) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_UI_CONTEXT",
      "The assistant page context is invalid.",
    );
  }
  const workflow =
    value.workflow === undefined
      ? undefined
      : oneOf(value.workflow, ASSISTANT_WORKFLOWS)
        ? value.workflow
        : null;
  const sectionId =
    value.sectionId === undefined
      ? undefined
      : oneOf(value.sectionId, ASSISTANT_FORM_SECTION_IDS)
        ? value.sectionId
        : null;
  const retiredSectionContext =
    sectionId === "video_recording" &&
    !proposalWorkflowSectionEnabled("video_recording");
  const activeSectionId = retiredSectionContext ? undefined : sectionId;
  const eventFormat =
    value.eventFormat === undefined
      ? undefined
      : oneOf(value.eventFormat, ASSISTANT_EVENT_FORMATS)
        ? value.eventFormat
        : null;
  const roomIdentifier =
    value.roomIdentifier === undefined
      ? undefined
      : typeof value.roomIdentifier === "string" &&
          /^[A-Za-z0-9:_-]+$/.test(value.roomIdentifier) &&
          value.roomIdentifier.length <=
            ASSISTANT_UI_CONTEXT_ROOM_IDENTIFIER_MAX_LENGTH
        ? value.roomIdentifier
        : null;
  if (
    workflow === null ||
    sectionId === null ||
    eventFormat === null ||
    roomIdentifier === null
  ) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_UI_CONTEXT",
      "The assistant page context is invalid.",
    );
  }

  const fieldControl =
    value.fieldControl === undefined
      ? undefined
      : parseAssistantFieldControl(value.fieldControl);
  if (value.fieldControl !== undefined && !fieldControl) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_UI_CONTEXT",
      "The assistant page context is invalid.",
    );
  }

  const suppliedFieldKey =
    !retiredSectionContext && typeof value.fieldKey === "string"
      ? value.fieldKey.trim()
      : "";
  let fieldKey: string | undefined;
  let fieldKeyStatus: AssistantUiContext["fieldKeyStatus"] = "not_provided";
  if (suppliedFieldKey) {
    if (proposalFormGuidanceForField(suppliedFieldKey)) {
      fieldKey = suppliedFieldKey;
      fieldKeyStatus = "valid";
    } else {
      fieldKeyStatus = "unknown";
    }
  }

  return {
    schemaVersion: "assistant-ui-context.v1",
    routeCategory: value.routeCategory,
    ...(workflow ? { workflow } : {}),
    ...(activeSectionId ? { sectionId: activeSectionId } : {}),
    ...(fieldKey ? { fieldKey } : {}),
    fieldKeyStatus,
    ...(eventFormat ? { eventFormat } : {}),
    ...(!retiredSectionContext && roomIdentifier ? { roomIdentifier } : {}),
    ...(!retiredSectionContext && fieldControl ? { fieldControl } : {}),
  };
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
