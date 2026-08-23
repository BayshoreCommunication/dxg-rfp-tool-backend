import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import { AUTO_APPLY_MIN_CONFIDENCE } from "../candidateApplication/domain";
import { normalizeCandidate } from "../candidateApplication/canonicalMapping";
import { safeLog } from "../../shared/observability/safeTelemetry";
import { isRetiredProposalWorkflowPath } from "../proposals/domain/workflowSections";
import { PROPOSAL_CONTEXT_INPUT_VERSION } from "../proposalContext/domain";
import { applyAnswersToProposalFields } from "./answerFieldWriter";
import { conversationRepository } from "./postgresConversationRepository";

export type ConversationExtractionCandidate = {
  path: string;
  value: unknown;
  confidence: number;
};

export type ConversationAutoApplyAnswer = {
  path: string;
  answer: string;
};

/**
 * Select only candidates the product may apply without asking the planner.
 *
 * A path is excluded when extraction disagreed with itself, the provider's
 * confidence is below the governed threshold, the value cannot pass the same
 * canonical normalizer as the proposal editor, or two canonical paths would
 * write to the same Mongo field. Existing proposal values are guarded later by
 * an atomic conditional update, so this function never needs a stale snapshot.
 */
export const selectConversationAutoApplyAnswers = (
  candidates: ConversationExtractionCandidate[],
  conflictedPaths: ReadonlySet<string> = new Set(),
): ConversationAutoApplyAnswer[] => {
  const byPath = new Map<string, ConversationExtractionCandidate[]>();
  for (const candidate of candidates) {
    if (isRetiredProposalWorkflowPath(candidate.path)) continue;
    byPath.set(candidate.path, [...(byPath.get(candidate.path) ?? []), candidate]);
  }

  const answers: ConversationAutoApplyAnswer[] = [];
  const mongoPaths = new Set<string>();
  for (const candidate of candidates) {
    if (isRetiredProposalWorkflowPath(candidate.path)) continue;
    const peers = byPath.get(candidate.path) ?? [];
    if (
      peers.length !== 1 ||
      conflictedPaths.has(candidate.path) ||
      Number(candidate.confidence) < AUTO_APPLY_MIN_CONFIDENCE
    ) {
      continue;
    }
    const answer =
      typeof candidate.value === "string"
        ? candidate.value.trim()
        : String(candidate.value ?? "").trim();
    if (!answer) continue;
    try {
      const normalized = normalizeCandidate(candidate.path, answer);
      if (mongoPaths.has(normalized.mongoPath)) continue;
      mongoPaths.add(normalized.mongoPath);
      answers.push({ path: candidate.path, answer });
    } catch {
      // Invalid provider output stays available in the governed review surface;
      // it is never allowed through the unattended write path.
    }
  }
  return answers;
};

type ConversationRunData = {
  proposalMongoId: string;
  operations: ConversationExtractionCandidate[];
  conflictedPaths: Set<string>;
  conversationOnly: boolean;
};

const loadConversationRun = async (input: {
  organizationMongoId: string;
  actorUserMongoId: string;
  runId: string;
}): Promise<ConversationRunData | null> =>
  withPostgresTransaction(async (c) => {
    await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [
      input.organizationMongoId,
    ]);
    const organization = await c.query<{ id: string }>(
      "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
      [input.organizationMongoId],
    );
    if (!organization.rows[0]) return null;
    await c.query("SELECT set_config('app.organization_id',$1,true)", [
      organization.rows[0].id,
    ]);

    const run = await c.query<{ proposal_mongo_id: string; status: string }>(
      `SELECT p.external_mongo_id proposal_mongo_id,r.status
         FROM rfpilot.proposal_context_runs r
         JOIN rfpilot.ai_jobs j
           ON j.id=r.job_id AND j.input_version=$3
         JOIN rfpilot.proposal_references p ON p.id=r.proposal_reference_id
         JOIN rfpilot.users u ON u.id=p.owner_user_id
        WHERE r.id=$1 AND u.external_mongo_id=$2 AND u.status='active'`,
      [input.runId, input.actorUserMongoId, PROPOSAL_CONTEXT_INPUT_VERSION],
    );
    if (!run.rows[0] || run.rows[0].status !== "succeeded") return null;

    const sources = await c.query<{ origin: string }>(
      `SELECT s.origin
         FROM rfpilot.proposal_context_run_sources rs
         JOIN rfpilot.document_sources s ON s.id=rs.source_id
        WHERE rs.run_id=$1
        ORDER BY rs.ordinal`,
      [input.runId],
    );
    const conversationOnly =
      sources.rows.length > 0 &&
      sources.rows.every((source) => source.origin === "conversation");

    const operations = await c.query<ConversationExtractionCandidate>(
      `SELECT path,value,confidence
         FROM rfpilot.proposal_context_operations
        WHERE run_id=$1
        ORDER BY ordinal`,
      [input.runId],
    );
    const conflicts = await c.query<{ path: string }>(
      `SELECT DISTINCT unnest(paths) path
         FROM rfpilot.proposal_context_issues
        WHERE run_id=$1 AND code='CROSS_SOURCE_CONFLICT'`,
      [input.runId],
    );
    return {
      proposalMongoId: run.rows[0].proposal_mongo_id,
      operations: operations.rows,
      conflictedPaths: new Set(conflicts.rows.map((row) => row.path)),
      conversationOnly,
    };
  });

