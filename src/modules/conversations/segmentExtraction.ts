import { proposalContextRepository } from "../proposalContext/postgresProposalContextRepository";
import { sourceContextInput, contextEnabled } from "../proposalContext/domain";
import { durableJobDispatcher } from "../durableJobs/composition";
import { safeLog } from "../../shared/observability/safeTelemetry";
import { conversationExtractionEnabled } from "./segmentation";
import type { DocumentSource } from "../documentIngestion/domain";

/**
 * Chain extraction onto a conversation-derived source once its scan clears.
 *
 * File uploads are extracted because the planner presses a button; a transcript
 * segment has no such moment, so the scan handler starts the run. This is the
 * only genuinely new plumbing in conversational extraction — everything else
 * reuses the existing source and extraction paths.
 *
 * Never throws. The scan job's own outcome must not depend on whether the
 * follow-on extraction could be queued: a failure here leaves a clean, ready
 * source the planner can still extract manually, which is strictly better than
 * failing the scan and losing the source.
 */
export const chainConversationExtraction = async (input: {
  source: Pick<DocumentSource, "id" | "status" | "origin" | "confidentiality" | "proposalMongoId">;
  organizationMongoId: string;
  actorUserMongoId: string;
  correlationId: string;
}): Promise<{ queued: boolean; reason?: string }> => {
  const { source } = input;
  if (source.origin !== "conversation") return { queued: false, reason: "not_conversation" };
  if (!conversationExtractionEnabled()) return { queued: false, reason: "disabled" };
  if (!contextEnabled()) return { queued: false, reason: "context_disabled" };
  if (process.env.LIVE_AI_PROPOSAL_SOURCE_ENABLED !== "true")
    return { queued: false, reason: "live_source_disabled" };
  // Mirrors the eligibility the extraction worker itself enforces, so an
  // ineligible source is skipped quietly here rather than failing a queued run.
  if (source.status !== "ready") return { queued: false, reason: `status_${source.status}` };
  if (source.confidentiality !== "non_confidential")
    return { queued: false, reason: "classification" };
  if (!source.proposalMongoId) return { queued: false, reason: "no_proposal" };

  try {
    const parsed = sourceContextInput({ sourceIds: [source.id] });
    await proposalContextRepository.create({
      organizationMongoId: input.organizationMongoId,
      actorUserMongoId: input.actorUserMongoId,
      correlationId: input.correlationId,
      ...parsed,
      live: true,
      proposalMongoId: source.proposalMongoId,
      // Derived from the source, so a redelivered scan job cannot start a
      // second extraction run for the same segment.
      idempotencyKey: `conversation-extract:${source.id}`,
    });
    void durableJobDispatcher.dispatch().catch(() => undefined);
    safeLog("info", "conversation_segment_extraction_queued", { outcome: "queued" });
    return { queued: true };
  } catch (error) {
    safeLog("warn", "conversation_segment_extraction_failed", {
      outcome: "failure",
      errorCode: (error as { code?: string } | null)?.code ?? "UNKNOWN",
    });
    return { queued: false, reason: "error" };
  }
};
