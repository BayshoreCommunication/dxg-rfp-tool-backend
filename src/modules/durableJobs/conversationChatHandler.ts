import { buildChatReply } from "../conversations/chatReply";
import { ConversationError } from "../conversations/domain";
import { conversationRepository } from "../conversations/postgresConversationRepository";
import {
  continueTrace,
  observe,
  pseudonym,
  safeErrorCode,
  safeLog,
  telemetryMetrics,
} from "../../shared/observability/safeTelemetry";
import type { QueueMessage } from "./domain";

// A chat generation is an addressable durable job. The user message and the
// pending assistant placeholder were committed before this handler can run;
// this worker only computes and settles that existing placeholder.
export const handleConversationChat = async (message: QueueMessage) =>
  continueTrace(message.traceparent, async () => {
    const started = Date.now();
    const labels = {
      jobId: message.jobId,
      jobType: message.jobType,
      correlationId: message.correlationId,
      organizationPseudonym: pseudonym(message.organizationMongoId),
    };
    safeLog("info", "job.execution.started", labels);
    try {
      return await observe("job.conversation_chat", { jobType: message.jobType }, async () => {
        const ctx = {
          organizationMongoId: message.organizationMongoId,
          actorUserMongoId: message.actorUserMongoId,
          correlationId: message.correlationId,
        };
        const job = await conversationRepository.readChatJob({
          ...ctx,
          jobId: message.jobId,
          userMessageId: message.inputReference,
        });
        if (job.status === "complete") {
          return { resultReference: job.assistantMessageId, status: "complete" };
        }
        const reply = await buildChatReply(
          ctx,
          job.proposalMongoId,
          job.organizationId,
          message.jobId,
        );
        const completed = await conversationRepository.completeChatJob({
          ...ctx,
          jobId: message.jobId,
          content: reply.reply,
          actions: reply.actions,
        });
        const durationMs = Date.now() - started;
        safeLog("info", "job.execution.completed", {
          ...labels,
          runId: message.jobId,
          outcome: "success",
          durationMs,
        });
        telemetryMetrics.job("success", durationMs, { jobType: message.jobType });
        return { resultReference: completed.id, status: "complete" };
      });
    } catch (error) {
      const errorCode = safeErrorCode(error);
      const durationMs = Date.now() - started;
      safeLog("error", "job.execution.failed", {
        ...labels,
        outcome: "failure",
        errorCode,
        durationMs,
      });
      telemetryMetrics.job("failure", durationMs, { jobType: message.jobType, errorCode });

      // Provider errors carry their own retry decision. Unknown errors from
      // Mongo/Postgres are treated as transient infrastructure failures, while
      // explicit conversation validation/ownership failures are terminal.
      if (
        !(error instanceof ConversationError) &&
        error &&
        typeof error === "object" &&
        !("retryable" in error)
      ) {
        Object.assign(error, { retryable: true, code: errorCode || "CONVERSATION_CHAT_INFRASTRUCTURE_FAILED" });
      }
      throw error;
    }
  });
