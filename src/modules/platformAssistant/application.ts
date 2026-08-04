import {
  ASSISTANT_MESSAGE_LIST_MAX_LIMIT,
  ASSISTANT_KNOWLEDGE_MAX_RESULTS,
  ASSISTANT_THREAD_LIST_MAX_LIMIT,
  PlatformAssistantError,
  assertPlatformAssistantOrganizationAvailable,
  assertPlatformAssistantOrganizationEnabled,
  parseAssistantBeforeOrdinal,
  parseAssistantFeedbackInput,
  parseAssistantIdempotencyKey,
  parseAssistantListLimit,
  parseAssistantMessageId,
  parseAssistantMessageInput,
  parseAssistantThreadId,
  parseCreateAssistantThreadInput,
  type AssistantKnowledgeStatus,
  type AssistantPromptEvidence,
  type PlatformAssistantContext,
} from "./domain";
import {
  platformFactsForConversation,
  platformFactsForUiContext,
} from "./platformKnowledge";
import {
  buildAssistantPromptInput,
  validateAssistantProviderResponse,
} from "./prompt";
import { resolveAssistantProposalContext } from "./proposalContext";
import {
  classifyAssistantIntent,
  evidenceAllowedForIntent,
  intentUsesOperatingGuidance,
} from "./intentRouter";
import type {
  GenerateAssistantGuidanceResult,
  PlatformAssistantGuidanceDependencies,
  PlatformAssistantRepository,
} from "./ports";
import {
  assistantProductAnalyticsEnabled,
  type AssistantClientProductEventInput,
  type AssistantProductEventInput,
} from "./productAnalytics";

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
    // Product analytics is non-authoritative and must not change chat,
    // feedback, or proposal behavior.
  }
};