const auditAppliedFields = async (input: {
  organizationMongoId: string;
  actorUserMongoId: string;
  runId: string;
  paths: string[];
  correlationId: string;
}): Promise<void> => {
  await withPostgresTransaction(async (c) => {
    await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [
      input.organizationMongoId,
    ]);
    const organization = await c.query<{ id: string }>(
      "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
      [input.organizationMongoId],
    );
    if (!organization.rows[0]) return;
    await c.query("SELECT set_config('app.organization_id',$1,true)", [
      organization.rows[0].id,
    ]);
    await c.query(
      `INSERT INTO rfpilot.audit_events(
         id,organization_id,actor_external_user_id,action,target_type,target_id,
         decision,correlation_id,metadata
       ) VALUES($1,$2,$3,'conversation_fields_auto_applied','proposal_context_run',$4,'allowed',$5,$6::jsonb)`,
      [
        uuidv7(),
        organization.rows[0].id,
        input.actorUserMongoId,
        input.runId,
        input.correlationId,
        JSON.stringify({ fieldCount: input.paths.length, paths: input.paths }),
      ],
    );
  });
};

/**
 * Make a detailed chat message behave like an uploaded TXT/PDF/DOC source.
 * Only conversation-derived context runs are eligible, and every write is an
 * empty-target conditional update. Ambiguous, conflicting, weak, invalid, or
 * already-populated values remain review/follow-up work instead of overwrites.
 */
export const autoApplyConversationContextRun = async (input: {
  organizationMongoId: string;
  actorUserMongoId: string;
  runId: string;
  correlationId: string;
}): Promise<{ applied: number; paths: string[]; reason?: string }> => {
  const run = await loadConversationRun(input);
  if (!run) return { applied: 0, paths: [], reason: "run_unavailable" };
  if (!run.conversationOnly)
    return { applied: 0, paths: [], reason: "not_conversation" };

  const answers = selectConversationAutoApplyAnswers(
    run.operations,
    run.conflictedPaths,
  );
  if (answers.length === 0)
    return { applied: 0, paths: [], reason: "no_safe_candidates" };

  const applied =
    (await applyAnswersToProposalFields({
      organizationMongoId: input.organizationMongoId,
      actorUserMongoId: input.actorUserMongoId,
      proposalMongoId: run.proposalMongoId,
      answers,
      onlyIfEmpty: true,
    })) ?? [];
  if (applied.length === 0)
    return { applied: 0, paths: [], reason: "targets_already_filled" };

  const paths = applied.map((field) => field.path);
  await auditAppliedFields({ ...input, paths });
  await conversationRepository.appendAutoAppliedFieldsSummary({
    organizationMongoId: input.organizationMongoId,
    actorUserMongoId: input.actorUserMongoId,
    correlationId: input.correlationId,
    proposalMongoId: run.proposalMongoId,
    runId: input.runId,
    fieldCount: paths.length,
  });
  safeLog("info", "conversation_fields_auto_applied", {
    outcome: "applied",
    operation: "proposal_context",
    fieldCount: paths.length,
  });
  return { applied: paths.length, paths };
};
