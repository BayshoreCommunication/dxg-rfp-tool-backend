import crypto from "node:crypto";
import { Worker, type Job } from "bullmq";
import type { JobRepository } from "./jobRepository";
import type { QueueMessage } from "./domain";
import { redisConnection } from "./redis";
import { SOURCE_SECURITY_QUEUE } from "./queue";
import { handleSourceSecurity } from "./sourceSecurityHandler";
import { CHAT_PROVIDER_UNAVAILABLE_REPLY } from "../conversations/chatReply";
import { handleKnowledgeParse } from "./knowledgeParseHandler";
import { handleKnowledgeIndex } from "./knowledgeIndexHandler";
import { handleProposalContext } from "./proposalContextHandler";
import { handleCandidateApplication } from "./candidateApplicationHandler";
import { handleProposalDraft } from "./proposalDraftHandler";
import { handleVendorAnalysis } from "./vendorAnalysisHandler";
import { handleEvidenceExtraction } from "./evidenceExtractionHandler";
import { handleVendorIntelligence } from "./vendorIntelligenceHandler";
import { handleComparisonAggregate, handleComparisonParticipant } from "./comparisonOrchestrationHandler";
import { handleConversationChat } from "./conversationChatHandler";
import { conversationRepository } from "../conversations/postgresConversationRepository";
import { comparisonOrchestrationRepository } from "../comparisonOrchestration/postgresComparisonOrchestrationRepository";
import { vendorIntelligenceRepository } from "../vendorIntelligence/postgresVendorIntelligenceRepository";
import { proposalDraftRepository } from "../proposalDraft/postgresProposalDraftRepository";
import { PROVIDER_UNAVAILABLE_CODES } from "../liveAi/openAiProvider";
import { pseudonym, safeErrorCode, safeLog } from "../../shared/observability/safeTelemetry";

const stageFor = (type: QueueMessage["jobType"]) => ({
  knowledge_parse: "deterministic_parse",
  knowledge_index_release: "knowledge_index",
  proposal_context_extract: "proposal_context",
  candidate_application: "candidate_application",
  proposal_draft_generate: "proposal_draft",
  vendor_response_analyze: "vendor_analysis",
  vendor_source_extract: "evidence_extraction",
  vendor_requirement_facts: "vendor_requirement_facts",
  comparison_participant_snapshot: "comparison_participant_snapshot",
  comparison_aggregate: "comparison_aggregate",
  conversation_chat: "conversation_chat",
  source_security_scan: "security_scan",
  ai_gateway_test: "unsupported",
})[type] ?? "unsupported";

const execute = (
  message: QueueMessage,
  onProgress?: (progress: number, stage: string) => Promise<void> | void,
) => {
  const vendorAnalysisJob = message.jobType==="vendor_response_analyze";
  if (message.jobType === "knowledge_parse") return handleKnowledgeParse(message);
  if (message.jobType === "knowledge_index_release") return handleKnowledgeIndex(message);
  if (message.jobType === "proposal_context_extract") return handleProposalContext(message);
  if (message.jobType === "candidate_application") return handleCandidateApplication(message);
  if (message.jobType === "proposal_draft_generate") return handleProposalDraft(message);
  if (vendorAnalysisJob) return handleVendorAnalysis(message);
  if (message.jobType === "vendor_source_extract") return handleEvidenceExtraction(message);
  if (message.jobType === "vendor_requirement_facts") return handleVendorIntelligence(message, onProgress);
  if (message.jobType === "comparison_participant_snapshot") return handleComparisonParticipant(message);
  if (message.jobType === "comparison_aggregate") return handleComparisonAggregate(message);
  if (message.jobType === "conversation_chat") return handleConversationChat(message);
  if (message.jobType === "source_security_scan") return handleSourceSecurity(message);
  return Promise.reject(Object.assign(new Error("Unsupported durable job type"), { code: "UNSUPPORTED_JOB_TYPE", retryable: false }));
};

export const leaseHeartbeatIntervalMs = (leaseSeconds: number) =>
  Math.max(1_000, Math.floor(leaseSeconds * 1_000 / 3));

const settleComparison = (message: QueueMessage) => comparisonOrchestrationRepository.onJobSettled({
  organizationMongoId: message.organizationMongoId,
  actorUserMongoId: message.actorUserMongoId,
  jobId: message.jobId,
}).catch(() => undefined);

