import {
  ASSISTANT_KNOWLEDGE_MAX_RESULTS,
  ASSISTANT_MESSAGE_LIST_MAX_LIMIT,
  ASSISTANT_RESPONSE_MAX_CHARACTERS,
  PlatformAssistantError,
  assertPlatformAssistantOrganizationAvailable,
  parseAssistantIdempotencyKey,
  parseAssistantMessageInput,
  parseAssistantThreadId,
  type AssistantKnowledgeStatus,
  type AssistantMessage,
  type AssistantPromptEvidence,
  type PlatformAssistantContext,
} from "./domain";
import {
  platformFactsForConversation,
  platformFactsForUiContext,
} from "./platformKnowledge";
import {
  buildAssistantPromptInput,
  normalizeConversationalAssistantResponse,
  validateAssistantProviderResponse,
} from "./prompt";
import { deterministicAssistantProvider } from "./deterministicAssistantProvider";
import { resolveAssistantProposalContext } from "./proposalContext";
import {
  classifyAssistantIntent,
  evidenceAllowedForIntent,
  intentUsesOperatingGuidance,
} from "./intentRouter";
import type {
  AssistantKnowledgeSource,
  AssistantProposalContextSource,
  AssistantResponseProvider,
  AssistantStreamingResponseProvider,
  PlatformAssistantRepository,
} from "./ports";
import {
  assistantProductAnalyticsEnabled,
  type AssistantProductEventInput,
} from "./productAnalytics";

export type AssistantProductStreamEvent =
  | {
      type: "message.accepted";
      version: 1;
      userMessage: AssistantMessage;
      assistantMessageId: string;
      correlationId: string;
    }
  | {
      type: "response.started";
      version: 1;
      assistantMessageId: string;
    }
  | {
      type: "response.delta";
      version: 1;
      assistantMessageId: string;
      delta: string;
    }
  | {
      type: "response.completed";
      version: 1;
      message: AssistantMessage;
      correlationId: string;
    }
  | {
      type: "response.failed";
      version: 1;
      assistantMessageId: string;
      code: string;
      message: string;
      retryable: boolean;
      retryAfterSeconds?: number;
      correlationId: string;
    };

export type StreamAssistantGuidanceResult = {
  userMessage: AssistantMessage;
  assistantMessage: AssistantMessage;
  knowledge: AssistantKnowledgeStatus;
};

type Emit = (
  event: AssistantProductStreamEvent,
) => void | Promise<void>;

const recordProductEventBestEffort = async (
  repository: PlatformAssistantRepository,
  context: PlatformAssistantContext,
  input: AssistantProductEventInput,
): Promise<void> => {
  if (
    !assistantProductAnalyticsEnabled() ||
    !repository.recordProductEvent
  ) {
    return;
  }
  try {
    await repository.recordProductEvent({ ...context, ...input });
  } catch {
    // Analytics must never change the response stream or persisted message.
  }
};

const unavailableKnowledge = (error: unknown) => ({
  status: {
    state: "unavailable" as const,
    safeCode: "ASSISTANT_KNOWLEDGE_UNAVAILABLE" as const,
    diagnosticCode:
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code || "KNOWLEDGE_SOURCE_FAILED")
        : "KNOWLEDGE_SOURCE_FAILED",
  },
  evidence: [],
});

const failureMessage = (code: string): string => {
  switch (code) {
    case "ASSISTANT_STREAM_ABORTED":
      return "The assistant response was stopped.";
    case "ASSISTANT_STREAM_INTERRUPTED":
      return "The assistant response was interrupted.";
    case "ASSISTANT_CONTEXT_TOO_LARGE":
      return "The assistant conversation is too large to process.";
    case "AI_ASSISTANT_CREDENTIAL_UNAVAILABLE":
      return "The AI Assistant provider credential is unavailable.";
    default:
      return "The assistant could not complete the response.";
  }
};

