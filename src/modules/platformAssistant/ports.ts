import type {
  AssistantCitation,
  AssistantKnowledgeStatus,
  AssistantMessage,
  AssistantPromptEvidence,
  AssistantPromptInput,
  AssistantMessageStatus,
  AssistantThread,
  AssistantThreadDetail,
  PlatformAssistantContext,
} from "./domain";

export type CreateAssistantThreadResult = {
  created: boolean;
  thread: AssistantThread;
};

export type AppendAssistantMessageResult = {
  created: boolean;
  message: AssistantMessage;
};

export type AssistantKnowledgeResult = {
  status: Exclude<AssistantKnowledgeStatus, { state: "not_requested" }>;
  evidence: AssistantPromptEvidence[];
};

export interface AssistantKnowledgeSource {
  retrieve(
    input: PlatformAssistantContext & {
      query: string;
      limit: number;
      idempotencyKey: string;
    },
  ): Promise<AssistantKnowledgeResult>;
}

export interface AssistantResponseProvider {
  readonly provider: string;
  readonly model: string;
  generate(input: AssistantPromptInput): Promise<unknown>;
}

export type AssistantProviderUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type AssistantProviderEvent =
  | {
      type: "started";
      providerResponseId: string;
      model: string;
    }
  | {
      type: "text_delta";
      delta: string;
    }
  | {
      type: "completed";
      providerResponseId: string;
      model: string;
      usage: AssistantProviderUsage;
      output: unknown;
    }
  | {
      type: "failed";
      providerResponseId: string | null;
      model: string;
      code: string;
      message: string;
      retryable: boolean;
      retryAfterSeconds?: number;
      aborted?: boolean;
    };

export interface AssistantStreamingResponseProvider {
  readonly provider: string;
  readonly model: string;
  stream(
    input: AssistantPromptInput,
    options: {
      context: PlatformAssistantContext;
      assistantMessageId: string;
      signal: AbortSignal;
    },
  ): AsyncIterable<AssistantProviderEvent>;
}

export type PlatformAssistantGuidanceDependencies = {
  knowledgeSource: AssistantKnowledgeSource;
  responseProvider: AssistantResponseProvider;
};

export type GenerateAssistantGuidanceResult = {
  userMessage: AssistantMessage;
  assistantMessage: AssistantMessage;
  knowledge: AssistantKnowledgeStatus;
};

export interface PlatformAssistantRepository {
  createThread(
    input: PlatformAssistantContext & {
      title: string;
      idempotencyKey: string;
    },
  ): Promise<CreateAssistantThreadResult>;

  listThreads(
    input: PlatformAssistantContext & {
      limit: number;
      updatedBefore?: Date | null;
    },
  ): Promise<AssistantThread[]>;

  getThread(
    input: PlatformAssistantContext & {
      threadId: string;
      messageLimit: number;
      beforeOrdinal?: number | null;
    },
  ): Promise<AssistantThreadDetail>;

  archiveThread(
    input: PlatformAssistantContext & {
      threadId: string;
    },
  ): Promise<AssistantThread>;

  appendUserMessage(
    input: PlatformAssistantContext & {
      threadId: string;
      content: string;
      idempotencyKey: string;
    },
  ): Promise<AppendAssistantMessageResult>;

  createAssistantMessage(
    input: PlatformAssistantContext & {
      threadId: string;
      idempotencyKey: string;
      content?: string;
      status?: Extract<AssistantMessageStatus, "pending" | "complete">;
    },
  ): Promise<AppendAssistantMessageResult>;

  updateAssistantMessage(
    input: PlatformAssistantContext & {
      threadId: string;
      messageId: string;
      status: AssistantMessageStatus;
      content: string;
      citations?: AssistantCitation[];
      providerResponseId?: string | null;
      model?: string | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
      safeErrorCode?: string | null;
    },
  ): Promise<AssistantMessage>;
}