export const createPlatformAssistantApplication = (
  repository: PlatformAssistantRepository,
  guidanceDependencies?: PlatformAssistantGuidanceDependencies,
) => ({
  createThread(
    context: PlatformAssistantContext,
    body: unknown,
    idempotencyKey: unknown,
  ) {
    assertPlatformAssistantOrganizationEnabled(context.organizationMongoId);
    return repository.createThread({
      ...context,
      ...parseCreateAssistantThreadInput(body),
      idempotencyKey: parseAssistantIdempotencyKey(idempotencyKey),
    });
  },

  listThreads(
    context: PlatformAssistantContext,
    input: {
      limit?: unknown;
      updatedBefore?: Date | null;
      deletionState?: "available" | "deleted";
    } = {},
  ) {
    assertPlatformAssistantOrganizationEnabled(context.organizationMongoId);
    return repository.listThreads({
      ...context,
      limit: parseAssistantListLimit(
        input.limit,
        ASSISTANT_THREAD_LIST_MAX_LIMIT,
        25,
      ),
      updatedBefore: input.updatedBefore,
      deletionState:
        input.deletionState === "deleted" ? "deleted" : "available",
    });
  },

  getThread(
    context: PlatformAssistantContext,
    input: {
      threadId: unknown;
      messageLimit?: unknown;
      beforeOrdinal?: unknown;
    },
  ) {
    assertPlatformAssistantOrganizationEnabled(context.organizationMongoId);
    return repository.getThread({
      ...context,
      threadId: parseAssistantThreadId(input.threadId),
      messageLimit: parseAssistantListLimit(
        input.messageLimit,
        ASSISTANT_MESSAGE_LIST_MAX_LIMIT,
        100,
      ),
      beforeOrdinal: parseAssistantBeforeOrdinal(input.beforeOrdinal),
    });
  },

  archiveThread(context: PlatformAssistantContext, threadId: unknown) {
    assertPlatformAssistantOrganizationEnabled(context.organizationMongoId);
    return repository.archiveThread({
      ...context,
      threadId: parseAssistantThreadId(threadId),
    });
  },

  deleteThreadPermanently(
    context: PlatformAssistantContext,
    threadId: unknown,
  ) {
    assertPlatformAssistantOrganizationEnabled(context.organizationMongoId);
    return repository.deleteThreadPermanently({
      ...context,
      threadId: parseAssistantThreadId(threadId),
    });
  },

  restoreThread(context: PlatformAssistantContext, threadId: unknown) {
    assertPlatformAssistantOrganizationEnabled(context.organizationMongoId);
    return repository.restoreThread({
      ...context,
      threadId: parseAssistantThreadId(threadId),
    });
  },

  async submitFeedback(
    context: PlatformAssistantContext,
    input: {
      threadId: unknown;
      messageId: unknown;
      body: unknown;
      idempotencyKey: unknown;
    },
  ) {
    // Feedback remains available when generation is killed so users can rate
    // already completed responses.
    assertPlatformAssistantOrganizationEnabled(context.organizationMongoId);
    const parsed = {
      ...context,
      threadId: parseAssistantThreadId(input.threadId),
      messageId: parseAssistantMessageId(input.messageId),
      ...parseAssistantFeedbackInput(input.body),
      idempotencyKey: parseAssistantIdempotencyKey(input.idempotencyKey),
    };
    const result = await repository.submitFeedback(parsed);
    await recordProductEventBestEffort(repository, context, {
      eventType: "feedback_submitted",
      threadId: parsed.threadId,
      messageId: parsed.messageId,
      feedbackValue: parsed.value,
      feedbackReason: parsed.reason,
      completionOutcome: "completed",
      idempotencyKey: `assistant-event:feedback:${parsed.idempotencyKey}`,
    });
    return result;
  },

  recordProductEvent(
    context: PlatformAssistantContext,
    input: AssistantClientProductEventInput,
    idempotencyKey: unknown,
  ) {
    assertPlatformAssistantOrganizationEnabled(context.organizationMongoId);
    if (
      !assistantProductAnalyticsEnabled() ||
      !repository.recordProductEvent
    ) {
      return Promise.resolve({ created: false });
    }
    return repository.recordProductEvent({
      ...context,
      ...input,
      idempotencyKey: parseAssistantIdempotencyKey(idempotencyKey),
    });
  },

  appendUserMessage(
    context: PlatformAssistantContext,
    input: { threadId: unknown; body: unknown; idempotencyKey: unknown },
  ) {
    assertPlatformAssistantOrganizationAvailable(context.organizationMongoId);
    return repository.appendUserMessage({
      ...context,
      threadId: parseAssistantThreadId(input.threadId),
      ...parseAssistantMessageInput(input.body),
      idempotencyKey: parseAssistantIdempotencyKey(input.idempotencyKey),
    });
  },

  async generateGuidance(
    context: PlatformAssistantContext,
    input: { threadId: unknown; body: unknown; idempotencyKey: unknown },
  ): Promise<GenerateAssistantGuidanceResult> {
    assertPlatformAssistantOrganizationAvailable(context.organizationMongoId);
    if (!guidanceDependencies) {
      throw new PlatformAssistantError(
        "AI_ASSISTANT_NOT_CONFIGURED",
        "The AI Assistant guidance service is not configured.",
        503,
      );
    }
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
    const responseIdempotencyKey = `assistant-response:${accepted.message.id}`;
    const placeholder = await repository.createAssistantMessage({
      ...context,
      threadId,
      idempotencyKey: responseIdempotencyKey,
      status: "pending",
      intent: preliminaryIntent,
    });
    if (!placeholder.created) {
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
        knowledge = await guidanceDependencies.knowledgeSource.retrieve({
          ...context,
          query: accepted.message.content,
          limit: ASSISTANT_KNOWLEDGE_MAX_RESULTS,
          idempotencyKey: `assistant-knowledge:${placeholder.message.id}`,
        });
      } catch (error) {
        knowledge = {
          status: {
            state: "unavailable" as const,
            safeCode: "ASSISTANT_KNOWLEDGE_UNAVAILABLE" as const,
            diagnosticCode:
              error && typeof error === "object" && "code" in error
                ? String((error as { code?: unknown }).code || "KNOWLEDGE_SOURCE_FAILED")
                : "KNOWLEDGE_SOURCE_FAILED",
          },
          evidence: [],
        };
      }
    }

    let selectedIntent = preliminaryIntent;
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
        source: guidanceDependencies.proposalContextSource,
        context,
        query: accepted.message.content,
        history: detail.messages,
        currentUserMessageId: accepted.message.id,
        intent: classifiedIntent,
      });
      const intent = proposalContext.intent;
      selectedIntent = intent;
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
      const generationStartedAt = Date.now();
      const generated =
        await guidanceDependencies.responseProvider.generate(prompt);
      const validated = validateAssistantProviderResponse(
        generated,
        prompt.evidence,
      );
      const completionLatencyMs = Math.min(
        Date.now() - generationStartedAt,
        3_600_000,
      );
      const assistantMessage = await repository.updateAssistantMessage({
        ...context,
        threadId,
        messageId: placeholder.message.id,
        status: "complete",
        content: validated.content,
        citations: validated.citations,
        model: guidanceDependencies.responseProvider.model,
        intent,
        responseKind: validated.kind,
        promptVersion: prompt.schemaVersion,
        knowledgeVersion: prompt.platformKnowledgeVersion,
        firstTokenMs: completionLatencyMs,
        completionLatencyMs,
      });
      await recordProductEventBestEffort(repository, context, {
        eventType: "first_token_received",
        threadId,
        messageId: assistantMessage.id,
        routeCategory: uiContext?.routeCategory ?? "other",
        intent: intent.intent,
        firstTokenMs: completionLatencyMs,
        idempotencyKey: `assistant-event:first-token:${assistantMessage.id}`,
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
      return {
        userMessage: accepted.message,
        assistantMessage,
        knowledge: knowledge.status,
      };
    } catch (error) {
      const safeCode =
        error instanceof PlatformAssistantError
          ? error.code
          : "ASSISTANT_PROVIDER_FAILED";
      try {
        const failed = await repository.updateAssistantMessage({
          ...context,
          threadId,
          messageId: placeholder.message.id,
          status: "failed",
          content: "",
          model: guidanceDependencies.responseProvider.model,
          safeErrorCode: safeCode,
          intent: selectedIntent,
        });
        await recordProductEventBestEffort(repository, context, {
          eventType: "response_failed",
          threadId,
          messageId: failed.id,
          routeCategory: uiContext?.routeCategory ?? "other",
          intent: selectedIntent.intent,
          errorCode: safeCode,
          completionOutcome: "failed",
          idempotencyKey: `assistant-event:response-failed:${failed.id}`,
        });
      } catch {
        // Preserve the original generation or validation failure.
      }
      if (error instanceof PlatformAssistantError) throw error;
      throw new PlatformAssistantError(
        "ASSISTANT_PROVIDER_FAILED",
        "The assistant could not complete the response.",
        502,
        true,
      );
    }
  },
});
