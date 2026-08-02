import type {
  AssistantMessage,
  AssistantUiContext,
} from "./domain";
import { PROPOSAL_FORM_FIELD_GUIDANCE } from "./proposalFormGuidance";

export const ASSISTANT_INTENT_VERSION = "assistant-intent-router.v1";

export const ASSISTANT_INTENTS = [
  "greeting_or_thanks",
  "platform_navigation",
  "proposal_creation",
  "proposal_review",
  "pre_send_checklist",
  "event_planning",
  "form_field_help",
  "proposal_specific_request",
  "equipment_scope_review",
  "budget_estimation",
  "historical_reference_request",
  "action_request",
  "unsupported_or_off_topic",
  "ambiguous",
] as const;

export type AssistantIntent = (typeof ASSISTANT_INTENTS)[number];
export type AssistantIntentSource =
  | "deterministic"
  | "ui_context"
  | "follow_up"
  | "fallback";

export type AssistantIntentClassification = {
  intent: AssistantIntent;
  version: typeof ASSISTANT_INTENT_VERSION;
  source: AssistantIntentSource;
  confidence: "high" | "medium" | "low";
};

const normalize = (value: string): string =>
  value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");

const exactConversational = /^(?:hi|hello|hey|good (?:morning|afternoon|evening)|thanks|thank you|appreciate it)[!,.?]*$/i;
const followUpPattern =
  /^(?:and |also |then |now )?(?:what about|how about|why|show me|explain|shorten|summari[sz]e|make (?:that|it)|that|those|it|this|the same|can i leave (?:it|this) blank)\b/i;

const previousIntent = (
  messages: readonly AssistantMessage[],
  currentUserMessageId?: string,
): AssistantIntent | undefined =>
  [...messages]
    .reverse()
    .find(
      (message) =>
        message.id !== currentUserMessageId &&
        message.role === "assistant" &&
        message.status === "complete" &&
        Boolean(message.intent),
    )?.intent ?? undefined;

const result = (
  intent: AssistantIntent,
  source: AssistantIntentSource,
  confidence: AssistantIntentClassification["confidence"],
): AssistantIntentClassification => ({
  intent,
  version: ASSISTANT_INTENT_VERSION,
  source,
  confidence,
});

