import type { QueueMessage } from "./domain";
import { proposalDraftRepository } from "../proposalDraft/postgresProposalDraftRepository";
import {
  continueTrace,
  observe,
  pseudonym,
  safeErrorCode,
  safeLog,
  telemetryMetrics,
} from "../../shared/observability/safeTelemetry";

export const handleProposalDraft = async (message: QueueMessage) =>
  continueTrace(message.traceparent, async () => {
    const started = Date.now();
    const labels = {
      jobId: message.jobId,
      runId: message.inputReference,
      jobType: message.jobType,
      correlationId: message.correlationId,
      organizationPseudonym: pseudonym(message.organizationMongoId),
    };
    safeLog("info", "job.execution.started", labels);
    try {
      const result = await observe(
        "job.proposal_draft",
        { jobType: message.jobType },
        () =>
          proposalDraftRepository.execute({
            organizationMongoId: message.organizationMongoId,
            actorUserMongoId: message.actorUserMongoId,
            runId: message.inputReference,
          }),
      );
      const durationMs = Date.now() - started;
      safeLog("info", "job.execution.completed", {
        ...labels,
        outcome: "success",
        durationMs,
      });
      telemetryMetrics.job("success", durationMs, {
        jobType: message.jobType,
      });
      return result;
    } catch (error) {
      const errorCode = safeErrorCode(error);
      const retryable = Boolean((error as { retryable?: boolean }).retryable);
      const durationMs = Date.now() - started;
      safeLog("error", "job.execution.failed", {
        ...labels,
        outcome: "failure",
        errorCode,
        retryable,
        durationMs,
      });
      telemetryMetrics.job("failure", durationMs, {
        jobType: message.jobType,
        errorCode,
        retryable,
      });
      // Domain settlement belongs to the durable worker, which knows whether a
      // retry remains. Marking the run here made the first temporary provider
      // failure look terminal and overwrote the explicit conflict state.
      throw error;
    }
  });
