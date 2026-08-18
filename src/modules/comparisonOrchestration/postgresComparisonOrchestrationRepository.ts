/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import Proposal from "../../../modal/proposalsModel";
import VendorSubmission from "../../../modal/vendorSubmissionModel";
import VendorSubmissionVersion from "../../../modal/vendorSubmissionVersionModel";
import { ASSESSMENT_VERSION, COMMERCIAL_POLICY_VERSION, SCORING_POLICY_VERSION } from "../evaluationEngine/domain";
import { EXTRACTION_POLICY_VERSION } from "../evidenceExtraction/domain";
import { buildVendorRecommendation, COMPARISON_SCHEMA_VERSION, ComparisonOrchestrationError, PARTICIPANT_SCHEMA_VERSION, RECOMMENDATION_POLICY_VERSION, comparisonChecksum, evaluatorPanelSignature, freezeScoreInput, uniqueReasons, weightedProgress } from "./domain";

type Context = { organizationMongoId: string; actorUserMongoId: string; proposalMongoId: string; correlationId: string };
type SelectedParticipant = { submissionMongoId: string; versionMongoId: string };

const tenant = async (client: PoolClient, mongoId: string) => {
  await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [mongoId]);
  const result = await client.query<{ id: string }>("SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'", [mongoId]);
  if (!result.rows[0]) throw new ComparisonOrchestrationError("ORGANIZATION_NOT_READY", "Organization unavailable.", 503, true);
  await client.query("SELECT set_config('app.organization_id',$1,true)", [result.rows[0].id]);
  return result.rows[0].id;
};

const ownedProposal = async (client: PoolClient, proposalMongoId: string, actorMongoId: string) => {
  const result = await client.query<{ id: string }>(
    `SELECT p.id FROM rfpilot.proposal_references p JOIN rfpilot.users u ON u.id=p.owner_user_id
     WHERE p.external_mongo_id=$1 AND u.external_mongo_id=$2`, [proposalMongoId, actorMongoId],
  );
  if (!result.rows[0]) throw new ComparisonOrchestrationError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  return result.rows[0].id;
};

const loadMongoInputs = async (input: Context, selected: SelectedParticipant[], requireActive = false) => {
  const proposal = await Proposal.findOne({ _id: input.proposalMongoId, organizationId: input.organizationMongoId, userId: input.actorUserMongoId }).lean<any>();
  if (!proposal) throw new ComparisonOrchestrationError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  const [submissions, versions] = selected.length ? await Promise.all([
    VendorSubmission.find({
      _id: { $in: selected.map((item) => item.submissionMongoId) },
      organizationId: input.organizationMongoId,
      proposalId: input.proposalMongoId,
      proposalOwnerId: input.actorUserMongoId,
      ...(requireActive ? { status: "active" } : {}),
    }).lean<any[]>(),
    VendorSubmissionVersion.find({
      _id: { $in: selected.map((item) => item.versionMongoId) },
      organizationId: input.organizationMongoId,
      proposalId: input.proposalMongoId,
    }).lean<any[]>(),
  ]) : [[], []];
  const submissionById = new Map(submissions.map((item: any) => [String(item._id), item]));
  const versionById = new Map(versions.map((item: any) => [String(item._id), item]));
  const participants = [];
  for (const item of selected) {
    const submission = submissionById.get(item.submissionMongoId);
    if (!submission) throw new ComparisonOrchestrationError("SUBMISSION_VERSION_NOT_FOUND", "A selected vendor submission was not found.", 404);
    const version = versionById.get(item.versionMongoId);
    if (!version || String(version.submissionId) !== item.submissionMongoId) throw new ComparisonOrchestrationError("SUBMISSION_VERSION_NOT_FOUND", "A selected vendor version was not found.", 404);
    participants.push({
      submissionMongoId: item.submissionMongoId,
      versionMongoId: item.versionMongoId,
      vendorLabel: String(submission.vendorName || "Vendor").slice(0, 255),
      currentVersionMongoId: String(submission.currentVersionId ?? ""),
      submissionManifestChecksum: String(version.manifestChecksum),
      documents: (version.documents ?? []).map((document: any) => ({ documentId: String(document.documentId), checksum: String(document.sha256), name: String(document.name || "Attachment").slice(0, 255) })),
    });
  }
  return { proposal, proposalVersion: String(proposal.__v ?? 0), proposalChecksum: comparisonChecksum(proposal), participants };
};

const audit = (client: PoolClient, input: Context, organizationId: string, action: string, runId: string, metadata: Record<string, unknown>) => client.query(
  `INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata)
   VALUES($1,$2,$3,$4,'comparison_run',$5,'allow',$6,$7::jsonb)`,
  [uuidv7(), organizationId, input.actorUserMongoId, action, runId, input.correlationId, JSON.stringify(metadata)],
);

const queueJob = async (client: PoolClient, input: { organizationId: string; organizationMongoId: string; actorUserMongoId: string; proposalReferenceId: string; jobType: "comparison_participant_snapshot" | "comparison_aggregate"; inputReference: string; inputChecksum: string; stableKey: string; correlationId: string }) => {
  const jobId = uuidv7();
  await client.query(
    `INSERT INTO rfpilot.ai_jobs(id,organization_id,proposal_reference_id,job_type,status,idempotency_key,input_reference,input_version,input_checksum,max_attempts,correlation_id,initiator_external_user_id)
     VALUES($1,$2,$3,$4,'queued',$5,$6,$7,$8,3,$9,$10)`,
    [jobId, input.organizationId, input.proposalReferenceId, input.jobType, input.stableKey, input.inputReference, COMPARISON_SCHEMA_VERSION, input.inputChecksum, input.correlationId, input.actorUserMongoId],
  );
  const payload = { jobId, organizationMongoId: input.organizationMongoId, actorUserMongoId: input.actorUserMongoId, jobType: input.jobType, inputReference: input.inputReference, inputVersion: COMPARISON_SCHEMA_VERSION, correlationId: input.correlationId };
  await client.query(
    `INSERT INTO rfpilot.outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,idempotency_key,payload)
     VALUES($1,$2,'ai_job',$3,'job.queued',$4,$5::jsonb)`,
    [uuidv7(), input.organizationId, jobId, `job.queued:${jobId}:1`, JSON.stringify(payload)],
  );
  return jobId;
};

const runRow = async (client: PoolClient, proposalReferenceId: string, runId: string) => {
  const result = await client.query<any>("SELECT * FROM rfpilot.comparison_runs WHERE id=$1 AND proposal_reference_id=$2", [runId, proposalReferenceId]);
  if (!result.rows[0]) throw new ComparisonOrchestrationError("COMPARISON_NOT_FOUND", "Comparison was not found.", 404);
  return result.rows[0];
};

const syncGraph = async (client: PoolClient, runId: string) => {
  await client.query(
    `UPDATE rfpilot.comparison_job_nodes n SET status=j.status,safe_error_code=j.error_code,output_reference=j.result_reference,updated_at=now()
     FROM rfpilot.ai_jobs j WHERE n.comparison_run_id=$1 AND n.ai_job_id=j.id AND n.status IS DISTINCT FROM j.status`, [runId],
  );
  const nodes = await client.query<any>("SELECT status,weight FROM rfpilot.comparison_job_nodes WHERE comparison_run_id=$1", [runId]);
  const participantCounts = await client.query<{ completed: number; total: number }>(
    `SELECT count(*) FILTER(WHERE status='succeeded')::int completed,count(*)::int total FROM rfpilot.comparison_participants WHERE comparison_run_id=$1`, [runId],
  );
  const terminalFailure = nodes.rows.some((node) => ["failed", "dead_letter"].includes(node.status));
  await client.query(
    `UPDATE rfpilot.comparison_runs SET progress=$2,completed_participant_count=$3,
       status=CASE WHEN status IN('cancelling','cancelled','succeeded','succeeded_with_warnings') THEN status WHEN $4 THEN 'failed' ELSE status END,
       progress_stage=CASE WHEN status IN('cancelling','cancelled') THEN progress_stage WHEN $4 THEN 'failed' WHEN EXISTS(SELECT 1 FROM rfpilot.comparison_job_nodes WHERE comparison_run_id=$1 AND job_type='comparison_aggregate' AND status<>'waiting') THEN 'aggregation' ELSE 'participant_snapshots' END,
       updated_at=now() WHERE id=$1`,
    [runId, weightedProgress(nodes.rows), Number(participantCounts.rows[0]?.completed ?? 0), terminalFailure],
  );
  await client.query(
    `UPDATE rfpilot.comparison_participants p SET
       status=CASE WHEN n.status='succeeded' THEN 'succeeded' WHEN n.status IN('failed','dead_letter') THEN 'failed' WHEN n.status='cancelled' THEN 'cancelled' WHEN n.status='running' THEN 'running' ELSE p.status END,
       current_stage=CASE WHEN n.status='succeeded' THEN 'completed' WHEN n.status IN('failed','dead_letter') THEN 'failed' WHEN n.status='cancelled' THEN 'cancelled' ELSE p.current_stage END,
       safe_error_code=n.safe_error_code,updated_at=now()
     FROM rfpilot.comparison_job_nodes n WHERE n.comparison_run_id=$1 AND n.participant_id=p.id`, [runId],
  );
  await client.query(
    `UPDATE rfpilot.comparison_runs SET status='cancelled',progress_stage='cancelled',completed_at=now(),updated_at=now()
     WHERE id=$1 AND status='cancelling' AND NOT EXISTS(
       SELECT 1 FROM rfpilot.comparison_job_nodes WHERE comparison_run_id=$1 AND status IN('queued','running','retry_scheduled','waiting'))`, [runId],
  );
  return nodes.rows;
};

