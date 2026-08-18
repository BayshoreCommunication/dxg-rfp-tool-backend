import type { QueueMessage } from "./domain";
import { proposalContextRepository } from "../proposalContext/postgresProposalContextRepository";
import { autoApplyConversationContextRun } from "../conversations/conversationAutoApply";
import { safeLog } from "../../shared/observability/safeTelemetry";

export const handleProposalContext = async (message: QueueMessage) => {
  try {
    const result = await proposalContextRepository.execute({
      organizationMongoId: message.organizationMongoId,
      actorUserMongoId: message.actorUserMongoId,
      runId: message.inputReference,
      correlationId: message.correlationId,
    });

    // Extraction remains independently recoverable. If unattended application
    // cannot complete, keep the succeeded run and its reviewable candidates
    // instead of turning a good TXT/PDF/DOC-style extraction into a failed job.
    try {
      await autoApplyConversationContextRun({
        organizationMongoId: message.organizationMongoId,
        actorUserMongoId: message.actorUserMongoId,
        runId: message.inputReference,
        correlationId: message.correlationId,
      });
    } catch (error) {
      safeLog("warn", "conversation_fields_auto_apply_failed", {
        outcome: "failure",
        operation: "proposal_context",
        errorCode:
          (error as { code?: string } | null)?.code ?? "UNKNOWN",
      });
    }
    return result;
  } catch (error) {
    const code = String(
      (error as { code?: string }).code || "CONTEXT_EXTRACTION_FAILED",
    );
    await proposalContextRepository.markFailed({
      organizationMongoId: message.organizationMongoId,
      actorUserMongoId: message.actorUserMongoId,
      runId: message.inputReference,
      correlationId: message.correlationId,
      code,
    });
    throw error;
  }
};
