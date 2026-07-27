import {
  ASSISTANT_MESSAGE_LIST_MAX_LIMIT,
  ASSISTANT_KNOWLEDGE_MAX_RESULTS,
  ASSISTANT_THREAD_LIST_MAX_LIMIT,
  PlatformAssistantError,
  assertPlatformAssistantOrganizationAvailable,
  assertPlatformAssistantOrganizationEnabled,
  parseAssistantBeforeOrdinal,
  parseAssistantIdempotencyKey,
  parseAssistantListLimit,
  parseAssistantMessageInput,
  parseAssistantThreadId,
  parseCreateAssistantThreadInput,
  type PlatformAssistantContext,
} from "./domain";
import { platformFactsForQuery } from "./platformKnowledge";
import {
  buildAssistantPromptInput,
  validateAssistantProviderResponse,
} from "./prompt";
import type {
  GenerateAssistantGuidanceResult,
  PlatformAssistantGuidanceDependencies,
  PlatformAssistantRepository,
} from "./ports";

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
    input: { limit?: unknown; updatedBefore?: Date | null } = {},
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
    const { content } = parseAssistantMessageInput(input.body);
    const idempotencyKey = parseAssistantIdempotencyKey(input.idempotencyKey);
    const accepted = await repository.appendUserMessage({
      ...context,
      threadId,
      content,
      idempotencyKey,
    });
    const responseIdempotencyKey = `assistant-response:${accepted.message.id}`;
    const placeholder = await repository.createAssistantMessage({
      ...context,
      threadId,
      idempotencyKey: responseIdempotencyKey,
      status: "pending",
    });
    if (!placeholder.created) {
      return {
        userMessage: accepted.message,
        assistantMessage: placeholder.message,
        knowledge: { state: "not_requested" },
      };
    }

    let knowledge;
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
      const generated = await guidanceDependencies.responseProvider.generate(prompt);
      const validated = validateAssistantProviderResponse(
        generated,
        prompt.evidence,
      );
      const assistantMessage = await repository.updateAssistantMessage({
        ...context,
        threadId,
        messageId: placeholder.message.id,
        status: "complete",
        content: validated.content,
        citations: validated.citations,
        model: guidanceDependencies.responseProvider.model,
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
        await repository.updateAssistantMessage({
          ...context,
          threadId,
          messageId: placeholder.message.id,
          status: "failed",
          content: "",
          model: guidanceDependencies.responseProvider.model,
          safeErrorCode: safeCode,
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