const materializeAggregate = async (client: PoolClient, input: { organizationId: string; organizationMongoId: string; actorUserMongoId: string; run: any }) => {
  const waiting = await client.query<any>(
    `SELECT n.* FROM rfpilot.comparison_job_nodes n WHERE n.comparison_run_id=$1 AND n.job_type='comparison_aggregate' AND n.status='waiting' AND NOT EXISTS(
       SELECT 1 FROM rfpilot.comparison_job_dependencies d JOIN rfpilot.comparison_job_nodes p ON p.id=d.parent_node_id
       WHERE d.child_node_id=n.id AND p.status<>'succeeded') FOR UPDATE`, [input.run.id],
  );
  if (!waiting.rows[0] || ["cancelling", "cancelled", "failed"].includes(input.run.status)) return false;
  const node = waiting.rows[0];
  const jobId = await queueJob(client, {
    organizationId: input.organizationId, organizationMongoId: input.organizationMongoId,
    actorUserMongoId: input.actorUserMongoId, proposalReferenceId: input.run.proposal_reference_id,
    jobType: "comparison_aggregate", inputReference: input.run.id, inputChecksum: node.input_checksum,
    stableKey: `comparison-aggregate:${input.run.id}:${node.input_checksum}`, correlationId: input.run.correlation_id,
  });
  await client.query("UPDATE rfpilot.comparison_job_nodes SET ai_job_id=$2,status='queued',updated_at=now() WHERE id=$1", [node.id, jobId]);
  await client.query("UPDATE rfpilot.comparison_runs SET progress_stage='aggregation',updated_at=now() WHERE id=$1", [input.run.id]);
  return true;
};

const reviewInputChecksum = async (client: PoolClient, intelligenceRunId: string) => {
  const reviews = await client.query<any>(
    `SELECT id review_id,target_type,target_id,decision,corrected_payload
     FROM rfpilot.human_review_events WHERE intelligence_run_id=$1 ORDER BY created_at,id`,
    [intelligenceRunId],
  );
  return comparisonChecksum(reviews.rows.map((row) => ({
    reviewId: row.review_id,
    targetType: row.target_type,
    targetId: row.target_id,
    decision: row.decision,
    correctedPayload: row.corrected_payload,
  })));
};

const scoreInputState = async (client: PoolClient, evaluationRunId: string) => {
  const rows = await client.query<any>(
    `SELECT a.id assignment_id,a.role,a.conflict_status,ac.criterion_id,
            s.id event_id,s.event_type,s.score,s.weighted_contribution
     FROM rfpilot.evaluation_assignments a
     LEFT JOIN rfpilot.evaluation_assignment_criteria ac ON ac.assignment_id=a.id
     LEFT JOIN LATERAL (
       SELECT e.id,e.event_type,e.score,e.weighted_contribution
       FROM rfpilot.evaluator_score_events e
       WHERE e.assignment_id=a.id AND e.criterion_id=ac.criterion_id
       ORDER BY e.created_at DESC,e.id DESC LIMIT 1
     ) s ON true
     WHERE a.evaluation_run_id=$1 ORDER BY a.id,ac.criterion_id`,
    [evaluationRunId],
  );
  return freezeScoreInput(rows.rows.map((row) => ({
    assignmentId: row.assignment_id,
    role: row.role,
    conflictStatus: row.conflict_status,
    criterionId: row.criterion_id,
    eventId: row.event_id,
    eventType: row.event_type,
    score: row.score === null ? null : Number(row.score),
    weightedContribution: row.weighted_contribution === null ? null : Number(row.weighted_contribution),
  })));
};

const evaluationPanelSignature = async (client: PoolClient, evaluationRunId: string) => {
  const rows = await client.query<any>(
    `SELECT a.evaluator_external_user_id,a.role,a.conflict_status,
            coalesce(jsonb_agg(ac.criterion_id ORDER BY ac.criterion_id) FILTER(WHERE ac.criterion_id IS NOT NULL),'[]') criterion_ids
     FROM rfpilot.evaluation_assignments a
     LEFT JOIN rfpilot.evaluation_assignment_criteria ac ON ac.assignment_id=a.id
     WHERE a.evaluation_run_id=$1
     GROUP BY a.id,a.evaluator_external_user_id,a.role,a.conflict_status`,
    [evaluationRunId],
  );
  return evaluatorPanelSignature(rows.rows.map((row) => ({
    evaluatorExternalUserId: String(row.evaluator_external_user_id),
    role: String(row.role),
    conflictStatus: String(row.conflict_status),
    criterionIds: Array.isArray(row.criterion_ids) ? row.criterion_ids.map(String) : [],
  })));
};

const criticalReviewState = async (client: PoolClient, intelligenceRunId: string, requirementSetId: string) => {
  const result = await client.query<{ count: number }>(
    `SELECT (
       SELECT count(*) FROM rfpilot.requirements r
       WHERE r.requirement_set_id=$2 AND r.included=true AND (r.mandatory_status='mandatory' OR r.eligibility=true)
         AND NOT EXISTS (
           SELECT 1 FROM rfpilot.requirement_evidence_mappings m
           JOIN LATERAL (
             SELECT h.decision FROM rfpilot.human_review_events h
             WHERE h.intelligence_run_id=$1 AND h.target_type='mapping' AND h.target_id=m.id
             ORDER BY h.created_at DESC,h.id DESC LIMIT 1
           ) review ON review.decision IN ('accepted','rejected','corrected')
           WHERE m.intelligence_run_id=$1 AND m.requirement_id=r.id
         )
     ) + (
       SELECT count(*) FROM rfpilot.extracted_facts f
       WHERE f.intelligence_run_id=$1 AND f.contradiction_group IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM LATERAL (
             SELECT h.decision FROM rfpilot.human_review_events h
             WHERE h.intelligence_run_id=$1 AND h.target_type='fact' AND h.target_id=f.id
             ORDER BY h.created_at DESC,h.id DESC LIMIT 1
           ) review WHERE review.decision IN ('accepted','rejected','corrected')
         )
     )::int count`,
    [intelligenceRunId, requirementSetId],
  );
  return { complete: Number(result.rows[0]?.count ?? 0) === 0, unresolvedCount: Number(result.rows[0]?.count ?? 0) };
};

