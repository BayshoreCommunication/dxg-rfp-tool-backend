import {
  ASSISTANT_KNOWLEDGE_MAX_RESULTS,
  ASSISTANT_MESSAGE_LIST_MAX_LIMIT,
  ASSISTANT_RESPONSE_MAX_CHARACTERS,
  PlatformAssistantError,
  assertPlatformAssistantAvailable,
  parseAssistantIdempotencyKey,
  parseAssistantMessageInput,
  parseAssistantThreadId,
  type AssistantKnowledgeStatus,
  type AssistantMessage,
  type PlatformAssistantContext,
} from "./domain";
import { platformFactsForQuery } from "./platformKnowledge";
import {
  buildAssistantPromptInput,
  validateAssistantProviderResponse,
} from "./prompt";
import type {
  AssistantKnowledgeSource,
  AssistantStreamingResponseProvider,
  PlatformAssistantRepository,
} from "./ports";

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

export const createPlatformAssistantStreamingApplication = (
  repository: PlatformAssistantRepository,
  dependencies: {
    knowledgeSource: AssistantKnowledgeSource;
    responseProvider: AssistantStreamingResponseProvider;
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
    assertPlatformAssistantAvailable();
    const threadId = parseAssistantThreadId(input.threadId);
    const { content } = parseAssistantMessageInput(input.body);
    const idempotencyKey = parseAssistantIdempotencyKey(input.idempotencyKey);
    const accepted = await repository.appendUserMessage({
      ...context,
      threadId,
      content,
      idempotencyKey,
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

    let knowledge;
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

    let assistantMessage = placeholder.message;
    let accumulated = "";
    let providerResponseId: string | null = null;
    let effectiveModel = dependencies.responseProvider.model;
    let started = false;
    let streamingPersisted = false;

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
        });
      } catch {
        // Preserve the safe stream failure even if terminal persistence is
        // temporarily unavailable. The pending row remains recoverable.
      }
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
      const prompt = buildAssistantPromptInput({
        userMessage: accepted.message,
        history: detail.messages,
        platformFacts: platformFactsForQuery(accepted.message.content),
        operatingGuidance: knowledge.evidence,
      });

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
          if (!streamingPersisted) {
            assistantMessage = await repository.updateAssistantMessage({
              ...context,
              threadId,
              messageId: placeholder.message.id,
              status: "streaming",
              content: "",
              providerResponseId,
              model: effectiveModel,
            });
            streamingPersisted = true;
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
          return persistFailure(event);
        }

        providerResponseId = event.providerResponseId;
        effectiveModel = event.model;
        const validated = validateAssistantProviderResponse(
          event.output,
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