const SAFE_VALIDATION_FALLBACK =
  "I don’t have enough approved guidance to answer that reliably yet. Try asking about RFPilot navigation, proposals, proposal workflows, email, settings, vendor responses, or event-planning basics.";

export const createPlatformAssistantStreamingApplication = (
  repository: PlatformAssistantRepository,
  dependencies: {
    knowledgeSource: AssistantKnowledgeSource;
    responseProvider: AssistantStreamingResponseProvider;
    fallbackProvider?: AssistantResponseProvider;
    proposalContextSource?: AssistantProposalContextSource;
  },
) => ({
  async streamGuidance(
    context: PlatformAssistantContext,
    input: {
      threadId: unknown;
      body: unknown;
      idempotencyKey: unknown;
      responseIdempotencyKey?: unknown;
      signal: AbortSignal;
      emit: Emit;
    },
  ): Promise<StreamAssistantGuidanceResult> {
    assertPlatformAssistantOrganizationAvailable(context.organizationMongoId);
    const threadId = parseAssistantThreadId(input.threadId);
    const { content, uiContext } = parseAssistantMessageInput(input.body);
    const idempotencyKey = parseAssistantIdempotencyKey(input.idempotencyKey);
    const accepted = await repository.appendUserMessage({
      ...context,
      threadId,
      content,
      idempotencyKey,
    });
    await recordProductEventBestEffort(repository, context, {
      eventType: "message_submitted",
      threadId,
      messageId: accepted.message.id,
      routeCategory: uiContext?.routeCategory ?? "other",
      completionOutcome: "completed",
      idempotencyKey: `assistant-event:message-submitted:${accepted.message.id}`,
    });
    const preliminaryIntent = classifyAssistantIntent({
      query: accepted.message.content,
      uiContext,
    });
    const responseIdempotencyKey =
      input.responseIdempotencyKey === undefined
        ? `assistant-response:${accepted.message.id}`
        : parseAssistantIdempotencyKey(input.responseIdempotencyKey);
    const placeholder = await repository.createAssistantMessage({
      ...context,
      threadId,
      idempotencyKey: responseIdempotencyKey,
      status: "pending",
      intent: preliminaryIntent,
    });

    await input.emit({
      type: "message.accepted",
      version: 1,
      userMessage: accepted.message,
      assistantMessageId: placeholder.message.id,
      correlationId: context.correlationId,
    });

    if (!placeholder.created) {
      if (placeholder.message.status === "complete") {
        await input.emit({
          type: "response.completed",
          version: 1,
          message: placeholder.message,
          correlationId: context.correlationId,
        });
      } else {
        const inProgress = ["pending", "streaming"].includes(
          placeholder.message.status,
        );
        await input.emit({
          type: "response.failed",
          version: 1,
          assistantMessageId: placeholder.message.id,
          code: inProgress
            ? "ASSISTANT_REQUEST_IN_PROGRESS"
            : placeholder.message.safeErrorCode || "ASSISTANT_PROVIDER_FAILED",
          message: inProgress
            ? "This assistant response is already in progress."
            : failureMessage(
                placeholder.message.safeErrorCode ||
                  "ASSISTANT_PROVIDER_FAILED",
              ),
          retryable: inProgress,
          ...(inProgress ? { retryAfterSeconds: 2 } : {}),
          correlationId: context.correlationId,
        });
      }
      return {
        userMessage: accepted.message,
        assistantMessage: placeholder.message,
        knowledge: { state: "not_requested" },
      };
    }

    let knowledge: {
      status: AssistantKnowledgeStatus;
      evidence: AssistantPromptEvidence[];
    } = {
      status: { state: "not_requested" as const },
      evidence: [],
    };
    if (intentUsesOperatingGuidance(preliminaryIntent.intent)) {
      try {
        knowledge = await dependencies.knowledgeSource.retrieve({
          ...context,
          query: accepted.message.content,
          limit: ASSISTANT_KNOWLEDGE_MAX_RESULTS,
          idempotencyKey: `assistant-knowledge:${placeholder.message.id}`,
        });
      } catch (error) {
        knowledge = unavailableKnowledge(error);
      }
    }

    let intent = preliminaryIntent;
    let assistantMessage = placeholder.message;
    let accumulated = "";
    let providerResponseId: string | null = null;
    let effectiveModel = dependencies.responseProvider.model;
    let started = false;
    let streamingPersisted = false;
    const responseStartedAt = Date.now();
    let promptVersion: string | null = null;
    let knowledgeVersion: string | null = null;
    let firstTokenMs: number | null = null;
    const elapsedMs = () =>
      Math.min(Date.now() - responseStartedAt, 3_600_000);

    const persistFailure = async (inputFailure: {
      code: string;
      message?: string;
      retryable?: boolean;
      retryAfterSeconds?: number;
      aborted?: boolean;
    }): Promise<StreamAssistantGuidanceResult> => {
      const aborted = Boolean(inputFailure.aborted || input.signal.aborted);
      const code =
        accumulated && !aborted
          ? "ASSISTANT_STREAM_INTERRUPTED"
          : aborted
            ? "ASSISTANT_STREAM_ABORTED"
            : inputFailure.code;
      const status = aborted ? "aborted" : "failed";
      try {
        assistantMessage = await repository.updateAssistantMessage({
          ...context,
          threadId,
          messageId: placeholder.message.id,
          status,
          content: accumulated,
          providerResponseId,
          model: effectiveModel,
          safeErrorCode: code,
          intent,
          promptVersion,
          knowledgeVersion,
          firstTokenMs,
          completionLatencyMs: elapsedMs(),
        });
      } catch {
        // Preserve the safe stream failure even if terminal persistence is
        // temporarily unavailable. The pending row remains recoverable.
      }
      await recordProductEventBestEffort(repository, context, {
        eventType: "response_failed",
        threadId,
        messageId: placeholder.message.id,
        routeCategory: uiContext?.routeCategory ?? "other",
        intent: intent.intent,
        errorCode: code,
        completionOutcome: aborted ? "aborted" : "failed",
        idempotencyKey: `assistant-event:response-failed:${placeholder.message.id}`,
      });
      await input.emit({
        type: "response.failed",
        version: 1,
        assistantMessageId: placeholder.message.id,
        code,
        message:
          accumulated && !aborted
            ? failureMessage("ASSISTANT_STREAM_INTERRUPTED")
            : inputFailure.message || failureMessage(code),
        retryable:
          accumulated && !aborted
            ? true
            : Boolean(inputFailure.retryable && !aborted),
        ...(inputFailure.retryAfterSeconds && !aborted
          ? { retryAfterSeconds: inputFailure.retryAfterSeconds }
          : {}),
        correlationId: context.correlationId,
      });
      return {
        userMessage: accepted.message,
        assistantMessage,
        knowledge: knowledge.status,
      };
    };

    if (input.signal.aborted) {
      return persistFailure({
        code: "ASSISTANT_STREAM_ABORTED",
        aborted: true,
      });
    }

    try {
      const detail = await repository.getThread({
        ...context,
        threadId,
        messageLimit: ASSISTANT_MESSAGE_LIST_MAX_LIMIT,
        beforeOrdinal: null,
      });
      const classifiedIntent = classifyAssistantIntent({
        query: accepted.message.content,
        uiContext,
        history: detail.messages,
        currentUserMessageId: accepted.message.id,
      });
      const proposalContext = await resolveAssistantProposalContext({
        source: dependencies.proposalContextSource,
        context,
        query: accepted.message.content,
        history: detail.messages,
        currentUserMessageId: accepted.message.id,
        intent: classifiedIntent,
      });
      intent = proposalContext.intent;
      const prompt = buildAssistantPromptInput({
        userMessage: accepted.message,
        history: detail.messages,
        platformFacts: [
          ...platformFactsForUiContext(uiContext),
          ...platformFactsForConversation(
            accepted.message.content,
            detail.messages,
            accepted.message.id,
          ),
        ].filter((item) => evidenceAllowedForIntent(item.id, intent.intent)),
        operatingGuidance: intentUsesOperatingGuidance(intent.intent)
          ? knowledge.evidence
          : [],
        proposalEvidence: proposalContext.evidence,
        uiContext,
        intent,
      });
      promptVersion = prompt.schemaVersion;
      knowledgeVersion = prompt.platformKnowledgeVersion;
      const completeValidationFallback = async () => {
        let validated;
        const fallbackProvider =
          dependencies.fallbackProvider ?? deterministicAssistantProvider;
        try {
          validated = validateAssistantProviderResponse(
            normalizeConversationalAssistantResponse(
              await fallbackProvider.generate(prompt),
              accepted.message.content,
            ),
            prompt.evidence,
          );
          effectiveModel = fallbackProvider.model;
        } catch {
          validated = validateAssistantProviderResponse(
            {
              kind: "abstention",
              content: SAFE_VALIDATION_FALLBACK,
              citationIds: [],
            },
            prompt.evidence,
          );
          effectiveModel = "platform-assistant-safe-fallback-v1";
        }
        providerResponseId = null;
        if (!started) {
          started = true;
          await input.emit({
            type: "response.started",
            version: 1,
            assistantMessageId: placeholder.message.id,
          });
        }
        if (!streamingPersisted) {
          assistantMessage = await repository.updateAssistantMessage({
            ...context,
            threadId,
            messageId: placeholder.message.id,
            status: "streaming",
            content: "",
            providerResponseId,
            model: effectiveModel,
            intent,
          });
          streamingPersisted = true;
        }
        if (!accumulated) {
          accumulated = validated.content;
          firstTokenMs ??= elapsedMs();
          await input.emit({
            type: "response.delta",
            version: 1,
            assistantMessageId: placeholder.message.id,
            delta: accumulated,
          });
          await recordProductEventBestEffort(repository, context, {
            eventType: "first_token_received",
            threadId,
            messageId: placeholder.message.id,
            routeCategory: uiContext?.routeCategory ?? "other",
            intent: intent.intent,
            firstTokenMs,
            idempotencyKey: `assistant-event:first-token:${placeholder.message.id}`,
          });
        } else {
          accumulated = validated.content;
        }
        assistantMessage = await repository.updateAssistantMessage({
          ...context,
          threadId,
          messageId: placeholder.message.id,
          status: "complete",
          content: accumulated,
          citations: validated.citations,
          providerResponseId,
          model: effectiveModel,
          intent,
          responseKind: validated.kind,
          promptVersion,
          knowledgeVersion,
          firstTokenMs,
          completionLatencyMs: elapsedMs(),
        });
        await recordProductEventBestEffort(repository, context, {
          eventType: "response_completed",
          threadId,
          messageId: assistantMessage.id,
          routeCategory: uiContext?.routeCategory ?? "other",
          intent: intent.intent,
          responseKind: validated.kind,
          completionOutcome: "completed",
          idempotencyKey: `assistant-event:response-completed:${assistantMessage.id}`,
        });
        await input.emit({
          type: "response.completed",
          version: 1,
          message: assistantMessage,
          correlationId: context.correlationId,
        });
        return {
          userMessage: accepted.message,
          assistantMessage,
          knowledge: knowledge.status,
        };
      };

      for await (const event of dependencies.responseProvider.stream(prompt, {
        context,
        assistantMessageId: placeholder.message.id,
        signal: input.signal,
      })) {
        if (event.type === "started") {
          providerResponseId = event.providerResponseId || providerResponseId;
          effectiveModel = event.model || effectiveModel;
          if (!started) {
            started = true;
            await input.emit({
              type: "response.started",
              version: 1,
              assistantMessageId: placeholder.message.id,
            });
          }
          continue;
        }

        if (event.type === "text_delta") {
          const receivedFirstToken = firstTokenMs === null;
          firstTokenMs ??= elapsedMs();
          if (!streamingPersisted) {
            assistantMessage = await repository.updateAssistantMessage({
              ...context,
              threadId,
              messageId: placeholder.message.id,
              status: "streaming",
              content: "",
              providerResponseId,
              model: effectiveModel,
              intent,
              promptVersion,
              knowledgeVersion,
              firstTokenMs,
            });
            streamingPersisted = true;
          }
          if (receivedFirstToken) {
            await recordProductEventBestEffort(repository, context, {
              eventType: "first_token_received",
              threadId,
              messageId: placeholder.message.id,
              routeCategory: uiContext?.routeCategory ?? "other",
              intent: intent.intent,
              firstTokenMs,
              idempotencyKey: `assistant-event:first-token:${placeholder.message.id}`,
            });
          }
          accumulated += event.delta;
          if (accumulated.length > ASSISTANT_RESPONSE_MAX_CHARACTERS) {
            throw new PlatformAssistantError(
              "ASSISTANT_RESPONSE_INVALID",
              "The assistant response exceeded the output boundary.",
              502,
            );
          }
          await input.emit({
            type: "response.delta",
            version: 1,
            assistantMessageId: placeholder.message.id,
            delta: event.delta,
          });
          continue;
        }

        if (event.type === "failed") {
          providerResponseId =
            event.providerResponseId || providerResponseId;
          effectiveModel = event.model || effectiveModel;
          if (
            event.code === "ASSISTANT_RESPONSE_INVALID" &&
            !input.signal.aborted
          ) {
            return completeValidationFallback();
          }
          return persistFailure(event);
        }

        providerResponseId = event.providerResponseId;
        effectiveModel = event.model;
        const validated = validateAssistantProviderResponse(
          normalizeConversationalAssistantResponse(
            event.output,
            accepted.message.content,
          ),
          prompt.evidence,
        );
        if (validated.content !== accumulated) {
          throw new PlatformAssistantError(
            "ASSISTANT_RESPONSE_INVALID",
            "The completed response did not match the streamed content.",
            502,
          );
        }
        assistantMessage = await repository.updateAssistantMessage({
          ...context,
          threadId,
          messageId: placeholder.message.id,
          status: "complete",
          content: validated.content,
          citations: validated.citations,
          providerResponseId,
          model: effectiveModel,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          intent,
          responseKind: validated.kind,
          promptVersion,
          knowledgeVersion,
          firstTokenMs,
          completionLatencyMs: elapsedMs(),
        });
        await recordProductEventBestEffort(repository, context, {
          eventType: "response_completed",
          threadId,
          messageId: assistantMessage.id,
          routeCategory: uiContext?.routeCategory ?? "other",
          intent: intent.intent,
          responseKind: validated.kind,
          completionOutcome: "completed",
          idempotencyKey: `assistant-event:response-completed:${assistantMessage.id}`,
        });
        await input.emit({
          type: "response.completed",
          version: 1,
          message: assistantMessage,
          correlationId: context.correlationId,
        });
        return {
          userMessage: accepted.message,
          assistantMessage,
          knowledge: knowledge.status,
        };
      }

      return persistFailure({
        code: accumulated
          ? "ASSISTANT_STREAM_INTERRUPTED"
          : "ASSISTANT_PROVIDER_FAILED",
        retryable: true,
      });
    } catch (error) {
      const known = error instanceof PlatformAssistantError ? error : null;
      return persistFailure({
        code: known?.code || "ASSISTANT_PROVIDER_FAILED",
        message: known?.message,
        retryable: known?.retryable ?? false,
        aborted: input.signal.aborted,
      });
    }
  },
});