const currentFreshness = async (client: PoolClient, run: any, mongo: Awaited<ReturnType<typeof loadMongoInputs>>) => {
  const manifestResult = await client.query<any>("SELECT * FROM rfpilot.comparison_manifests WHERE comparison_run_id=$1", [run.id]);
  const manifest = manifestResult.rows[0], reasons: string[] = [];
  if (String(manifest.proposal_version) !== mongo.proposalVersion || manifest.proposal_checksum !== mongo.proposalChecksum) reasons.push("proposal_version_changed");
  const set = await client.query<any>("SELECT status,content_checksum FROM rfpilot.requirement_sets WHERE id=$1", [run.requirement_set_id]);
  if (set.rows[0]?.status !== "approved" || set.rows[0]?.content_checksum !== manifest.requirement_checksum) reasons.push("requirement_set_superseded");
  const matrix = await client.query<any>("SELECT status,content_checksum FROM rfpilot.evaluation_matrix_versions WHERE id=$1", [run.matrix_version_id]);
  if (matrix.rows[0]?.status !== "approved" || matrix.rows[0]?.content_checksum !== manifest.matrix_checksum) reasons.push("evaluation_matrix_superseded");
  for (const participant of mongo.participants) if (participant.currentVersionMongoId && participant.currentVersionMongoId !== participant.versionMongoId) reasons.push("submission_version_available");
  const frozenParticipants = Array.isArray(manifest.manifest?.participants) ? manifest.manifest.participants : [];
  for (const participant of frozenParticipants) {
    if (participant?.intelligenceRunId) {
      const currentReviewChecksum = await reviewInputChecksum(client, String(participant.intelligenceRunId));
      if (currentReviewChecksum !== String(participant.reviewInputChecksum ?? "")) reasons.push("evidence_review_changed");
    }
    if (participant?.evaluationRunId) {
      const scoreState = await scoreInputState(client, String(participant.evaluationRunId));
      if (scoreState.checksum !== String(participant.scoreInputChecksum ?? "")) reasons.push("evaluator_scores_changed");
      if (!scoreState.complete) reasons.push("evaluation_incomplete");
    }
    const documents = Array.isArray(participant?.documents) ? participant.documents.filter((document: any) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(document?.documentId))) : [];
    if (documents.length) {
      const sources = await client.query<any>(
        `SELECT s.vendor_document_id,o.sha256 FROM rfpilot.document_sources s JOIN rfpilot.document_objects o ON o.source_id=s.id
         WHERE s.vendor_document_id=ANY($1::uuid[])`, [documents.map((document: any) => document.documentId)],
      );
      const current = new Map(sources.rows.map((row: any) => [String(row.vendor_document_id), String(row.sha256)]));
      if (documents.some((document: any) => current.get(String(document.documentId)) !== String(document.checksum))) reasons.push("source_replaced");
    }
  }
  if (manifest.extraction_policy_version !== EXTRACTION_POLICY_VERSION) reasons.push("extraction_policy_changed");
  if (manifest.assessment_schema_version !== ASSESSMENT_VERSION) reasons.push("assessment_schema_changed");
  if (manifest.scoring_policy_version !== SCORING_POLICY_VERSION) reasons.push("scoring_policy_changed");
  if (manifest.commercial_policy_version !== COMMERCIAL_POLICY_VERSION) reasons.push("commercial_policy_changed");
  if (manifest.manifest?.policies?.recommendation !== RECOMMENDATION_POLICY_VERSION) reasons.push("recommendation_policy_changed");
  const staleReasons = uniqueReasons(reasons);
  await client.query("UPDATE rfpilot.comparison_runs SET freshness_state=$2,stale_reasons=$3::jsonb,updated_at=now() WHERE id=$1", [run.id, staleReasons.length ? "stale" : "current", JSON.stringify(staleReasons)]);
  return staleReasons;
};

const intelligenceProjection = async (client: PoolClient, run: any, priceVisibility: string) => {
  const [requirementRows, commercialRows, riskRows, evaluationRows, decisionRows] = await Promise.all([
    client.query<any>(
      `SELECT r.id requirement_id,r.requirement_key,r.kind,r.title,r.normalized_text,r.mandatory_status,r.eligibility,
              r.importance,r.verification_method,r.group_key,r.ordinal requirement_ordinal,
              p.id participant_id,p.vendor_label,p.ordinal participant_ordinal,
              a.id assessment_id,a.verdict,a.rationale,a.confidence,a.needs_human_review,a.review_reasons,
              coalesce(ev.evidence,'[]'::jsonb) evidence,coalesce(rv.review_history,'[]'::jsonb) review_history
       FROM rfpilot.comparison_participants p
       JOIN rfpilot.requirements r ON r.requirement_set_id=$2 AND r.included=true
       LEFT JOIN rfpilot.ai_assessments a ON a.evaluation_run_id=p.evaluation_run_id AND a.requirement_id=r.id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'evidenceId',ef.id,'supportRole',ae.support_role,'sourceLabel',sx.source_label,
           'sourceChecksum',sx.source_checksum,'locator',ef.locator,'excerpt',left(ef.content,2000),
           'contentChecksum',ef.content_checksum,'trustClass',ef.trust_class,
           'facts',coalesce((SELECT jsonb_agg(jsonb_build_object(
             'factId',f.id,'key',f.fact_key,'family',f.family,'type',f.fact_type,'statement',f.statement,
             'valueKind',f.value_kind,'typedValue',f.typed_value,'normalizedValue',f.normalized_value,
             'unit',f.unit,'currency',f.currency,'confidence',f.confidence,'contradictionGroup',f.contradiction_group,
             'supportRole',fe.support_role) ORDER BY f.ordinal)
             FROM rfpilot.extracted_fact_evidence fe
             JOIN rfpilot.extracted_facts f ON f.id=fe.fact_id
             WHERE fe.evidence_fragment_id=ef.id AND f.intelligence_run_id=p.intelligence_run_id
           ),'[]'::jsonb)
         ) ORDER BY ae.ordinal) evidence
         FROM rfpilot.assessment_evidence ae
         JOIN rfpilot.evidence_fragments ef ON ef.id=ae.evidence_fragment_id
         JOIN rfpilot.source_extraction_runs sx ON sx.id=ef.extraction_run_id
         WHERE ae.assessment_id=a.id
       ) ev ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'reviewId',h.id,'decision',h.decision,'reasonCode',h.reason_code,'note',h.note,
           'actorUserId',h.actor_external_user_id,'createdAt',h.created_at
         ) ORDER BY h.created_at,h.id) review_history
         FROM rfpilot.requirement_evidence_mappings m
         JOIN rfpilot.human_review_events h ON h.intelligence_run_id=m.intelligence_run_id AND h.target_type='mapping' AND h.target_id=m.id
         WHERE m.intelligence_run_id=p.intelligence_run_id AND m.requirement_id=r.id
       ) rv ON true
       WHERE p.comparison_run_id=$1
       ORDER BY r.ordinal,p.ordinal`,
      [run.id, run.requirement_set_id],
    ),
    client.query<any>(
      `SELECT p.id participant_id,p.vendor_label,
              s.submitted_total,s.submitted_currency,s.basis,
              n.comparable,n.normalized_total,n.currency normalized_currency,n.arithmetic_status,n.assumptions,n.refusal_codes,n.policy_version,
              coalesce(lines.line_items,'[]'::jsonb) line_items
       FROM rfpilot.comparison_participants p
       LEFT JOIN rfpilot.commercial_submissions s ON s.evaluation_run_id=p.evaluation_run_id
       LEFT JOIN rfpilot.commercial_normalizations n ON n.commercial_submission_id=s.id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'lineItemId',l.id,'category',l.category,'description',l.description,'amount',l.amount,
           'currency',l.currency,'optionOrExclusion',l.option_or_exclusion
         ) ORDER BY l.ordinal) line_items
         FROM rfpilot.commercial_line_items l WHERE l.commercial_submission_id=s.id
       ) lines ON true
       WHERE p.comparison_run_id=$1 ORDER BY p.ordinal`,
      [run.id],
    ),
    client.query<any>(
      `SELECT p.id participant_id,p.vendor_label,x.id risk_id,x.requirement_id,x.category,x.severity,x.title,x.basis,x.disposition,
              c.id question_id,c.question,coalesce(ev.evidence,'[]'::jsonb) evidence
       FROM rfpilot.comparison_participants p
       JOIN rfpilot.evaluation_risks x ON x.evaluation_run_id=p.evaluation_run_id
       LEFT JOIN rfpilot.clarification_candidates c ON c.risk_id=x.id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'evidenceId',ef.id,'sourceLabel',sx.source_label,'sourceChecksum',sx.source_checksum,
           'locator',ef.locator,'excerpt',left(ef.content,2000),'contentChecksum',ef.content_checksum,
           'trustClass',ef.trust_class
         ) ORDER BY re.ordinal) evidence
         FROM rfpilot.risk_evidence re
         JOIN rfpilot.evidence_fragments ef ON ef.id=re.evidence_fragment_id
         JOIN rfpilot.source_extraction_runs sx ON sx.id=ef.extraction_run_id
         WHERE re.risk_id=x.id
       ) ev ON true
       WHERE p.comparison_run_id=$1 ORDER BY p.ordinal,x.ordinal`,
      [run.id],
    ),
    client.query<any>(
      `SELECT p.id participant_id,p.vendor_label,coalesce(pr.result->'evaluation','{}'::jsonb) score_summary,
              (SELECT count(*)::int FROM rfpilot.evaluation_assignments a WHERE a.evaluation_run_id=p.evaluation_run_id AND a.role<>'observer') evaluator_count,
              (SELECT count(*)::int FROM rfpilot.evaluation_assignments a WHERE a.evaluation_run_id=p.evaluation_run_id AND a.role<>'observer' AND a.status='complete' AND a.conflict_status='clear') completed_evaluator_count,
              (SELECT count(*)::int FROM rfpilot.evaluation_assignments a WHERE a.evaluation_run_id=p.evaluation_run_id AND a.role<>'observer' AND a.conflict_status='conflict') conflict_count
       FROM rfpilot.comparison_participants p
       LEFT JOIN rfpilot.comparison_participant_results pr ON pr.participant_id=p.id
       WHERE p.comparison_run_id=$1 ORDER BY p.ordinal`,
      [run.id],
    ),
    client.query<any>(
      `SELECT id,decision_type,selected_participant_ids,rationale,stale_acknowledged,manifest_checksum,
              supersedes_decision_id,actor_external_user_id,created_at
       FROM rfpilot.comparison_decisions WHERE comparison_run_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`,
      [run.id],
    ),
  ]);
  const requirements = new Map<string, any>();
  for (const row of requirementRows.rows) {
    const requirement = requirements.get(row.requirement_id) ?? {
      requirementId: row.requirement_id, key: row.requirement_key, kind: row.kind, title: row.title,
      text: row.normalized_text, mandatoryStatus: row.mandatory_status, eligibility: row.eligibility,
      importance: row.importance, verificationMethod: row.verification_method, groupKey: row.group_key,
      ordinal: row.requirement_ordinal, vendors: [],
    };
    requirement.vendors.push({
      participantId: row.participant_id, vendorLabel: row.vendor_label,
      assessmentId: row.assessment_id, verdict: row.verdict ?? "not_assessable", rationale: row.rationale ?? "No persisted assessment is available.",
      confidence: row.confidence === null ? null : Number(row.confidence), needsHumanReview: row.needs_human_review ?? true,
      reviewReasons: row.review_reasons ?? ["ASSESSMENT_UNAVAILABLE"], evidence: row.evidence ?? [], reviewHistory: row.review_history ?? [],
    });
    requirements.set(row.requirement_id, requirement);
  }
  const requirementList = [...requirements.values()];
  const evaluation = evaluationRows.rows.map((row) => ({
    participantId: row.participant_id, vendorLabel: row.vendor_label,
    submittedScores: Number(row.score_summary?.submitted_scores ?? 0), submittedEvaluators: Number(row.score_summary?.submitted_evaluators ?? 0),
    weightedContributionTotal: Number(row.score_summary?.contribution_total ?? 0), evaluatorCount: Number(row.evaluator_count ?? 0),
    completedEvaluatorCount: Number(row.completed_evaluator_count ?? 0), conflictCount: Number(row.conflict_count ?? 0),
    criteria: (Array.isArray(row.score_summary?.criterion_scores) ? row.score_summary.criterion_scores : []).map((criterion: any) => ({
      criterionId: String(criterion.criterionId ?? ""), name: String(criterion.name ?? "Criterion"),
      meanScore: Number(criterion.meanScore ?? 0), meanWeightedContribution: Number(criterion.meanWeightedContribution ?? 0),
      spread: Number(criterion.spread ?? 0), rubricMaximum: Number(criterion.rubricMaximum ?? 0),
      originalWeight: Number(criterion.originalWeight ?? 0),
    })),
  }));
  const mandatoryGaps = requirementList.reduce((count, requirement) => count + requirement.vendors.filter((vendor: any) => requirement.mandatoryStatus === "mandatory" && ["missing", "contradictory"].includes(vendor.verdict)).length, 0);
  const unresolvedReviews = requirementList.reduce((count, requirement) => count + requirement.vendors.filter((vendor: any) => vendor.needsHumanReview).length, 0);
  return {
    overview: {
      responseCount: run.participant_count, versionCount: run.participant_count, approvedRequirementCount: requirementList.length,
      mandatoryGapCount: mandatoryGaps, unresolvedReviewCount: unresolvedReviews,
      evaluatorCompletedCount: evaluation.reduce((sum, item) => sum + item.completedEvaluatorCount, 0),
      evaluatorAssignedCount: evaluation.reduce((sum, item) => sum + item.evaluatorCount, 0),
    },
    requirements: requirementList,
    technical: requirementList.filter((item) => ["technical", "staffing", "references", "sustainability_dei"].includes(item.kind)),
    permissions: { viewCommercial: priceVisibility !== "hidden" },
    commercial: priceVisibility === "hidden" ? [] : commercialRows.rows.map((row) => ({
      participantId: row.participant_id, vendorLabel: row.vendor_label, submittedTotal: row.submitted_total === null ? null : Number(row.submitted_total),
      submittedCurrency: row.submitted_currency, basis: row.basis, comparable: row.comparable ?? false,
      normalizedTotal: row.normalized_total === null ? null : Number(row.normalized_total), normalizedCurrency: row.normalized_currency,
      arithmeticStatus: row.arithmetic_status, assumptions: row.assumptions ?? [], refusalCodes: row.refusal_codes ?? [],
      policyVersion: row.policy_version, lineItems: row.line_items ?? [],
    })),
    risks: riskRows.rows.map((row) => ({
      participantId: row.participant_id, vendorLabel: row.vendor_label, riskId: row.risk_id, requirementId: row.requirement_id,
      category: row.category, severity: row.severity, title: row.title, basis: row.basis, disposition: row.disposition,
      questionId: row.question_id, question: row.question, evidence: row.evidence ?? [],
    })),
    evaluation,
    decisions: decisionRows.rows.map((row) => ({
      decisionId: row.id, decisionType: row.decision_type, selectedParticipantIds: row.selected_participant_ids,
      rationale: row.rationale, staleAcknowledged: row.stale_acknowledged, manifestChecksum: row.manifest_checksum,
      supersedesDecisionId: row.supersedes_decision_id, createdAt: row.created_at,
    })),
  };
};