export const createSourceSecurityWorker = (repository: JobRepository) => {
  const workerId = `source-security-${crypto.randomUUID()}`;
  const leaseSeconds = Number(process.env.JOB_LEASE_SECONDS || 90);
  const maxAttempts = Number(process.env.JOB_MAX_ATTEMPTS || 5);
  return new Worker<QueueMessage>(SOURCE_SECURITY_QUEUE, async (job: Job<QueueMessage>) => {
    const attempt = job.attemptsMade + 1;
    const startedAt = Date.now();
    // Identity of this attempt, shared by all three lifecycle lines so one
    // correlationId (or jobId) grep returns the whole story of a job.
    const labels = {
      jobId: job.data.jobId,
      jobType: job.data.jobType,
      runId: job.data.inputReference,
      correlationId: job.data.correlationId,
      organizationPseudonym: pseudonym(job.data.organizationMongoId),
      attempt,
    };
    const claimed = await repository.claim({ message: job.data, workerId, attempt, leaseSeconds });
    if (claimed.cancelled) return { cancelled: true };
    const alive = await repository.heartbeat({ message: job.data, workerId, leaseSeconds, progress: 10, stage: stageFor(job.data.jobType) });
    if (!alive) return { cancelled: true };
    // Logged after the claim, so a line here means the job really began rather
    // than that it was merely delivered. queueWaitMs is the enqueue-to-start
    // latency: a backlog shows up here long before job durations move.
    safeLog("info", "job.attempt.started", {
      ...labels,
      queueWaitMs: Math.max(0, startedAt - job.timestamp),
    });
    let progress = 10;
    let stage = stageFor(job.data.jobType);
    let renewal: Promise<void> | null = null;
    let leaseFailure: unknown = null;
    const renewLease = async (nextProgress = progress, nextStage = stage) => {
      progress = Math.max(progress, nextProgress);
      stage = nextStage;
      if (renewal) return renewal;
      renewal = (async () => {
        try {
          const renewed = await repository.heartbeat({
            message: job.data,
            workerId,
            leaseSeconds,
            progress,
            stage,
          });
          if (!renewed) leaseFailure = Object.assign(new Error("Worker no longer owns this job."), {
            code: "JOB_LEASE_LOST",
            retryable: true,
          });
        } catch (error) {
          leaseFailure = Object.assign(new Error("Job lease renewal failed."), {
            code: "JOB_HEARTBEAT_FAILED",
            retryable: true,
            cause: error,
          });
        } finally {
          renewal = null;
        }
      })();
      return renewal;
    };
    const heartbeatTimer = setInterval(() => { void renewLease(); }, leaseHeartbeatIntervalMs(leaseSeconds));
    try {
      const result = await execute(job.data, async (nextProgress, nextStage) => {
        await renewLease(nextProgress, nextStage);
        if (leaseFailure) throw leaseFailure;
      });
      clearInterval(heartbeatTimer);
      if (renewal) await renewal;
      if (leaseFailure) throw leaseFailure;
      await repository.complete({ message: job.data, workerId, attempt, resultReference: result.resultReference });
      safeLog("info", "job.attempt.completed", {
        ...labels,
        outcome: "success",
        durationMs: Date.now() - startedAt,
      });
      await settleComparison(job.data);
      return result;
    } catch (error) {
      clearInterval(heartbeatTimer);
      if (renewal) await renewal;
      const retryable = Boolean((error as { retryable?: boolean }).retryable);
      const code = String((error as { code?: string }).code || "JOB_HANDLER_FAILED");
      const failed = await repository.fail({ message: job.data, workerId, attempt, diagnosticCode: code, retryable, maxAttempts });
      // Only this frame knows the retry decision, and several job types settle
      // their run row without logging anything, so an operator investigating a
      // failed run would otherwise find no line at all in CloudWatch. `outcome`
      // carries the post-decision job status, which separates a transient
      // attempt (`retry_scheduled`) from a terminal one (`failed`,
      // `dead_letter`) even though both leave the run marked failed.
      safeLog("error", "job.attempt.failed", {
        ...labels,
        errorCode: code,
        retryable,
        outcome: failed.status,
        durationMs: Date.now() - startedAt,
      });
      // The job repository owns the retry budget. Settle the linked draft only
      // after it says no retry remains; a version conflict was already recorded
      // as `conflict` by the draft repository and must not be downgraded.
      if (
        job.data.jobType === "proposal_draft_generate" &&
        ["failed", "dead_letter"].includes(failed.status) &&
        code !== "PROPOSAL_VERSION_CONFLICT"
      )
        await proposalDraftRepository.fail({
          organizationMongoId: job.data.organizationMongoId,
          runId: job.data.inputReference,
          code,
          status: "failed",
        });
      if (job.data.jobType === "vendor_requirement_facts" && ["failed", "dead_letter"].includes(failed.status))
        await vendorIntelligenceRepository.fail({
          organizationMongoId: job.data.organizationMongoId,
          runId: job.data.inputReference,
          code,
        });
      await settleComparison(job.data);
      let chatFallbackCompleted = false;
      if (job.data.jobType === "conversation_chat" && ["failed", "dead_letter", "cancelled"].includes(failed.status)) {
        if (PROVIDER_UNAVAILABLE_CODES.has(code)) {
          try {
            await conversationRepository.completeChatJob({
              organizationMongoId: job.data.organizationMongoId,
              actorUserMongoId: job.data.actorUserMongoId,
              correlationId: job.data.correlationId,
              jobId: job.data.jobId,
              content: CHAT_PROVIDER_UNAVAILABLE_REPLY,
              actions: [],
            });
            safeLog("warn", "conversation_chat_degraded", {
              jobId: job.data.jobId,
              correlationId: job.data.correlationId,
              errorCode: code,
              outcome: "deterministic_fallback",
            });
            chatFallbackCompleted = true;
          } catch (fallbackError) {
            safeLog("error", "conversation_chat_fallback_failed", {
              jobId: job.data.jobId,
              correlationId: job.data.correlationId,
              errorCode: safeErrorCode(fallbackError),
              outcome: "failure",
            });
          }
        }
        if (!chatFallbackCompleted)
          await conversationRepository.failChatJob({ organizationMongoId: job.data.organizationMongoId, actorUserMongoId: job.data.actorUserMongoId, correlationId: job.data.correlationId, jobId: job.data.jobId, errorCode: code }).catch(() => undefined);
      }
      if (retryable && !chatFallbackCompleted) throw error;
      return { failed: true, code, degraded: chatFallbackCompleted };
    }
  }, { connection: redisConnection(), concurrency: Number(process.env.SOURCE_SECURITY_CONCURRENCY || 2), lockDuration: leaseSeconds * 1000, stalledInterval: 15000, maxStalledCount: 2 });
};