export const classifyAssistantIntent = (input: {
  query: string;
  uiContext: AssistantUiContext | null;
  history?: readonly AssistantMessage[];
  currentUserMessageId?: string;
}): AssistantIntentClassification => {
  const query = normalize(input.query);
  const uiContext = input.uiContext;
  const namesKnownProposalField =
    /\b(?:field|enter|input|fill|blank|required|optional|example|options?|choices?|maximum|select|choose|what should)\b/i.test(
      query,
    ) &&
    PROPOSAL_FORM_FIELD_GUIDANCE.some((field) =>
      query.includes(field.label.toLocaleLowerCase("en-US")),
    );

  if (exactConversational.test(query)) {
    return result("greeting_or_thanks", "deterministic", "high");
  }
  if (
    /^(?:please\s+)?(?:create|publish|send|delete|edit|change|update|book|reserve|schedule|email|contact)\b/i.test(
      query,
    ) ||
    /\b(?:do it|do that|on my behalf|for me)\b/i.test(query)
  ) {
    return result("action_request", "deterministic", "high");
  }
  if (
    /["“][^"”]{3,240}["”]/u.test(query) &&
    /\b(?:status|details?|owner|deadline|missing|readiness|summari[sz]e|compare)\b/i.test(
      query,
    )
  ) {
    return result("proposal_specific_request", "deterministic", "high");
  }
  if (
    /\b(?:create|start|new|make)\b.*\bproposal\b|\bproposal\b.*\b(?:form|intake|steps?)\b/i.test(
      query,
    )
  ) {
    return result("proposal_creation", "deterministic", "high");
  }
  if (
    uiContext?.fieldKeyStatus === "valid" ||
    Boolean(uiContext?.fieldControl) ||
    namesKnownProposalField ||
    /\b(?:this|the|a)\s+field\b|\bwhat (?:belongs|should i (?:enter|put))\b|\bcan i leave\b.*\bblank\b|\bfield (?:required|example|help)\b|\b(?:options?|choices?|available|required|requirement)\b.{0,80}\bfield\b/i.test(
      query,
    )
  ) {
    return result("form_field_help", "ui_context", "high");
  }
  if (
    /\b(?:last year|previous|historical|past)\b.*\bproposal\b|\bproposal\b.*\b(?:reference|compare|reuse)\b/i.test(
      query,
    )
  ) {
    return result("historical_reference_request", "deterministic", "high");
  }
  if (
    /\b(?:budget|estimate|cost|price|pricing|rate|over budget|subtotal|total)\b/i.test(
      query,
    )
  ) {
    return result("budget_estimation", "deterministic", "high");
  }
  if (
    /\b(?:equipment|microphone|camera|projector|screen|led wall|lighting|rigging|crew|labor|operator|streaming package)\b.*\b(?:enough|missing|review|need|share|duplicate|scope)\b|\b(?:review|check)\b.*\b(?:equipment|scope|labor|crew)\b/i.test(
      query,
    )
  ) {
    return result("equipment_scope_review", "deterministic", "high");
  }
  if (
    /\b(?:my|this|current|opened|selected)\s+proposal\b|\bproposal\b.*\b(?:missing|summary|summari[sz]e|analy[sz]e|complete|readiness)\b/i.test(
      query,
    )
  ) {
    return result("proposal_specific_request", "deterministic", "high");
  }
  if (
    /\b(?:before|pre[- ]?send|ready to send)\b.*\b(?:send|proposal|check|review)\b|\bproposal\b.*\b(?:before sending|pre[- ]?send)\b/i.test(
      query,
    )
  ) {
    return result("pre_send_checklist", "deterministic", "high");
  }
  if (
    /\b(?:review|check|improve)\b.*\bproposal\b|\bproposal review\b/i.test(query)
  ) {
    return result("proposal_review", "deterministic", "high");
  }
  if (
    /\b(?:where|navigate|find|open|go to|page|settings|dashboard|vendor responses|email area)\b/i.test(
      query,
    )
  ) {
    return result("platform_navigation", "deterministic", "high");
  }
  if (
    /\b(?:weather forecast|sports score|stock price|medical diagnosis|legal advice|write code|recipe|movie|music)\b/i.test(
      query,
    )
  ) {
    return result("unsupported_or_off_topic", "deterministic", "high");
  }
  if (
    /\b(?:plan|planning|event|venue|attendee|conference|agenda|schedule|rooms?)\b/i.test(
      query,
    )
  ) {
    return result("event_planning", "deterministic", "medium");
  }
  if (followUpPattern.test(query)) {
    const prior = previousIntent(input.history ?? [], input.currentUserMessageId);
    if (prior && prior !== "greeting_or_thanks" && prior !== "ambiguous") {
      return result(prior, "follow_up", "medium");
    }
  }
  if (query.length < 4) {
    return result("ambiguous", "fallback", "low");
  }
  return result("ambiguous", "fallback", "low");
};

const allowedPlatformPrefixes: Readonly<
  Record<AssistantIntent, readonly string[]>
> = {
  greeting_or_thanks: ["platform:assistant:scope"],
  platform_navigation: ["platform:navigation:", "platform:assistant:scope"],
  proposal_creation: [
    "platform:navigation:create-proposal",
    "platform:proposal:guided-intake",
    "form-field:",
  ],
  proposal_review: [
    "platform:proposal:workflow",
    "platform:proposal:pre-send-checklist",
    "platform:navigation:proposals",
  ],
  pre_send_checklist: [
    "platform:proposal:pre-send-checklist",
    "platform:navigation:proposals",
    "platform:navigation:email",
  ],
  event_planning: [
    "platform:event:",
    "platform:proposal:",
    "form-field:",
    "platform:navigation:create-proposal",
  ],
  form_field_help: [
    "form-field:",
    "platform:proposal:guided-intake",
    "platform:navigation:create-proposal",
  ],
  proposal_specific_request: [
    "selected-proposal:",
    "proposal-portfolio:",
    "platform:assistant:proposal-workspace",
    "platform:navigation:proposals",
  ],
  equipment_scope_review: [
    "selected-proposal:",
    "platform:event:",
    "platform:proposal:venue-room-fields",
    "platform:assistant:proposal-workspace",
  ],
  budget_estimation: [
    "selected-proposal:",
    "platform:proposal:final-fields",
    "platform:event:",
    "platform:assistant:proposal-workspace",
  ],
  historical_reference_request: [
    "selected-proposal:",
    "platform:assistant:proposal-workspace",
    "platform:assistant:scope",
  ],
  action_request: [
    "platform:assistant:scope",
    "platform:navigation:",
    "platform:proposal:",
  ],
  unsupported_or_off_topic: ["platform:assistant:scope"],
  ambiguous: ["platform:assistant:", "platform:navigation:", "platform:proposal:"],
};

export const evidenceAllowedForIntent = (
  evidenceId: string,
  intent: AssistantIntent,
): boolean =>
  allowedPlatformPrefixes[intent].some((prefix) =>
    evidenceId.startsWith(prefix),
  );

export const intentUsesOperatingGuidance = (
  intent: AssistantIntent,
): boolean =>
  [
    "proposal_review",
    "pre_send_checklist",
    "event_planning",
    "equipment_scope_review",
    "budget_estimation",
    "ambiguous",
  ].includes(intent);