const projection = async (client: PoolClient, run: any, includeIntelligence = false) => {
  const [manifest, participants, nodes, snapshot] = await Promise.all([
    client.query<any>("SELECT * FROM rfpilot.comparison_manifests WHERE comparison_run_id=$1", [run.id]),
    client.query<any>("SELECT * FROM rfpilot.comparison_participants WHERE comparison_run_id=$1 ORDER BY ordinal", [run.id]),
    client.query<any>("SELECT node_key,job_type,status,weight,safe_error_code,updated_at FROM rfpilot.comparison_job_nodes WHERE comparison_run_id=$1 ORDER BY created_at", [run.id]),
    client.query<any>("SELECT snapshot FROM rfpilot.comparison_snapshots WHERE comparison_run_id=$1", [run.id]),
  ]);
  const priceVisibility = manifest.rows[0].price_visibility;
  return {
    schemaVersion: COMPARISON_SCHEMA_VERSION,
    run: { runId: run.id, status: run.status, progress: Number(run.progress), progressStage: run.progress_stage, participantCount: run.participant_count, completedParticipantCount: run.completed_participant_count, warnings: run.warnings, createdAt: run.created_at, completedAt: run.completed_at },
    freshness: { state: run.freshness_state, reasons: run.stale_reasons },
    manifest: { manifestId: manifest.rows[0].id, checksum: manifest.rows[0].content_checksum, proposalVersion: manifest.rows[0].proposal_version, requirementSetVersion: manifest.rows[0].requirement_set_version, evaluationMatrixVersion: manifest.rows[0].matrix_version, priceVisibility, policies: { extraction: manifest.rows[0].extraction_policy_version, assessment: manifest.rows[0].assessment_schema_version, commercial: manifest.rows[0].commercial_policy_version, scoring: manifest.rows[0].scoring_policy_version, comparison: manifest.rows[0].manifest?.policies?.comparison ?? "", recommendation: manifest.rows[0].manifest?.policies?.recommendation ?? "" } },
    participants: participants.rows.map((row) => ({ participantId: row.id, vendorLabel: row.vendor_label, submissionId: row.vendor_submission_mongo_id, versionId: row.vendor_submission_version_mongo_id, status: row.status, stage: row.current_stage, warningCount: row.warning_count, safeErrorCode: row.safe_error_code })),
    jobs: nodes.rows.map((row) => ({ key: row.node_key, type: row.job_type, status: row.status, weight: Number(row.weight), safeErrorCode: row.safe_error_code, updatedAt: row.updated_at })),
    snapshot: snapshot.rows[0]?.snapshot ?? null,
    intelligence: includeIntelligence ? await intelligenceProjection(client, run, priceVisibility) : undefined,
  };
};

