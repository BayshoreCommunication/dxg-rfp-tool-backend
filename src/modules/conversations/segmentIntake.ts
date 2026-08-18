import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../../../config/postgres";
import { createTextSource } from "../documentIngestion/textSource";
import { documentIngestionEnabled } from "../documentIngestion/composition";
import { durableJobRepository, durableJobDispatcher } from "../durableJobs/composition";
import { safeLog } from "../../shared/observability/safeTelemetry";
import { evaluateSegment, conversationExtractionEnabled, segmentTitle, type SegmentTurn } from "./segmentation";

/**
 * Materialise a closed transcript segment as a private source.
 *
 * The planner's typed words are otherwise a dead end: stored as conversation
 * history, never extracted, never reaching MongoDB. This runs after a chat
 * message is appended, decides whether the accumulated turns have closed into a
 * segment, and if so pushes them through the same scan boundary as a pasted
 * note. The scan handler then chains extraction.
 *
 * Never throws. A planner's message must be accepted whether or not the
 * follow-on machinery is available — losing the message to a queueing failure
 * would be far worse than not extracting it.
 */

/**
 * Turns not yet covered by a segment: user chat messages after the one that
 * closed the previous segment. Ordinal ordering is authoritative; created_at
 * can tie within a batch.
 */
const unsegmentedTurns = async (
  c: PoolClient,
  organizationMongoId: string,
  proposalMongoId: string,
  actorUserMongoId: string,
): Promise<{ turns: SegmentTurn[]; nextSourceOrdinal: number }> => {
  // Resolve the tenant before touching any tenant table, or RLS filters
  // everything and the segment silently never closes.
  await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [organizationMongoId]);
  const org = await c.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [organizationMongoId],
  );
  if (!org.rows[0]) return { turns: [], nextSourceOrdinal: 1 };
  await c.query("SELECT set_config('app.organization_id',$1,true)", [org.rows[0].id]);
  const ref = await c.query<{ id: string; conversation_id: string }>(
    `SELECT p.id, cv.id conversation_id
       FROM rfpilot.proposal_references p
       JOIN rfpilot.users u ON u.id = p.owner_user_id
       JOIN rfpilot.conversations cv ON cv.proposal_reference_id = p.id
      WHERE p.external_mongo_id=$1 AND u.external_mongo_id=$2 AND u.status='active'`,
    [proposalMongoId, actorUserMongoId],
  );
  if (!ref.rows[0]) return { turns: [], nextSourceOrdinal: 1 };
  const conversationId = ref.rows[0].conversation_id, proposalRefId = ref.rows[0].id;
  // A rich brief often contains one turn, so turns.length is almost always 1
  // and produced duplicate filenames in the source rail. Count every prior
  // conversation source (including soft-deleted rows) so a later source never
  // reuses a planner-visible title.
  const sourceCount = await c.query<{ n: number }>(
    `SELECT count(*)::int n
       FROM rfpilot.document_sources
      WHERE proposal_reference_id=$1 AND origin='conversation'`,
    [proposalRefId],
  );
  const rows = await c.query<{ id: string; content: string; created_at: Date }>(
    `WITH last_segment AS (
       SELECT COALESCE(MAX(m.ordinal), 0) AS ordinal
         FROM rfpilot.document_sources s
         JOIN rfpilot.conversation_messages m ON m.id = s.segment_message_id
        WHERE s.proposal_reference_id = $2 AND s.origin = 'conversation'
     )
     SELECT m.id, m.content, m.created_at
       FROM rfpilot.conversation_messages m, last_segment
      WHERE m.conversation_id = $1
        AND m.role = 'user' AND m.intent = 'chat' AND m.kind = 'note'
        AND m.ordinal > last_segment.ordinal
      ORDER BY m.ordinal`,
    [conversationId, proposalRefId],
  );
  return {
    turns: rows.rows.map((row) => ({ id: row.id, content: row.content, createdAt: row.created_at })),
    nextSourceOrdinal: Number(sourceCount.rows[0]?.n ?? 0) + 1,
  };
};

export const maybeExtractSegment = async (input: {
  organizationMongoId: string;
  actorUserMongoId: string;
  correlationId: string;
  proposalMongoId: string;
  explicit?: boolean;
  now?: Date;
}): Promise<{ created: boolean; reason?: string }> => {
  if (!conversationExtractionEnabled()) return { created: false, reason: "disabled" };
  if (!documentIngestionEnabled()) return { created: false, reason: "ingestion_disabled" };
  try {
    const segmentInput = await withPostgresTransaction((c) =>
      unsegmentedTurns(c, input.organizationMongoId, input.proposalMongoId, input.actorUserMongoId),
    );
    const decision = evaluateSegment({
      turns: segmentInput.turns,
      now: input.now ?? new Date(),
      explicit: input.explicit,
    });
    if (!decision.extract) return { created: false, reason: decision.reason };

    // Classification is implicit here — the planner typed into a chat box, not
    // a source picker — so it matches what the workspace already does for every
    // upload and note, and the audit row below records that nobody was asked.
    // Making this an explicit choice is an open product decision.
    const { source, created } = await createTextSource({
      organizationMongoId: input.organizationMongoId,
      userMongoId: input.actorUserMongoId,
      correlationId: input.correlationId,
      proposalMongoId: input.proposalMongoId,
      text: decision.text,
      title: segmentTitle(segmentInput.nextSourceOrdinal),
      origin: "conversation",
      classification: "non_confidential",
      idempotencyKey: decision.idempotencyKey,
      segmentMessageId: decision.turns[decision.turns.length - 1].id,
    });
    if (created) {
      await durableJobRepository.createSourceScan({
        organizationMongoId: input.organizationMongoId,
        actorUserMongoId: input.actorUserMongoId,
        correlationId: input.correlationId,
        sourceId: source.id,
        idempotencyKey: `conversation-scan:${source.id}`,
      });
      void durableJobDispatcher.dispatch().catch(() => undefined);
    }
    safeLog("info", "conversation_segment_created", {
      outcome: created ? "created" : "duplicate",
      operation: decision.reason,
    });
    return { created };
  } catch (error) {
    safeLog("warn", "conversation_segment_failed", {
      outcome: "failure",
      errorCode: (error as { code?: string } | null)?.code ?? "UNKNOWN",
    });
    return { created: false, reason: "error" };
  }
};
