import { PlatformAssistantError, assertPlatformAssistantAvailable } from "./domain";

const integer = (
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
};

const reasoningEfforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AssistantReasoningEffort = (typeof reasoningEfforts)[number];

const reasoningEffort = (): AssistantReasoningEffort => {
  const configured = String(process.env.AI_ASSISTANT_REASONING_EFFORT || "none");
  return reasoningEfforts.includes(configured as AssistantReasoningEffort)
    ? (configured as AssistantReasoningEffort)
    : "none";
};

export type AssistantRuntimeConfig = {
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  heartbeatMs: number;
  providerMaxAttempts: number;
  requestsPerWindow: number;
  organizationRequestsPerWindow: number;
  rateWindowMs: number;
  maxActiveStreamsPerUser: number;
  maxActiveStreamsPerOrganization: number;
  activeLeaseMs: number;
  reasoningEffort: AssistantReasoningEffort;
  textVerbosity: "low" | "medium";
};

export const assistantRuntimeConfig = (): AssistantRuntimeConfig => ({
  // Preserve the already approved live-AI model unless an assistant-specific
  // release is selected explicitly. Model evaluation and promotion are Phase 5.
  model: String(
    process.env.AI_ASSISTANT_MODEL ||
      process.env.LIVE_AI_MODEL ||
      "gpt-5.4-mini-2026-03-17",
  ).trim(),
  maxInputTokens: integer("AI_ASSISTANT_MAX_INPUT_TOKENS", 12_000, 1_000, 100_000),
  maxOutputTokens: integer("AI_ASSISTANT_MAX_OUTPUT_TOKENS", 1_200, 128, 4_000),
  timeoutMs: integer("AI_ASSISTANT_STREAM_TIMEOUT_MS", 45_000, 5_000, 120_000),
  heartbeatMs: integer("AI_ASSISTANT_HEARTBEAT_MS", 15_000, 5_000, 30_000),
  providerMaxAttempts: integer("AI_ASSISTANT_PROVIDER_MAX_ATTEMPTS", 2, 1, 3),
  requestsPerWindow: integer(
    "AI_ASSISTANT_REQUESTS_PER_15_MINUTES",
    30,
    1,
    1_000,
  ),
  organizationRequestsPerWindow: integer(
    "AI_ASSISTANT_ORG_REQUESTS_PER_15_MINUTES",
    300,
    1,
    10_000,
  ),
  rateWindowMs: 15 * 60_000,
  maxActiveStreamsPerUser: integer(
    "AI_ASSISTANT_MAX_ACTIVE_STREAMS_PER_USER",
    1,
    1,
    10,
  ),
  maxActiveStreamsPerOrganization: integer(
    "AI_ASSISTANT_MAX_ACTIVE_STREAMS_PER_ORG",
    20,
    1,
    500,
  ),
  activeLeaseMs: integer(
    "AI_ASSISTANT_ACTIVE_STREAM_LEASE_MS",
    120_000,
    10_000,
    300_000,
  ),
  reasoningEffort: reasoningEffort(),
  textVerbosity:
    process.env.AI_ASSISTANT_TEXT_VERBOSITY === "medium" ? "medium" : "low",
});

export const assertAssistantProviderConfigured = (): {
  apiKey: string;
  safetyIdentifierSecret: string;
  config: AssistantRuntimeConfig;
} => {
  assertPlatformAssistantAvailable();
  if (
    process.env.LIVE_AI_PILOT_ENABLED !== "true" ||
    process.env.LIVE_AI_PROVIDER !== "openai"
  ) {
    throw new PlatformAssistantError(
      "AI_ASSISTANT_PROVIDER_UNAVAILABLE",
      "The AI Assistant provider is not enabled.",
      503,
    );
  }
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  const safetyIdentifierSecret = String(
    process.env.AI_SAFETY_IDENTIFIER_SECRET || "",
  );
  if (!apiKey || safetyIdentifierSecret.length < 32) {
    throw new PlatformAssistantError(
      "AI_ASSISTANT_CREDENTIAL_UNAVAILABLE",
      "The AI Assistant provider credential is unavailable.",
      503,
    );
  }
  return { apiKey, safetyIdentifierSecret, config: assistantRuntimeConfig() };
};