export const comparisonOrchestrationRepository = {
  async create(input: Context & { requirementSetId: string; matrixVersionId: string; participants: SelectedParticipant[]; priceVisibility: "reviewers" | "committee" | "hidden"; idempotencyKey: string }) {
    if (input.participants.length < 2 || input.participants.length > 50) throw new ComparisonOrchestrationError("COMPARISON_PARTICIPANTS_INVALID", "Select between 2 and 50 vendor versions.");
    const pairKeys = input.participants.map((item) => `${item.submissionMongoId}:${item.versionMongoId}`);
    if (new Set(pairKeys).size !== pairKeys.length || new Set(input.participants.map((item) => item.submissionMongoId)).size !== input.participants.length)
      throw new ComparisonOrchestrationError("COMPARISON_PARTICIPANTS_INVALID", "Each vendor may appear only once in a comparison.");
    const mongo = await loadMongoInputs(input, input.participants, true);
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId), proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId);
      const setResult = await client.query<any>("SELECT * FROM rfpilot.requirement_sets WHERE id=$1 AND proposal_reference_id=$2 AND status='approved'", [input.requirementSetId, proposalReferenceId]);
      if (!setResult.rows[0]) throw new ComparisonOrchestrationError("REQUIREMENT_SET_NOT_APPROVED", "An approved requirement set is required.", 409);
      const matrixResult = await client.query<any>("SELECT * FROM rfpilot.evaluation_matrix_versions WHERE id=$1 AND requirement_set_id=$2 AND status='approved' AND weights_confirmed=true AND total_weight=100", [input.matrixVersionId, input.requirementSetId]);
      if (!matrixResult.rows[0]) throw new ComparisonOrchestrationError("EVALUATION_MATRIX_NOT_CONFIRMED", "A confirmed 100% evaluation matrix is required.", 409);
      const selected = [];
      let commonPanelSignature: string | null = null;
      for (let ordinal = 0; ordinal < mongo.participants.length; ordinal += 1) {
        const item = mongo.participants[ordinal];
        const evaluation = await client.query<any>(
          `SELECT e.*,i.provider,i.model,i.output_checksum intelligence_output_checksum
           FROM rfpilot.vendor_evaluation_runs e JOIN rfpilot.vendor_intelligence_runs i ON i.id=e.intelligence_run_id
           WHERE e.proposal_reference_id=$1 AND e.requirement_set_id=$2 AND e.matrix_version_id=$3
             AND e.vendor_submission_mongo_id=$4 AND e.vendor_submission_version_mongo_id=$5 AND e.status='ready' AND i.status='succeeded'
             AND e.assessment_version=$6 AND e.commercial_policy_version=$7 AND e.scoring_policy_version=$8
           ORDER BY e.created_at DESC LIMIT 1`, [proposalReferenceId, input.requirementSetId, input.matrixVersionId, item.submissionMongoId, item.versionMongoId, ASSESSMENT_VERSION, COMMERCIAL_POLICY_VERSION, SCORING_POLICY_VERSION],
        );
        if (!evaluation.rows[0]) throw new ComparisonOrchestrationError("COMPARISON_NOT_READY", `Complete proposal intelligence and evaluation for ${item.vendorLabel} before comparison.`, 409);
        const currentReviewChecksum = await reviewInputChecksum(client, evaluation.rows[0].intelligence_run_id);
        if (currentReviewChecksum !== evaluation.rows[0].review_input_checksum)
          throw new ComparisonOrchestrationError("COMPARISON_NOT_READY", `Regenerate the evaluation for ${item.vendorLabel} after its evidence review changed.`, 409);
        const criticalReviews = await criticalReviewState(client, evaluation.rows[0].intelligence_run_id, input.requirementSetId);
        if (!criticalReviews.complete)
          throw new ComparisonOrchestrationError("COMPARISON_CRITICAL_REVIEW_INCOMPLETE", `Resolve ${criticalReviews.unresolvedCount} mandatory or eligibility evidence reviews for ${item.vendorLabel} before comparison.`, 409);
        const scoreState = await scoreInputState(client, evaluation.rows[0].id);
        if (!scoreState.complete)
          throw new ComparisonOrchestrationError("COMPARISON_EVALUATION_INCOMPLETE", `Complete all eligible evaluator scores for ${item.vendorLabel} before comparison.`, 409);
        const panelSignature = await evaluationPanelSignature(client, evaluation.rows[0].id);
        if (commonPanelSignature && commonPanelSignature !== panelSignature)
          throw new ComparisonOrchestrationError("COMPARISON_EVALUATOR_PANEL_MISMATCH", "Use the same evaluators, roles, conflict dispositions, and criterion assignments for every compared vendor.", 409);
        commonPanelSignature = panelSignature;
        selected.push({ ...item, ordinal, evaluation: evaluation.rows[0], reviewInputChecksum: currentReviewChecksum, scoreInputChecksum: scoreState.checksum });
      }
      const manifestBody = {
        proposal: { mongoId: input.proposalMongoId, version: mongo.proposalVersion, checksum: mongo.proposalChecksum },
        requirementSet: { id: setResult.rows[0].id, version: setResult.rows[0].version, checksum: setResult.rows[0].content_checksum },
        matrix: { id: matrixResult.rows[0].id, version: matrixResult.rows[0].version, checksum: matrixResult.rows[0].content_checksum, totalWeight: Number(matrixResult.rows[0].total_weight) },
        participants: selected.map((item) => ({ submissionId: item.submissionMongoId, versionId: item.versionMongoId, manifestChecksum: item.submissionManifestChecksum, documents: item.documents, intelligenceRunId: item.evaluation.intelligence_run_id, intelligenceChecksum: item.evaluation.intelligence_output_checksum, reviewInputChecksum: item.reviewInputChecksum, evaluationRunId: item.evaluation.id, evaluationChecksum: item.evaluation.output_checksum, scoreInputChecksum: item.scoreInputChecksum, provider: item.evaluation.provider, model: item.evaluation.model })),
        policies: { extraction: EXTRACTION_POLICY_VERSION, assessment: ASSESSMENT_VERSION, commercial: COMMERCIAL_POLICY_VERSION, scoring: SCORING_POLICY_VERSION, comparison: COMPARISON_SCHEMA_VERSION, recommendation: RECOMMENDATION_POLICY_VERSION },
        priceVisibility: input.priceVisibility,
      };
      const manifestChecksum = comparisonChecksum(manifestBody), requestKey = `comparison-request:${input.idempotencyKey}`;
      const priorRequest = await client.query<any>(
        `SELECT r.* FROM rfpilot.comparison_operations o JOIN rfpilot.comparison_runs r ON r.id=o.comparison_run_id
         WHERE o.organization_id=$1 AND o.idempotency_key=$2`, [organizationId, requestKey],
      );
      if (priorRequest.rows[0]) {
        if (priorRequest.rows[0].manifest_checksum !== manifestChecksum) throw new ComparisonOrchestrationError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for different comparison inputs.", 409);
        return { runId: priorRequest.rows[0].id, status: priorRequest.rows[0].status, created: false };
      }
      const old = await client.query<any>("SELECT * FROM rfpilot.comparison_runs WHERE organization_id=$1 AND manifest_checksum=$2", [organizationId, manifestChecksum]);
      if (old.rows[0]) {
        await client.query("INSERT INTO rfpilot.comparison_operations(id,organization_id,comparison_run_id,idempotency_key,manifest_checksum) VALUES($1,$2,$3,$4,$5)", [uuidv7(), organizationId, old.rows[0].id, requestKey, manifestChecksum]);
        return { runId: old.rows[0].id, status: old.rows[0].status, created: false };
      }
      const runId = uuidv7(), manifestId = uuidv7(), participantWeight = 80 / selected.length, aggregateNodeId = uuidv7();
      await client.query(
        `INSERT INTO rfpilot.comparison_runs(id,organization_id,proposal_reference_id,requirement_set_id,matrix_version_id,participant_count,manifest_checksum,idempotency_key,initiated_by_external_user_id,correlation_id,progress)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0)`,
        [runId, organizationId, proposalReferenceId, input.requirementSetId, input.matrixVersionId, selected.length, manifestChecksum, `comparison:${manifestChecksum}`, input.actorUserMongoId, input.correlationId],
      );
      await client.query("INSERT INTO rfpilot.comparison_operations(id,organization_id,comparison_run_id,idempotency_key,manifest_checksum) VALUES($1,$2,$3,$4,$5)", [uuidv7(), organizationId, runId, requestKey, manifestChecksum]);
      await client.query(
        `INSERT INTO rfpilot.comparison_manifests(id,organization_id,comparison_run_id,proposal_mongo_id,proposal_version,proposal_checksum,requirement_set_version,requirement_checksum,matrix_version,matrix_checksum,price_visibility,commercial_policy_version,extraction_policy_version,assessment_schema_version,scoring_policy_version,manifest,content_checksum)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)`,
        [manifestId, organizationId, runId, input.proposalMongoId, mongo.proposalVersion, mongo.proposalChecksum, setResult.rows[0].version, setResult.rows[0].content_checksum, matrixResult.rows[0].version, matrixResult.rows[0].content_checksum, input.priceVisibility, COMMERCIAL_POLICY_VERSION, EXTRACTION_POLICY_VERSION, ASSESSMENT_VERSION, SCORING_POLICY_VERSION, JSON.stringify(manifestBody), manifestChecksum],
      );
      const parentNodes = [];
      for (const item of selected) {
        const participantId = uuidv7(), nodeId = uuidv7(), inputChecksum = comparisonChecksum({ evaluationRunId: item.evaluation.id, evaluationChecksum: item.evaluation.output_checksum, reviewInputChecksum: item.reviewInputChecksum, scoreInputChecksum: item.scoreInputChecksum, participantSchema: PARTICIPANT_SCHEMA_VERSION });
        await client.query(
          `INSERT INTO rfpilot.comparison_participants(id,organization_id,comparison_run_id,vendor_submission_mongo_id,vendor_submission_version_mongo_id,vendor_label,submission_manifest_checksum,intelligence_run_id,evaluation_run_id,ordinal)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [participantId, organizationId, runId, item.submissionMongoId, item.versionMongoId, item.vendorLabel, item.submissionManifestChecksum, item.evaluation.intelligence_run_id, item.evaluation.id, item.ordinal],
        );
        const jobId = await queueJob(client, { organizationId, organizationMongoId: input.organizationMongoId, actorUserMongoId: input.actorUserMongoId, proposalReferenceId, jobType: "comparison_participant_snapshot", inputReference: participantId, inputChecksum, stableKey: `comparison-participant:${runId}:${participantId}:${inputChecksum}`, correlationId: input.correlationId });
        await client.query(
          `INSERT INTO rfpilot.comparison_job_nodes(id,organization_id,comparison_run_id,participant_id,node_key,job_type,ai_job_id,status,weight,input_checksum)
           VALUES($1,$2,$3,$4,$5,'comparison_participant_snapshot',$6,'queued',$7,$8)`,
          [nodeId, organizationId, runId, participantId, `participant:${item.ordinal}`, jobId, participantWeight, inputChecksum],
        );
        parentNodes.push(nodeId);
      }
      await client.query(
        `INSERT INTO rfpilot.comparison_job_nodes(id,organization_id,comparison_run_id,node_key,job_type,status,weight,input_checksum)
         VALUES($1,$2,$3,'aggregate','comparison_aggregate','waiting',20,$4)`,
        [aggregateNodeId, organizationId, runId, comparisonChecksum({ manifestChecksum, participantCount: selected.length, schema: COMPARISON_SCHEMA_VERSION })],
      );
      for (const parentId of parentNodes) await client.query(
        "INSERT INTO rfpilot.comparison_job_dependencies(id,organization_id,comparison_run_id,parent_node_id,child_node_id) VALUES($1,$2,$3,$4,$5)",
        [uuidv7(), organizationId, runId, parentId, aggregateNodeId],
      );
      await audit(client, input, organizationId, "comparison.created", runId, { participantCount: selected.length, manifestChecksum, requestIdempotencyKey: input.idempotencyKey });
      return { runId, status: "running", created: true };
    });
  },

  async executeParticipant(input: { organizationMongoId: string; actorUserMongoId: string; participantId: string }) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId);
      const participantResult = await client.query<any>("SELECT * FROM rfpilot.comparison_participants WHERE id=$1 FOR UPDATE", [input.participantId]);
      const participant = participantResult.rows[0];
      if (!participant) throw new ComparisonOrchestrationError("COMPARISON_PARTICIPANT_NOT_FOUND", "Comparison participant was not found.", 404);
      const existing = await client.query<any>("SELECT * FROM rfpilot.comparison_participant_results WHERE participant_id=$1", [participant.id]);
      if (existing.rows[0]) return { resultReference: participant.id };
      const runResult = await client.query<any>("SELECT * FROM rfpilot.comparison_runs WHERE id=$1", [participant.comparison_run_id]);
      if (["cancelling", "cancelled"].includes(runResult.rows[0]?.status)) throw new ComparisonOrchestrationError("COMPARISON_CANCELLED", "Comparison was cancelled.", 409);
      await client.query("UPDATE rfpilot.comparison_participants SET status='running',updated_at=now() WHERE id=$1", [participant.id]);
      const [assessments, risks, commercial, scoreSummary] = await Promise.all([
        client.query<any>(`SELECT verdict,count(*)::int count,count(*) FILTER(WHERE needs_human_review)::int review_count FROM rfpilot.ai_assessments WHERE evaluation_run_id=$1 GROUP BY verdict ORDER BY verdict`, [participant.evaluation_run_id]),
        client.query<any>(`SELECT severity,category,count(*)::int count FROM rfpilot.evaluation_risks WHERE evaluation_run_id=$1 GROUP BY severity,category ORDER BY severity,category`, [participant.evaluation_run_id]),
        client.query<any>(`SELECT s.submitted_total,s.submitted_currency,n.comparable,n.normalized_total,n.currency normalized_currency,n.arithmetic_status,n.assumptions,n.refusal_codes,n.policy_version FROM rfpilot.commercial_submissions s JOIN rfpilot.commercial_normalizations n ON n.commercial_submission_id=s.id WHERE s.evaluation_run_id=$1`, [participant.evaluation_run_id]),
        client.query<any>(`WITH latest AS (
          SELECT DISTINCT ON(s.assignment_id,s.criterion_id) s.assignment_id,s.criterion_id,s.event_type,s.score,s.weighted_contribution,
                 s.rubric_maximum,s.criterion_weight
          FROM rfpilot.evaluator_score_events s WHERE s.evaluation_run_id=$1
          ORDER BY s.assignment_id,s.criterion_id,s.created_at DESC,s.id DESC
        ), eligible AS (
          SELECT l.* FROM latest l JOIN rfpilot.evaluation_assignments a ON a.id=l.assignment_id
          WHERE a.role<>'observer' AND a.conflict_status='clear' AND l.event_type IN('submitted','superseded')
        ), criterion_means AS (
          SELECT e.criterion_id,c.name,avg(e.score) mean_score,avg(e.weighted_contribution) mean_contribution,
                 max(e.score)-min(e.score) score_spread,max(e.rubric_maximum) rubric_maximum,
                 max(e.criterion_weight) original_weight
          FROM eligible e JOIN rfpilot.evaluation_criteria c ON c.id=e.criterion_id
          GROUP BY e.criterion_id,c.name
        ) SELECT
          (SELECT count(*)::int FROM eligible) submitted_scores,
          (SELECT count(DISTINCT assignment_id)::int FROM eligible) submitted_evaluators,
          coalesce((SELECT max(score_spread) FROM criterion_means),0)::numeric max_criterion_spread,
          coalesce((SELECT sum(mean_contribution) FROM criterion_means),0)::numeric contribution_total,
          coalesce((SELECT jsonb_agg(jsonb_build_object(
            'criterionId',criterion_id,'name',name,'meanScore',mean_score,
            'meanWeightedContribution',mean_contribution,'spread',score_spread,
            'rubricMaximum',rubric_maximum,'originalWeight',original_weight
          ) ORDER BY name,criterion_id) FROM criterion_means),'[]'::jsonb) criterion_scores`, [participant.evaluation_run_id]),
      ]);
      const result = { participantId: participant.id, vendorLabel: participant.vendor_label, submissionId: participant.vendor_submission_mongo_id, versionId: participant.vendor_submission_version_mongo_id, evaluationRunId: participant.evaluation_run_id, assessments: assessments.rows, risks: risks.rows, commercial: commercial.rows[0] ?? null, evaluation: scoreSummary.rows[0], schemaVersion: PARTICIPANT_SCHEMA_VERSION };
      const outputChecksum = comparisonChecksum(result), resultId = uuidv7();
      await client.query("INSERT INTO rfpilot.comparison_participant_results(id,organization_id,comparison_run_id,participant_id,result,content_checksum) VALUES($1,$2,$3,$4,$5::jsonb,$6)", [resultId, organizationId, participant.comparison_run_id, participant.id, JSON.stringify(result), outputChecksum]);
      await client.query("UPDATE rfpilot.comparison_participants SET status='succeeded',current_stage='completed',output_checksum=$2,completed_at=now(),updated_at=now() WHERE id=$1", [participant.id, outputChecksum]);
      return { resultReference: participant.id };
    });
  },

  async executeAggregate(input: { organizationMongoId: string; actorUserMongoId: string; runId: string }) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId);
      const runResult = await client.query<any>("SELECT * FROM rfpilot.comparison_runs WHERE id=$1 FOR UPDATE", [input.runId]), run = runResult.rows[0];
      if (!run) throw new ComparisonOrchestrationError("COMPARISON_NOT_FOUND", "Comparison was not found.", 404);
      const existing = await client.query<any>("SELECT * FROM rfpilot.comparison_snapshots WHERE comparison_run_id=$1", [run.id]);
      if (existing.rows[0]) return { resultReference: run.id };
      const results = await client.query<any>(`SELECT p.ordinal,r.result,r.content_checksum FROM rfpilot.comparison_participants p JOIN rfpilot.comparison_participant_results r ON r.participant_id=p.id WHERE p.comparison_run_id=$1 ORDER BY p.ordinal`, [run.id]);
      if (results.rows.length !== run.participant_count) throw new ComparisonOrchestrationError("COMPARISON_NOT_READY", "Participant snapshots are incomplete.", 409, true);
      const requirementMatrix = await client.query<any>(
        `SELECT r.id requirement_id,r.title,r.mandatory_status,r.eligibility,p.id participant_id,p.vendor_label,a.verdict,a.needs_human_review
         FROM rfpilot.comparison_participants p JOIN rfpilot.ai_assessments a ON a.evaluation_run_id=p.evaluation_run_id
         JOIN rfpilot.requirements r ON r.id=a.requirement_id WHERE p.comparison_run_id=$1 ORDER BY r.ordinal,p.ordinal`, [run.id],
      );
      const risks = await client.query<any>(
        `SELECT p.id participant_id,p.vendor_label,x.id risk_id,x.category,x.severity,x.title,x.basis,c.question
         FROM rfpilot.comparison_participants p JOIN rfpilot.evaluation_risks x ON x.evaluation_run_id=p.evaluation_run_id
         LEFT JOIN rfpilot.clarification_candidates c ON c.risk_id=x.id WHERE p.comparison_run_id=$1 ORDER BY p.ordinal,x.ordinal`, [run.id],
      );
      const participantResults = results.rows.map((row) => row.result);
      const recommendation = buildVendorRecommendation({
        participants: participantResults.map((participant) => ({
          participantId: String(participant.participantId), vendorLabel: String(participant.vendorLabel),
          score: Number(participant.evaluation?.contribution_total ?? 0),
          evaluatorCount: Number(participant.evaluation?.submitted_evaluators ?? 0),
          maxCriterionSpread: Number(participant.evaluation?.max_criterion_spread ?? 0),
        })),
        requirements: requirementMatrix.rows.map((row) => ({
          participantId: row.participant_id, eligibility: row.eligibility === true, mandatoryStatus: row.mandatory_status,
          verdict: row.verdict, needsHumanReview: row.needs_human_review === true,
        })),
        risks: risks.rows.map((row) => ({ participantId: row.participant_id, severity: row.severity })),
      });
      const snapshot = { schemaVersion: COMPARISON_SCHEMA_VERSION, runId: run.id, participants: participantResults, requirementMatrix: requirementMatrix.rows, risks: risks.rows, recommendation, generatedFrom: results.rows.map((row) => row.content_checksum) };
      const outputChecksum = comparisonChecksum(snapshot);
      await client.query("INSERT INTO rfpilot.comparison_snapshots(id,organization_id,comparison_run_id,snapshot,content_checksum) VALUES($1,$2,$3,$4::jsonb,$5)", [uuidv7(), organizationId, run.id, JSON.stringify(snapshot), outputChecksum]);
      await client.query("UPDATE rfpilot.comparison_runs SET status=CASE WHEN jsonb_array_length(warnings)>0 THEN 'succeeded_with_warnings' ELSE 'succeeded' END,progress=100,progress_stage='completed',snapshot_checksum=$2,completed_at=now(),updated_at=now() WHERE id=$1", [run.id, outputChecksum]);
      return { resultReference: run.id };
    });
  },

  async onJobSettled(input: { organizationMongoId: string; actorUserMongoId: string; jobId: string }) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId);
      const nodeResult = await client.query<any>("SELECT n.comparison_run_id FROM rfpilot.comparison_job_nodes n WHERE n.ai_job_id=$1", [input.jobId]);
      if (!nodeResult.rows[0]) return { comparison: false };
      const runResult = await client.query<any>("SELECT * FROM rfpilot.comparison_runs WHERE id=$1 FOR UPDATE", [nodeResult.rows[0].comparison_run_id]), run = runResult.rows[0];
      await syncGraph(client, run.id);
      const refreshed = await client.query<any>("SELECT * FROM rfpilot.comparison_runs WHERE id=$1", [run.id]);
      await materializeAggregate(client, { organizationId, organizationMongoId: input.organizationMongoId, actorUserMongoId: input.actorUserMongoId, run: refreshed.rows[0] });
      return { comparison: true, runId: run.id };
    });
  },

  async list(input: Context) {
    const mongoProposal = await loadMongoInputs(input, []);
    return withPostgresTransaction(async (client) => {
      await tenant(client, input.organizationMongoId); const proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId);
      const result = await client.query<any>("SELECT * FROM rfpilot.comparison_runs WHERE proposal_reference_id=$1 ORDER BY created_at DESC LIMIT 50", [proposalReferenceId]);
      const views = [];
      for (const row of result.rows) {
        const participantRows = await client.query<any>("SELECT vendor_submission_mongo_id submission_mongo_id,vendor_submission_version_mongo_id version_mongo_id FROM rfpilot.comparison_participants WHERE comparison_run_id=$1", [row.id]);
        const mongo = await loadMongoInputs(input, participantRows.rows.map((item) => ({ submissionMongoId: item.submission_mongo_id, versionMongoId: item.version_mongo_id })));
        await currentFreshness(client, row, { ...mongo, proposal: mongoProposal.proposal, proposalVersion: mongoProposal.proposalVersion, proposalChecksum: mongoProposal.proposalChecksum });
        const refreshed = await client.query<any>("SELECT * FROM rfpilot.comparison_runs WHERE id=$1", [row.id]);
        views.push(await projection(client, refreshed.rows[0]));
      }
      return views;
    });
  },

  async read(input: Context & { runId: string }) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId), proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId);
      let run = await runRow(client, proposalReferenceId, input.runId);
      await syncGraph(client, run.id);
      run = (await client.query<any>("SELECT * FROM rfpilot.comparison_runs WHERE id=$1", [run.id])).rows[0];
      await materializeAggregate(client, { organizationId, organizationMongoId: input.organizationMongoId, actorUserMongoId: input.actorUserMongoId, run });
      const participantRows = await client.query<any>("SELECT vendor_submission_mongo_id submission_mongo_id,vendor_submission_version_mongo_id version_mongo_id FROM rfpilot.comparison_participants WHERE comparison_run_id=$1", [run.id]);
      const mongo = await loadMongoInputs(input, participantRows.rows.map((item) => ({ submissionMongoId: item.submission_mongo_id, versionMongoId: item.version_mongo_id })));
      await currentFreshness(client, run, mongo);
      run = (await client.query<any>("SELECT * FROM rfpilot.comparison_runs WHERE id=$1", [run.id])).rows[0];
      const value = await projection(client, run, true);
      return { ...value, proposal: { proposalId: input.proposalMongoId, title: String(mongo.proposal?.event?.eventName || "Proposal") } };
    });
  },

  async recordDecision(input: Context & { runId: string; decisionType: "shortlist" | "selection" | "no_award"; selectedParticipantIds: string[]; rationale: string; acknowledgeStale: boolean; idempotencyKey: string }) {
    const rationale = input.rationale.trim();
    if (rationale.length < 20 || rationale.length > 5000) throw new ComparisonOrchestrationError("DECISION_RATIONALE_REQUIRED", "Provide a decision rationale between 20 and 5,000 characters.");
    const selected = [...new Set(input.selectedParticipantIds)].sort();
    if (selected.length !== input.selectedParticipantIds.length) throw new ComparisonOrchestrationError("DECISION_PARTICIPANTS_INVALID", "A participant may be selected only once.");
    if (input.decisionType === "selection" && selected.length !== 1) throw new ComparisonOrchestrationError("DECISION_PARTICIPANTS_INVALID", "A final selection must identify exactly one vendor.");
    if (input.decisionType === "shortlist" && selected.length < 1) throw new ComparisonOrchestrationError("DECISION_PARTICIPANTS_INVALID", "A shortlist must identify at least one vendor.");
    if (input.decisionType === "no_award" && selected.length) throw new ComparisonOrchestrationError("DECISION_PARTICIPANTS_INVALID", "A no-award decision cannot identify a selected vendor.");
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId), proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId);
      let run = await runRow(client, proposalReferenceId, input.runId);
      if (!["succeeded", "succeeded_with_warnings"].includes(run.status)) throw new ComparisonOrchestrationError("DECISION_RUN_NOT_COMPLETE", "A decision can be recorded only after the comparison is complete.", 409);
      const participantRows = await client.query<any>("SELECT id,vendor_submission_mongo_id submission_mongo_id,vendor_submission_version_mongo_id version_mongo_id FROM rfpilot.comparison_participants WHERE comparison_run_id=$1", [run.id]);
      const participantIds = new Set(participantRows.rows.map((row) => String(row.id)));
      if (selected.some((id) => !participantIds.has(id))) throw new ComparisonOrchestrationError("DECISION_PARTICIPANTS_INVALID", "The decision contains a vendor outside this comparison.");
      const mongo = await loadMongoInputs(input, participantRows.rows.map((row) => ({ submissionMongoId: row.submission_mongo_id, versionMongoId: row.version_mongo_id })));
      await currentFreshness(client, run, mongo);
      run = (await client.query<any>("SELECT * FROM rfpilot.comparison_runs WHERE id=$1", [run.id])).rows[0];
      if (Array.isArray(run.stale_reasons) && run.stale_reasons.includes("evaluation_incomplete"))
        throw new ComparisonOrchestrationError("COMPARISON_EVALUATION_INCOMPLETE", "Complete every eligible evaluator scorecard before recording a vendor decision.", 409);
      if (run.freshness_state === "stale" && !input.acknowledgeStale) throw new ComparisonOrchestrationError("STALE_ACKNOWLEDGEMENT_REQUIRED", "Acknowledge that this historical comparison is stale before recording the decision.", 409);
      const operationKey = `comparison-decision:${input.idempotencyKey}`;
      const prior = await client.query<any>("SELECT * FROM rfpilot.comparison_decisions WHERE organization_id=$1 AND idempotency_key=$2", [organizationId, operationKey]);
      if (prior.rows[0]) {
        const priorSelected = Array.isArray(prior.rows[0].selected_participant_ids) ? [...prior.rows[0].selected_participant_ids].map(String).sort() : [];
        if (prior.rows[0].comparison_run_id !== run.id || prior.rows[0].decision_type !== input.decisionType || JSON.stringify(priorSelected) !== JSON.stringify(selected) || prior.rows[0].rationale !== rationale)
          throw new ComparisonOrchestrationError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different decision.", 409);
        return { decisionId: prior.rows[0].id, created: false };
      }
      const manifest = await client.query<any>("SELECT content_checksum FROM rfpilot.comparison_manifests WHERE comparison_run_id=$1", [run.id]);
      const latest = await client.query<any>("SELECT id FROM rfpilot.comparison_decisions WHERE comparison_run_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [run.id]);
      const decisionId = uuidv7();
      await client.query(
        `INSERT INTO rfpilot.comparison_decisions(
           id,organization_id,comparison_run_id,decision_type,selected_participant_ids,rationale,stale_acknowledged,
           manifest_checksum,supersedes_decision_id,actor_external_user_id,idempotency_key,correlation_id
         ) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)`,
        [decisionId, organizationId, run.id, input.decisionType, JSON.stringify(selected), rationale, run.freshness_state === "stale", manifest.rows[0].content_checksum, latest.rows[0]?.id ?? null, input.actorUserMongoId, operationKey, input.correlationId],
      );
      await audit(client, input, organizationId, "comparison.decision.recorded", run.id, { decisionId, decisionType: input.decisionType, selectedParticipantIds: selected, staleAcknowledged: run.freshness_state === "stale", supersedesDecisionId: latest.rows[0]?.id ?? null });
      return { decisionId, created: true };
    });
  },

  async cancel(input: Context & { runId: string }) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId), proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId), run = await runRow(client, proposalReferenceId, input.runId);
      if (["succeeded", "succeeded_with_warnings", "failed", "cancelled"].includes(run.status)) return { runId: run.id, status: run.status };
      await client.query("UPDATE rfpilot.comparison_runs SET status='cancelling',progress_stage='cancelling',cancellation_requested_at=now(),updated_at=now() WHERE id=$1", [run.id]);
      await client.query(`UPDATE rfpilot.ai_jobs SET cancellation_requested_at=now(),cancelled_by_external_user_id=$2,status=CASE WHEN status IN('queued','retry_scheduled') THEN 'cancelled' ELSE status END,completed_at=CASE WHEN status IN('queued','retry_scheduled') THEN now() ELSE completed_at END,updated_at=now() WHERE id IN(SELECT ai_job_id FROM rfpilot.comparison_job_nodes WHERE comparison_run_id=$1 AND ai_job_id IS NOT NULL) AND status NOT IN('succeeded','failed','cancelled','dead_letter')`, [run.id, input.actorUserMongoId]);
      await client.query("UPDATE rfpilot.comparison_job_nodes SET status='cancelled',updated_at=now() WHERE comparison_run_id=$1 AND status IN('waiting','queued','retry_scheduled')", [run.id]);
      await client.query("UPDATE rfpilot.comparison_participants SET status='cancelled',current_stage='cancelled',updated_at=now() WHERE comparison_run_id=$1 AND status='queued'", [run.id]);
      const active = await client.query<{ count: number }>("SELECT count(*)::int count FROM rfpilot.ai_jobs WHERE id IN(SELECT ai_job_id FROM rfpilot.comparison_job_nodes WHERE comparison_run_id=$1) AND status='running'", [run.id]);
      const status = Number(active.rows[0]?.count ?? 0) ? "cancelling" : "cancelled";
      if (status === "cancelled") await client.query("UPDATE rfpilot.comparison_runs SET status='cancelled',progress_stage='cancelled',completed_at=now(),updated_at=now() WHERE id=$1", [run.id]);
      await audit(client, input, organizationId, "comparison.cancelled", run.id, { status });
      return { runId: run.id, status };
    });
  },

  async retry(input: Context & { runId: string; idempotencyKey: string; reason: string }) {
    if (input.reason.trim().length < 3) throw new ComparisonOrchestrationError("RECOVERY_REASON_REQUIRED", "A retry reason is required.");
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId), proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId), run = await runRow(client, proposalReferenceId, input.runId);
      if (run.status !== "failed") throw new ComparisonOrchestrationError("INVALID_COMPARISON_STATE", "Only a failed comparison can be retried.", 409);
      const failed = await client.query<any>("SELECT n.id,n.ai_job_id,j.* FROM rfpilot.comparison_job_nodes n JOIN rfpilot.ai_jobs j ON j.id=n.ai_job_id WHERE n.comparison_run_id=$1 AND n.status IN('failed','dead_letter')", [run.id]);
      if (!failed.rows.length) throw new ComparisonOrchestrationError("COMPARISON_RETRY_UNAVAILABLE", "No failed comparison branch is available to retry.", 409);
      for (const row of failed.rows) {
        await client.query("UPDATE rfpilot.ai_jobs SET status='queued',attempt_count=0,error_code=NULL,cancellation_requested_at=NULL,cancelled_by_external_user_id=NULL,available_at=now(),completed_at=NULL,updated_at=now() WHERE id=$1", [row.ai_job_id]);
        const org = await client.query<{ external_mongo_id: string }>("SELECT external_mongo_id FROM rfpilot.organizations WHERE id=$1", [organizationId]);
        const payload = { jobId: row.ai_job_id, organizationMongoId: org.rows[0].external_mongo_id, actorUserMongoId: input.actorUserMongoId, jobType: row.job_type, inputReference: row.input_reference, inputVersion: row.input_version, correlationId: input.correlationId };
        await client.query("INSERT INTO rfpilot.outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,idempotency_key,payload) VALUES($1,$2,'ai_job',$3,'job.queued',$4,$5::jsonb) ON CONFLICT(organization_id,idempotency_key) DO NOTHING", [uuidv7(), organizationId, row.ai_job_id, `comparison.retry:${row.ai_job_id}:${input.idempotencyKey}`, JSON.stringify(payload)]);
        await client.query("UPDATE rfpilot.comparison_job_nodes SET status='queued',safe_error_code=NULL,updated_at=now() WHERE id=$1", [row.id]);
      }
      await client.query("UPDATE rfpilot.comparison_runs SET status='running',progress_stage='participant_snapshots',completed_at=NULL,updated_at=now() WHERE id=$1", [run.id]);
      await audit(client, input, organizationId, "comparison.retried", run.id, { reason: input.reason.trim().slice(0, 500), failedBranchCount: failed.rows.length });
      return { runId: run.id, status: "running", retriedBranches: failed.rows.length };
    });
  },
};
