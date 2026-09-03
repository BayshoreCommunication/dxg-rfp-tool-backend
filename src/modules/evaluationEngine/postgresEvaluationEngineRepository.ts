/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import VendorSubmission from "../../../modal/vendorSubmissionModel";
import VendorSubmissionVersion from "../../../modal/vendorSubmissionVersionModel";
import {
  aggregateCriterionScores, applyHumanReviews, ASSESSMENT_VERSION, AUTOMATED_SCORING_POLICY_VERSION, buildAssessments, buildRisks, calculateContribution, checksum, coverageEligibility, deriveAutomatedCriterionScore,
  COMMERCIAL_POLICY_VERSION, EvaluationEngineError, normalizeCommercial, RISK_POLICY_VERSION,
  rubricAnchors, rubricMaximum, SCORING_POLICY_VERSION, type FactInput, type MappingInput,
} from "./domain";
import {
  LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY,
  proposalWorkflowSectionEnabled,
} from "../proposals/domain/workflowSections";
import { REQUIREMENT_GENERATOR_VERSION } from "../requirementRegistry/generator";

type Context = { organizationMongoId: string; actorUserMongoId: string; proposalMongoId: string; submissionMongoId: string; versionMongoId: string; correlationId: string };
const tenant = async (client: PoolClient, organizationMongoId: string) => {
  await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [organizationMongoId]);
  const result = await client.query<{ id: string }>("SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'", [organizationMongoId]);
  if (!result.rows[0]) throw new EvaluationEngineError("ORGANIZATION_NOT_READY", "Organization unavailable.", 503);
  await client.query("SELECT set_config('app.organization_id',$1,true)", [result.rows[0].id]);
  return result.rows[0].id;
};
const proposal = async (client: PoolClient, proposalMongoId: string) => {
  const result = await client.query<{ id: string; owner_external_user_id: string }>(
    `SELECT p.id,u.external_mongo_id owner_external_user_id FROM rfpilot.proposal_references p
     JOIN rfpilot.users u ON u.id=p.owner_user_id WHERE p.external_mongo_id=$1`, [proposalMongoId],
  );
  if (!result.rows[0]) throw new EvaluationEngineError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  return result.rows[0];
};
const loadVersion = async (input: Context, requireOwner: boolean) => {
  const submission = await VendorSubmission.findOne({
    _id: input.submissionMongoId, organizationId: input.organizationMongoId, proposalId: input.proposalMongoId,
    ...(requireOwner ? { proposalOwnerId: input.actorUserMongoId } : {}),
  }).select("_id").lean();
  if (!submission) throw new EvaluationEngineError("VENDOR_SUBMISSION_NOT_FOUND", "Vendor submission was not found.", 404);
  const version = await VendorSubmissionVersion.findOne({ _id: input.versionMongoId, organizationId: input.organizationMongoId, proposalId: input.proposalMongoId, submissionId: input.submissionMongoId }).select("manifestChecksum").lean<any>();
  if (!version) throw new EvaluationEngineError("SUBMISSION_VERSION_NOT_FOUND", "Vendor submission version was not found.", 404);
  return version as { manifestChecksum: string };
};
const audit = (client: PoolClient, input: Context, organizationId: string, action: string, targetId: string, metadata: Record<string, unknown>) => client.query(
  `INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata)
   VALUES($1,$2,$3,$4,'vendor_evaluation_run',$5,'allow',$6,$7::jsonb)`,
  [uuidv7(), organizationId, input.actorUserMongoId, action, targetId, input.correlationId, JSON.stringify(metadata)],
);
const access = async (client: PoolClient, runId: string, actor: string, owner: string) => {
  if (actor === owner) return { owner: true, assignmentId: null as string | null };
  const assignment = await client.query<{ id: string }>("SELECT id FROM rfpilot.evaluation_assignments WHERE evaluation_run_id=$1 AND evaluator_external_user_id=$2", [runId, actor]);
  if (!assignment.rows[0]) throw new EvaluationEngineError("EVALUATION_ACCESS_DENIED", "You are not assigned to this evaluation.", 403);
  return { owner: false, assignmentId: assignment.rows[0].id };
};
const latestRun = async (client: PoolClient, proposalReferenceId: string, versionMongoId: string, runId?: string | null) => {
  const result = runId
    ? await client.query<any>(`SELECT e.* FROM rfpilot.vendor_evaluation_runs e
       JOIN rfpilot.requirement_sets s ON s.id=e.requirement_set_id AND s.generator_version=$4
       WHERE e.id=$1 AND e.proposal_reference_id=$2 AND e.vendor_submission_version_mongo_id=$3
         AND e.assessment_version=$5 AND e.risk_policy_version=$6
         AND e.commercial_policy_version=$7 AND e.scoring_policy_version=$8`, [runId, proposalReferenceId, versionMongoId, REQUIREMENT_GENERATOR_VERSION, ASSESSMENT_VERSION, RISK_POLICY_VERSION, COMMERCIAL_POLICY_VERSION, SCORING_POLICY_VERSION])
    : await client.query<any>(`SELECT e.* FROM rfpilot.vendor_evaluation_runs e
       JOIN rfpilot.requirement_sets s ON s.id=e.requirement_set_id AND s.generator_version=$3
       WHERE e.proposal_reference_id=$1 AND e.vendor_submission_version_mongo_id=$2
         AND e.assessment_version=$4 AND e.risk_policy_version=$5
         AND e.commercial_policy_version=$6 AND e.scoring_policy_version=$7
       ORDER BY e.created_at DESC LIMIT 1`, [proposalReferenceId, versionMongoId, REQUIREMENT_GENERATOR_VERSION, ASSESSMENT_VERSION, RISK_POLICY_VERSION, COMMERCIAL_POLICY_VERSION, SCORING_POLICY_VERSION]);
  if (!result.rows[0]) throw new EvaluationEngineError("EVALUATION_RUN_NOT_FOUND", "Vendor evaluation has not been generated.", 404);
  return result.rows[0];
};
export const evaluationEngineRepository = {
  async create(input: Context & { intelligenceRunId?: string | null; sealedPrice: boolean; idempotencyKey: string }) {
    await loadVersion(input, true);
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId);
      const proposalRow = await proposal(client, input.proposalMongoId);
      if (proposalRow.owner_external_user_id !== input.actorUserMongoId) throw new EvaluationEngineError("EVALUATION_ACCESS_DENIED", "Only the proposal owner can create an evaluation.", 403);
      const intelligenceResult = input.intelligenceRunId
        ? await client.query<any>(`SELECT i.* FROM rfpilot.vendor_intelligence_runs i
           JOIN rfpilot.requirement_sets s ON s.id=i.requirement_set_id AND s.generator_version=$4
           WHERE i.id=$1 AND i.proposal_reference_id=$2 AND i.vendor_submission_version_mongo_id=$3 AND i.status='succeeded'`, [input.intelligenceRunId, proposalRow.id, input.versionMongoId, REQUIREMENT_GENERATOR_VERSION])
        : await client.query<any>(`SELECT i.* FROM rfpilot.vendor_intelligence_runs i
           JOIN rfpilot.requirement_sets s ON s.id=i.requirement_set_id AND s.generator_version=$3
           WHERE i.proposal_reference_id=$1 AND i.vendor_submission_version_mongo_id=$2 AND i.status='succeeded'
           ORDER BY i.created_at DESC LIMIT 1`, [proposalRow.id, input.versionMongoId, REQUIREMENT_GENERATOR_VERSION]);
      const intelligence = intelligenceResult.rows[0];
      if (!intelligence) throw new EvaluationEngineError("INTELLIGENCE_RUN_NOT_READY", "Generate and review proposal intelligence before evaluation.", 409);
      const coverage = coverageEligibility(Array.isArray(intelligence.warnings) ? intelligence.warnings : []);
      if (!coverage.eligible) throw new EvaluationEngineError("INTELLIGENCE_COVERAGE_INCOMPLETE", `Resolve source coverage before evaluation: ${coverage.blockingCodes.join(", ")}.`, 409);
      const matrixResult = await client.query<any>(
        `SELECT m.* FROM rfpilot.evaluation_matrix_versions m JOIN rfpilot.requirement_sets s ON s.id=m.requirement_set_id
         WHERE m.requirement_set_id=$1 AND m.status='approved' AND m.weights_confirmed=true AND m.total_weight=100
           AND s.status='approved' AND s.generator_version=$2`, [intelligence.requirement_set_id, REQUIREMENT_GENERATOR_VERSION],
      );
      const matrix = matrixResult.rows[0];
      if (!matrix) throw new EvaluationEngineError("SCORING_MATRIX_NOT_CONFIRMED", "A confirmed 100% evaluation matrix is required.", 409);
      const mappingRows = await client.query<any>(
        `SELECT m.requirement_id,min(m.id::text)::uuid mapping_id,r.title,r.mandatory_status,r.eligibility,
                min(m.relationship) relationship,min(m.confidence)::numeric confidence,
                jsonb_agg(m.id ORDER BY m.ordinal) mapping_ids,
                coalesce(jsonb_agg(m.evidence_fragment_id) FILTER(WHERE m.evidence_fragment_id IS NOT NULL),'[]') fragment_ids
         FROM rfpilot.requirement_evidence_mappings m JOIN rfpilot.requirements r ON r.id=m.requirement_id
         WHERE m.intelligence_run_id=$1
           AND ($2::boolean OR r.group_key IS DISTINCT FROM $3)
         GROUP BY m.requirement_id,r.title,r.mandatory_status,r.eligibility,r.ordinal ORDER BY r.ordinal`, [
          intelligence.id,
          proposalWorkflowSectionEnabled("video_recording"),
          LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY,
        ],
      );
      const factRows = await client.query<any>(
        `SELECT f.*,coalesce((SELECT jsonb_agg(e.evidence_fragment_id ORDER BY e.ordinal) FROM rfpilot.extracted_fact_evidence e WHERE e.fact_id=f.id),'[]') fragment_ids
         FROM rfpilot.extracted_facts f WHERE f.intelligence_run_id=$1 ORDER BY f.ordinal`, [intelligence.id],
      );
      const reviewRows = await client.query<any>(
        `SELECT id review_id,target_type,target_id,decision,corrected_payload
         FROM rfpilot.human_review_events WHERE intelligence_run_id=$1 ORDER BY created_at,id`,
        [intelligence.id],
      );
      const reviewInputChecksum = checksum(reviewRows.rows.map((row) => ({
        reviewId: row.review_id,
        targetType: row.target_type,
        targetId: row.target_id,
        decision: row.decision,
        correctedPayload: row.corrected_payload,
      })));
      const existingRun = await client.query<any>(
        `SELECT * FROM rfpilot.vendor_evaluation_runs
          WHERE intelligence_run_id=$1 AND matrix_version_id=$2 AND sealed_price=$3
            AND review_input_checksum=$4 AND assessment_version=$5
            AND risk_policy_version=$6 AND commercial_policy_version=$7
            AND scoring_policy_version=$8
          ORDER BY created_at DESC LIMIT 1`,
        [intelligence.id, matrix.id, input.sealedPrice, reviewInputChecksum, ASSESSMENT_VERSION, RISK_POLICY_VERSION, COMMERCIAL_POLICY_VERSION, SCORING_POLICY_VERSION],
      );
      if (existingRun.rows[0]) return { runId: existingRun.rows[0].id, created: false };
      const policyEpoch = checksum([ASSESSMENT_VERSION, RISK_POLICY_VERSION, COMMERCIAL_POLICY_VERSION, SCORING_POLICY_VERSION]);
      const stableKey = `vendor-evaluation:${intelligence.id}:${matrix.id}:${input.sealedPrice}:${reviewInputChecksum}:${policyEpoch}`;
      const old = await client.query<any>("SELECT * FROM rfpilot.vendor_evaluation_runs WHERE organization_id=$1 AND idempotency_key=$2", [organizationId, stableKey]);
      if (old.rows[0]) return { runId: old.rows[0].id, created: false };
      const rawMappings: MappingInput[] = mappingRows.rows.map((row) => ({ mappingId: row.mapping_id, mappingTargetIds: row.mapping_ids, requirementId: row.requirement_id, title: row.title, mandatory: row.mandatory_status === "mandatory", eligibility: row.eligibility === true, relationship: row.relationship, confidence: Number(row.confidence), fragmentIds: row.fragment_ids }));
      const rawFacts: FactInput[] = factRows.rows.map((row) => ({ factId: row.id, factKey: row.fact_key, family: row.family, factType: row.fact_type, statement: row.statement, valueKind: row.value_kind, normalizedValue: row.normalized_value, typedValue: row.typed_value, currency: row.currency, contradictionGroup: row.contradiction_group, fragmentIds: row.fragment_ids }));
      const effective = applyHumanReviews({
        mappings: rawMappings,
        facts: rawFacts,
        reviews: reviewRows.rows.map((row) => ({
          reviewId: row.review_id,
          targetType: row.target_type,
          targetId: row.target_id,
          decision: row.decision,
          correctedPayload: row.corrected_payload,
        })),
      });
      const mappings = effective.mappings, facts = effective.facts;
      if (!mappings.length) throw new EvaluationEngineError("ASSESSMENT_COVERAGE_EMPTY", "No requirement mappings are available for evaluation.", 409);
      const assessments = buildAssessments(mappings), risks = buildRisks(mappings, facts), commercial = normalizeCommercial(facts);
      if (!commercial.comparable) risks.push({ category: "commercial_non_comparable", severity: "high", title: "The price can't be compared yet", basis: `Normalization was refused: ${commercial.refusalCodes.join(", ")}.`, requirementId: null, factId: commercial.totalFactId, fragmentIds: [], question: "Please provide one authoritative, all-inclusive submitted total in a single currency and identify all options or exclusions." });
      const outputChecksum = checksum({ assessments, risks, commercial, reviewInputChecksum, matrix: matrix.content_checksum, policies: [ASSESSMENT_VERSION, RISK_POLICY_VERSION, COMMERCIAL_POLICY_VERSION, SCORING_POLICY_VERSION] });
      const runId = uuidv7();
      await client.query(
        `INSERT INTO rfpilot.vendor_evaluation_runs(id,organization_id,proposal_reference_id,requirement_set_id,matrix_version_id,intelligence_run_id,vendor_submission_mongo_id,vendor_submission_version_mongo_id,sealed_price,assessment_version,risk_policy_version,commercial_policy_version,scoring_policy_version,review_input_checksum,requirement_checksum,intelligence_checksum,output_checksum,assessment_count,risk_count,question_count,idempotency_key,created_by_external_user_id,correlation_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [runId, organizationId, proposalRow.id, intelligence.requirement_set_id, matrix.id, intelligence.id, input.submissionMongoId, input.versionMongoId, input.sealedPrice, ASSESSMENT_VERSION, RISK_POLICY_VERSION, COMMERCIAL_POLICY_VERSION, SCORING_POLICY_VERSION, reviewInputChecksum, matrix.content_checksum, intelligence.output_checksum, outputChecksum, assessments.length, risks.length, risks.length, stableKey, input.actorUserMongoId, input.correlationId],
      );
      const assessmentIds = new Map<string, string>();
      for (const assessment of assessments) {
        const id = uuidv7(); assessmentIds.set(assessment.requirementId, id);
        await client.query(
          `INSERT INTO rfpilot.ai_assessments(id,organization_id,evaluation_run_id,requirement_id,verdict,rationale,confidence,needs_human_review,review_reasons,assessment_version,ordinal)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
          [id, organizationId, runId, assessment.requirementId, assessment.verdict, assessment.rationale, assessment.confidence, assessment.needsHumanReview, JSON.stringify(assessment.reviewReasons), ASSESSMENT_VERSION, assessment.ordinal],
        );
        for (const [ordinal, fragmentId] of assessment.fragmentIds.entries()) await client.query(
          "INSERT INTO rfpilot.assessment_evidence(id,organization_id,assessment_id,evidence_fragment_id,support_role,ordinal) VALUES($1,$2,$3,$4,$5,$6)",
          [uuidv7(), organizationId, id, fragmentId, assessment.relationship === "contradicts" ? "contradicts" : assessment.relationship === "context_only" ? "context" : "supports", ordinal],
        );
        for (const validation of [
          { type: "verdict", outcome: "passed", code: "VERDICT_DETERMINISTIC" },
          { type: "citation", outcome: assessment.relationship === "none" ? "passed" : "passed", code: assessment.relationship === "none" ? "MISSING_WITHOUT_CITATION" : "CITATION_BOUNDARY_VALID" },
          ...(assessment.reviewReasons.includes("mandatory_disposition_required") ? [{ type: "mandatory", outcome: "warning", code: "MANDATORY_HUMAN_DISPOSITION_REQUIRED" }] : []),
        ]) await client.query("INSERT INTO rfpilot.assessment_validation_results(id,organization_id,assessment_id,check_type,outcome,reason_code) VALUES($1,$2,$3,$4,$5,$6)", [uuidv7(), organizationId, id, validation.type, validation.outcome, validation.code]);
      }
      for (const [ordinal, risk] of risks.entries()) {
        const riskId = uuidv7();
        await client.query(
          `INSERT INTO rfpilot.evaluation_risks(id,organization_id,evaluation_run_id,requirement_id,fact_id,category,severity,title,basis,policy_version,ordinal)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [riskId, organizationId, runId, risk.requirementId, risk.factId, risk.category, risk.severity, risk.title, risk.basis, RISK_POLICY_VERSION, ordinal],
        );
        for (const [evidenceOrdinal, fragmentId] of risk.fragmentIds.entries()) await client.query("INSERT INTO rfpilot.risk_evidence(id,organization_id,risk_id,evidence_fragment_id,ordinal) VALUES($1,$2,$3,$4,$5)", [uuidv7(), organizationId, riskId, fragmentId, evidenceOrdinal]);
        await client.query("INSERT INTO rfpilot.clarification_candidates(id,organization_id,evaluation_run_id,risk_id,question,generator_version,ordinal) VALUES($1,$2,$3,$4,$5,$6,$7)", [uuidv7(), organizationId, runId, riskId, risk.question, RISK_POLICY_VERSION, ordinal]);
      }
      const commercialId = uuidv7();
      await client.query("INSERT INTO rfpilot.commercial_submissions(id,organization_id,evaluation_run_id,submitted_total,submitted_currency,total_fact_id) VALUES($1,$2,$3,$4,$5,$6)", [commercialId, organizationId, runId, commercial.submittedTotal, commercial.submittedCurrency, commercial.totalFactId]);
      for (const [ordinal, fact] of commercial.commercialFacts.entries()) await client.query(
        `INSERT INTO rfpilot.commercial_line_items(id,organization_id,commercial_submission_id,fact_id,category,description,amount,currency,option_or_exclusion,ordinal)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [uuidv7(), organizationId, commercialId, fact.factId, fact.factType, fact.statement, fact.valueKind === "money" ? Number(fact.typedValue.number) : null, fact.currency, ["commercial_option", "commercial_exclusion"].includes(fact.factType), ordinal],
      );
      await client.query(
        `INSERT INTO rfpilot.commercial_normalizations(id,organization_id,commercial_submission_id,comparable,normalized_total,currency,arithmetic_status,assumptions,refusal_codes,policy_version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)`,
        [uuidv7(), organizationId, commercialId, commercial.comparable, commercial.normalizedTotal, commercial.currency, commercial.comparable ? "verified_identity" : "refused", JSON.stringify(commercial.assumptions), JSON.stringify(commercial.refusalCodes), COMMERCIAL_POLICY_VERSION],
      );
      const criteria = await client.query<any>("SELECT id FROM rfpilot.evaluation_criteria WHERE matrix_version_id=$1 ORDER BY ordinal", [matrix.id]);
      const assignmentId = uuidv7();
      await client.query("INSERT INTO rfpilot.evaluation_assignments(id,organization_id,evaluation_run_id,evaluator_external_user_id,role,assigned_by_external_user_id) VALUES($1,$2,$3,$4,'combined',$4)", [assignmentId, organizationId, runId, input.actorUserMongoId]);
      for (const criterion of criteria.rows) await client.query("INSERT INTO rfpilot.evaluation_assignment_criteria(id,organization_id,assignment_id,criterion_id) VALUES($1,$2,$3,$4)", [uuidv7(), organizationId, assignmentId, criterion.id]);
      await audit(client, input, organizationId, "vendor_evaluation.created", runId, { sealedPrice: input.sealedPrice, assessmentCount: assessments.length, riskCount: risks.length, priceComparable: commercial.comparable, requestIdempotencyKey: input.idempotencyKey });
      return { runId, created: true };
    });
  },

  async read(input: Context & { runId?: string | null }) {
    await loadVersion(input, false);
    return withPostgresTransaction(async (client) => {
      await tenant(client, input.organizationMongoId);
      const proposalRow = await proposal(client, input.proposalMongoId), run = await latestRun(client, proposalRow.id, input.versionMongoId, input.runId);
      const permission = await access(client, run.id, input.actorUserMongoId, proposalRow.owner_external_user_id);
      const assignmentResult = await client.query<any>("SELECT * FROM rfpilot.evaluation_assignments WHERE evaluation_run_id=$1 AND evaluator_external_user_id=$2", [run.id, input.actorUserMongoId]);
      const assignment = assignmentResult.rows[0] ?? null;
      const priceEvent = assignment ? await client.query<any>("SELECT decision FROM rfpilot.commercial_access_events WHERE assignment_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [assignment.id]) : { rows: [] };
      const canViewCommercial = !run.sealed_price || priceEvent.rows[0]?.decision === "granted";
      const scopedAssignmentId = permission.owner ? null : assignment?.id ?? null;
      const criteria = await client.query<any>(
        `SELECT c.*,coalesce((SELECT jsonb_agg(r.id ORDER BY r.ordinal) FROM rfpilot.requirements r
                              WHERE r.criterion_id=c.id AND r.included=true
                                AND ($3::boolean OR r.group_key IS DISTINCT FROM $4)),'[]') requirement_ids
         FROM rfpilot.evaluation_criteria c WHERE c.matrix_version_id=$1
           AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM rfpilot.evaluation_assignment_criteria ac WHERE ac.assignment_id=$2 AND ac.criterion_id=c.id))
         ORDER BY c.ordinal`, [
          run.matrix_version_id,
          scopedAssignmentId,
          proposalWorkflowSectionEnabled("video_recording"),
          LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY,
        ],
      );
      const assessments = await client.query<any>(
        `SELECT a.*,r.title requirement_title,r.mandatory_status,r.eligibility,
          coalesce((SELECT jsonb_agg(jsonb_build_object('fragmentId',e.evidence_fragment_id,'sourceLabel',s.source_label,'locator',f.locator,'content',left(f.content,1200)) ORDER BY e.ordinal)
            FROM rfpilot.assessment_evidence e JOIN rfpilot.evidence_fragments f ON f.id=e.evidence_fragment_id
            LEFT JOIN LATERAL (SELECT x.source_label FROM rfpilot.source_extraction_runs x WHERE x.vendor_submission_version_mongo_id=$2 AND coalesce(x.reused_from_run_id,x.id)=f.extraction_run_id ORDER BY x.created_at LIMIT 1) s ON true
            WHERE e.assessment_id=a.id),'[]') evidence
         FROM rfpilot.ai_assessments a JOIN rfpilot.requirements r ON r.id=a.requirement_id WHERE a.evaluation_run_id=$1
           AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM rfpilot.evaluation_assignment_criteria ac WHERE ac.assignment_id=$3 AND ac.criterion_id=r.criterion_id))
           AND ($4::boolean OR r.group_key IS DISTINCT FROM $5)
         ORDER BY a.ordinal`, [
          run.id,
          input.versionMongoId,
          scopedAssignmentId,
          proposalWorkflowSectionEnabled("video_recording"),
          LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY,
        ],
      );
      const risks = await client.query<any>(
        `SELECT x.*,coalesce((SELECT jsonb_agg(jsonb_build_object('fragmentId',e.evidence_fragment_id,'sourceLabel',s.source_label,'locator',f.locator,'content',left(f.content,1200)) ORDER BY e.ordinal)
          FROM rfpilot.risk_evidence e JOIN rfpilot.evidence_fragments f ON f.id=e.evidence_fragment_id
          LEFT JOIN LATERAL (SELECT q.source_label FROM rfpilot.source_extraction_runs q WHERE q.vendor_submission_version_mongo_id=$2 AND coalesce(q.reused_from_run_id,q.id)=f.extraction_run_id ORDER BY q.created_at LIMIT 1) s ON true WHERE e.risk_id=x.id),'[]') evidence,
          q.question FROM rfpilot.evaluation_risks x LEFT JOIN rfpilot.clarification_candidates q ON q.risk_id=x.id
         WHERE x.evaluation_run_id=$1 AND (($3::uuid IS NULL OR
           (x.requirement_id IS NOT NULL AND EXISTS(SELECT 1 FROM rfpilot.requirements r JOIN rfpilot.evaluation_assignment_criteria ac ON ac.criterion_id=r.criterion_id WHERE r.id=x.requirement_id AND ac.assignment_id=$3)) OR
           ($4::boolean=true AND x.category IN('commercial_exception','commercial_non_comparable'))))
           AND ($5::boolean OR x.requirement_id IS NULL OR NOT EXISTS(
             SELECT 1 FROM rfpilot.requirements retired
              WHERE retired.id=x.requirement_id AND retired.group_key=$6
           ))
         ORDER BY CASE x.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,x.ordinal`, [
          run.id,
          input.versionMongoId,
          scopedAssignmentId,
          canViewCommercial,
          proposalWorkflowSectionEnabled("video_recording"),
          LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY,
        ],
      );
      const assignments = await client.query<any>(
        `SELECT a.*,coalesce((SELECT jsonb_agg(c.criterion_id ORDER BY c.criterion_id) FROM rfpilot.evaluation_assignment_criteria c WHERE c.assignment_id=a.id),'[]') criterion_ids,
          coalesce((SELECT decision FROM rfpilot.commercial_access_events e WHERE e.assignment_id=a.id ORDER BY e.created_at DESC,e.id DESC LIMIT 1),CASE WHEN $2=false THEN 'granted' ELSE 'revoked' END) commercial_access
         FROM rfpilot.evaluation_assignments a WHERE a.evaluation_run_id=$1 ORDER BY a.created_at`, [run.id, run.sealed_price],
      );
      const scores = await client.query<any>(
        `SELECT DISTINCT ON (assignment_id,criterion_id) * FROM rfpilot.evaluator_score_events
         WHERE evaluation_run_id=$1 ORDER BY assignment_id,criterion_id,created_at DESC,id DESC`, [run.id],
      );
      const criterionAggregates = aggregateCriterionScores({
        criterionIds: criteria.rows.map((criterion) => criterion.id),
        assignments: assignments.rows.map((row) => ({ assignmentId: row.id, role: row.role, conflictStatus: row.conflict_status, criterionIds: row.criterion_ids })),
        scores: scores.rows.map((row) => ({ assignmentId: row.assignment_id, criterionId: row.criterion_id, eventType: row.event_type, score: Number(row.score), weightedContribution: Number(row.weighted_contribution) })),
      });
      const commercial = canViewCommercial ? await client.query<any>(
        `SELECT s.*,n.comparable,n.normalized_total,n.currency normalized_currency,n.arithmetic_status,n.assumptions,n.refusal_codes,n.policy_version,
          coalesce((SELECT jsonb_agg(jsonb_build_object('category',l.category,'description',l.description,'amount',l.amount,'currency',l.currency,'optionOrExclusion',l.option_or_exclusion,'fragmentIds',coalesce((SELECT jsonb_agg(e.evidence_fragment_id ORDER BY e.ordinal) FROM rfpilot.extracted_fact_evidence e WHERE e.fact_id=l.fact_id),'[]')) ORDER BY l.ordinal) FROM rfpilot.commercial_line_items l WHERE l.commercial_submission_id=s.id),'[]') line_items
         FROM rfpilot.commercial_submissions s JOIN rfpilot.commercial_normalizations n ON n.commercial_submission_id=s.id WHERE s.evaluation_run_id=$1`, [run.id],
      ) : { rows: [] };
      return {
        run: { runId: run.id, status: run.status, sealedPrice: run.sealed_price, assessmentCount: assessments.rows.length, riskCount: risks.rows.length, questionCount: risks.rows.filter((row) => Boolean(row.question)).length, scoringPolicyVersion: run.scoring_policy_version, createdAt: run.created_at },
        permission: { owner: permission.owner, assigned: Boolean(assignment), canViewCommercial },
        assignment: assignment ? (() => { const criterionIds = assignments.rows.find((row) => row.id === assignment.id)?.criterion_ids ?? []; const currentScores = scores.rows.filter((row) => row.assignment_id === assignment.id && ["submitted", "superseded"].includes(row.event_type)); const complete = assignment.role !== "observer" && ["clear", "not_applicable"].includes(assignment.conflict_status) && currentScores.length === criterionIds.length; return { assignmentId: assignment.id, role: assignment.role, conflictStatus: assignment.conflict_status, conflictNote: assignment.conflict_note, status: assignment.status, version: assignment.version, criterionIds, complete, overallScore: complete ? currentScores.reduce((sum, row) => sum + Number(row.weighted_contribution), 0) : null }; })() : null,
        criteria: criteria.rows.map((row) => ({ criterionId: row.id, key: row.criterion_key, name: row.name, description: row.description, weight: Number(row.weight), rubricMaximum: rubricMaximum(row.rubric), rubricAnchors: rubricAnchors(row.rubric), priceVisibility: row.price_visibility, humanOnly: row.human_only, requirementIds: row.requirement_ids })),
        assessments: assessments.rows.map((row) => ({ assessmentId: row.id, requirementId: row.requirement_id, requirementTitle: row.requirement_title, mandatory: row.mandatory_status === "mandatory", eligibility: row.eligibility, verdict: row.verdict, rationale: row.rationale, confidence: Number(row.confidence), needsHumanReview: row.needs_human_review, reviewReasons: row.review_reasons, evidence: row.evidence })),
        risks: risks.rows.map((row) => ({ riskId: row.id, category: row.category, severity: row.severity, title: row.title, basis: row.basis, question: row.question, evidence: row.evidence })),
        commercial: commercial.rows[0] ? { submittedTotal: commercial.rows[0].submitted_total === null ? null : Number(commercial.rows[0].submitted_total), submittedCurrency: commercial.rows[0].submitted_currency, comparable: commercial.rows[0].comparable, normalizedTotal: commercial.rows[0].normalized_total === null ? null : Number(commercial.rows[0].normalized_total), normalizedCurrency: commercial.rows[0].normalized_currency, arithmeticStatus: commercial.rows[0].arithmetic_status, assumptions: commercial.rows[0].assumptions, refusalCodes: commercial.rows[0].refusal_codes, policyVersion: commercial.rows[0].policy_version, lineItems: commercial.rows[0].line_items } : null,
        scores: scores.rows.filter((row) => permission.owner || row.assignment_id === assignment?.id).map((row) => ({ eventId: row.id, assignmentId: row.assignment_id, criterionId: row.criterion_id, eventType: row.event_type, score: row.score === null ? null : Number(row.score), rubricMaximum: Number(row.rubric_maximum), criterionWeight: Number(row.criterion_weight), weightedContribution: row.weighted_contribution === null ? null : Number(row.weighted_contribution), rationale: row.rationale, evidenceFragmentIds: row.evidence_fragment_ids, createdAt: row.created_at })),
        aggregates: permission.owner ? criterionAggregates : [],
        assignments: permission.owner ? assignments.rows.map((row) => { const currentScores = scores.rows.filter((score) => score.assignment_id === row.id && ["submitted", "superseded"].includes(score.event_type)); const complete = row.role !== "observer" && ["clear", "not_applicable"].includes(row.conflict_status) && currentScores.length === row.criterion_ids.length; return { assignmentId: row.id, evaluatorUserId: row.evaluator_external_user_id, role: row.role, conflictStatus: row.conflict_status, status: row.status, criterionIds: row.criterion_ids, commercialAccess: row.commercial_access, complete, overallScore: complete ? currentScores.reduce((sum, score) => sum + Number(score.weighted_contribution), 0) : null }; }) : [],
      };
    });
  },

  async completeAutomatically(input: Context & { runId: string }) {
    await loadVersion(input, true);
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId);
      const proposalRow = await proposal(client, input.proposalMongoId);
      if (proposalRow.owner_external_user_id !== input.actorUserMongoId)
        throw new EvaluationEngineError("EVALUATION_ACCESS_DENIED", "Only the proposal owner can prepare an automatic evaluation.", 403);
      const run = await latestRun(client, proposalRow.id, input.versionMongoId, input.runId);
      const assignmentResult = await client.query<any>(
        "SELECT * FROM rfpilot.evaluation_assignments WHERE evaluation_run_id=$1 AND evaluator_external_user_id=$2 FOR UPDATE",
        [run.id, input.actorUserMongoId],
      );
      const assignment = assignmentResult.rows[0];
      if (!assignment) throw new EvaluationEngineError("ASSIGNMENT_NOT_FOUND", "The proposal-owner evaluation assignment was not found.", 404);
      if (assignment.conflict_status === "conflict")
        throw new EvaluationEngineError("AUTOMATED_EVALUATION_CONFLICT", "A declared conflict must be resolved before automatic evaluation.", 409);
      const criteria = await client.query<any>(
        `SELECT c.* FROM rfpilot.evaluation_criteria c
         JOIN rfpilot.evaluation_assignment_criteria ac ON ac.criterion_id=c.id
         WHERE ac.assignment_id=$1 AND c.matrix_version_id=$2 ORDER BY c.ordinal`,
        [assignment.id, run.matrix_version_id],
      );
      const assessments = await client.query<any>(
        `SELECT a.id,a.verdict,r.criterion_id,r.mandatory_status,r.eligibility,
                coalesce((SELECT jsonb_agg(e.evidence_fragment_id ORDER BY e.ordinal) FROM rfpilot.assessment_evidence e WHERE e.assessment_id=a.id),'[]') fragment_ids
         FROM rfpilot.ai_assessments a JOIN rfpilot.requirements r ON r.id=a.requirement_id
         WHERE a.evaluation_run_id=$1 ORDER BY a.ordinal`,
        [run.id],
      );
      const latestScores = await client.query<any>(
        `SELECT DISTINCT ON(criterion_id) * FROM rfpilot.evaluator_score_events
         WHERE assignment_id=$1 ORDER BY criterion_id,created_at DESC,id DESC`,
        [assignment.id],
      );
      const submitted = new Set(latestScores.rows.filter((row) => ["submitted", "superseded"].includes(row.event_type)).map((row) => String(row.criterion_id)));
      const hasHumanSubmittedScore = latestScores.rows.some((row) =>
        ["submitted", "superseded"].includes(row.event_type)
        && row.scoring_policy_version !== AUTOMATED_SCORING_POLICY_VERSION);
      let createdCount = 0;
      for (const criterion of criteria.rows) {
        if (submitted.has(String(criterion.id))) continue;
        const derived = deriveAutomatedCriterionScore({
          criterionName: String(criterion.name),
          rubricMaximum: rubricMaximum(criterion.rubric),
          assessments: assessments.rows.filter((assessment) => assessment.criterion_id === criterion.id).map((assessment) => ({
            verdict: String(assessment.verdict),
            mandatory: assessment.mandatory_status === "mandatory",
            eligibility: assessment.eligibility === true,
            evidenceFragmentIds: Array.isArray(assessment.fragment_ids) ? assessment.fragment_ids.map(String) : [],
          })),
        });
        const maximum = rubricMaximum(criterion.rubric), weight = Number(criterion.weight);
        const idempotencyKey = `automatic-score:${run.id}:${assignment.id}:${criterion.id}:${AUTOMATED_SCORING_POLICY_VERSION}`;
        const old = await client.query<{ id: string }>("SELECT id FROM rfpilot.evaluator_score_events WHERE organization_id=$1 AND idempotency_key=$2", [organizationId, idempotencyKey]);
        if (old.rows[0]) continue;
        await client.query(
          `INSERT INTO rfpilot.evaluator_score_events(id,organization_id,evaluation_run_id,assignment_id,criterion_id,event_type,score,rubric_maximum,criterion_weight,weighted_contribution,rationale,evidence_fragment_ids,scoring_policy_version,actor_external_user_id,idempotency_key)
           VALUES($1,$2,$3,$4,$5,'submitted',$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)`,
          [uuidv7(), organizationId, run.id, assignment.id, criterion.id, derived.score, maximum, weight,
            calculateContribution({ score: derived.score, rubricMaximum: maximum, weight }), derived.rationale,
            JSON.stringify(derived.evidenceFragmentIds), AUTOMATED_SCORING_POLICY_VERSION, input.actorUserMongoId, idempotencyKey],
        );
        createdCount += 1;
      }
      const targetConflictStatus = hasHumanSubmittedScore ? assignment.conflict_status : "not_applicable";
      const assignmentUpdated = assignment.conflict_status !== targetConflictStatus || assignment.status !== "complete";
      if (assignmentUpdated) await client.query(
        `UPDATE rfpilot.evaluation_assignments SET conflict_status=$2,
           conflict_note=CASE WHEN $2='not_applicable'
             THEN 'Automated evidence-derived evaluation; reviewer conflict declaration is not applicable.'
             ELSE conflict_note END,
           status='complete',version=version+1,updated_at=now() WHERE id=$1`,
        [assignment.id, targetConflictStatus],
      );
      if (createdCount > 0 || assignmentUpdated) await audit(client, input, organizationId, "vendor_evaluation.automatically_completed", run.id, {
        assignmentId: assignment.id,
        createdScoreCount: createdCount,
        scoringPolicyVersion: AUTOMATED_SCORING_POLICY_VERSION,
      });
      return { runId: run.id, assignmentId: assignment.id, createdScoreCount: createdCount, created: createdCount > 0 || assignmentUpdated };
    });
  },

  async assign(input: Context & { runId: string; evaluatorUserMongoId: string; role: "technical" | "commercial" | "combined" | "observer"; criterionIds: string[] }) {
    await loadVersion(input, true);
    if (!/^[0-9a-f]{24}$/i.test(input.evaluatorUserMongoId) || input.criterionIds.length < 1 || input.criterionIds.length > 50)
      throw new EvaluationEngineError("ASSIGNMENT_INVALID", "Evaluator or criterion assignment is invalid.");
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId), proposalRow = await proposal(client, input.proposalMongoId), run = await latestRun(client, proposalRow.id, input.versionMongoId, input.runId);
      if (proposalRow.owner_external_user_id !== input.actorUserMongoId) throw new EvaluationEngineError("EVALUATION_ACCESS_DENIED", "Only the proposal owner can manage assignments.", 403);
      const evaluator = await client.query<{ id: string }>("SELECT id FROM rfpilot.users WHERE organization_id=$1 AND external_mongo_id=$2 AND status='active'", [organizationId, input.evaluatorUserMongoId]);
      if (!evaluator.rows[0]) throw new EvaluationEngineError("EVALUATOR_NOT_FOUND", "Evaluator is not an active organization user.", 404);
      const criteria = await client.query<{ id: string }>("SELECT id FROM rfpilot.evaluation_criteria WHERE matrix_version_id=$1 AND id=ANY($2::uuid[])", [run.matrix_version_id, input.criterionIds]);
      if (criteria.rows.length !== new Set(input.criterionIds).size) throw new EvaluationEngineError("ASSIGNMENT_INVALID", "One or more criteria are outside the frozen matrix.");
      const existing = await client.query<any>("SELECT * FROM rfpilot.evaluation_assignments WHERE evaluation_run_id=$1 AND evaluator_external_user_id=$2", [run.id, input.evaluatorUserMongoId]);
      if (existing.rows[0]) return { assignmentId: existing.rows[0].id, created: false };
      const assignmentId = uuidv7();
      await client.query("INSERT INTO rfpilot.evaluation_assignments(id,organization_id,evaluation_run_id,evaluator_external_user_id,role,assigned_by_external_user_id) VALUES($1,$2,$3,$4,$5,$6)", [assignmentId, organizationId, run.id, input.evaluatorUserMongoId, input.role, input.actorUserMongoId]);
      for (const criterionId of [...new Set(input.criterionIds)]) await client.query("INSERT INTO rfpilot.evaluation_assignment_criteria(id,organization_id,assignment_id,criterion_id) VALUES($1,$2,$3,$4)", [uuidv7(), organizationId, assignmentId, criterionId]);
      await audit(client, input, organizationId, "vendor_evaluation.assigned", run.id, { assignmentId, role: input.role, criterionCount: input.criterionIds.length });
      return { assignmentId, created: true };
    });
  },

  async declareConflict(input: Context & { runId: string; status: "clear" | "conflict"; note: string; expectedVersion: number }) {
    await loadVersion(input, false);
    if (input.status === "conflict" && !input.note.trim()) throw new EvaluationEngineError("CONFLICT_NOTE_REQUIRED", "Describe the conflict of interest.");
    return withPostgresTransaction(async (client) => {
      await tenant(client, input.organizationMongoId); const proposalRow = await proposal(client, input.proposalMongoId), run = await latestRun(client, proposalRow.id, input.versionMongoId, input.runId);
      await access(client, run.id, input.actorUserMongoId, proposalRow.owner_external_user_id);
      const updated = await client.query<any>("UPDATE rfpilot.evaluation_assignments SET conflict_status=$3,conflict_note=$4,version=version+1,updated_at=now() WHERE evaluation_run_id=$1 AND evaluator_external_user_id=$2 AND version=$5 RETURNING *", [run.id, input.actorUserMongoId, input.status, input.note.trim().slice(0, 1000), input.expectedVersion]);
      if (!updated.rows[0]) throw new EvaluationEngineError("ASSIGNMENT_VERSION_CONFLICT", "The assignment changed. Refresh before saving.", 409);
      await audit(client, input, (await tenant(client, input.organizationMongoId)), "vendor_evaluation.conflict_declared", run.id, { status: input.status });
      return { assignmentId: updated.rows[0].id, conflictStatus: updated.rows[0].conflict_status, version: updated.rows[0].version };
    });
  },

  async score(input: Context & { runId: string; criterionId: string; eventType: "draft" | "submitted" | "superseded"; score: number; rationale: string; evidenceFragmentIds: string[]; idempotencyKey: string }) {
    await loadVersion(input, false);
    if (input.rationale.length > 3000 || input.evidenceFragmentIds.length > 20) throw new EvaluationEngineError("SCORE_INVALID", "Score rationale or citations are invalid.");
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId), proposalRow = await proposal(client, input.proposalMongoId), run = await latestRun(client, proposalRow.id, input.versionMongoId, input.runId);
      const assignment = await client.query<any>("SELECT * FROM rfpilot.evaluation_assignments WHERE evaluation_run_id=$1 AND evaluator_external_user_id=$2 FOR UPDATE", [run.id, input.actorUserMongoId]);
      if (!assignment.rows[0]) throw new EvaluationEngineError("EVALUATION_ACCESS_DENIED", "You are not assigned to score this evaluation.", 403);
      if (assignment.rows[0].role === "observer") throw new EvaluationEngineError("OBSERVER_SCORING_FORBIDDEN", "Observer assignments are read-only.", 403);
      if (input.eventType === "submitted" && !["clear", "not_applicable"].includes(assignment.rows[0].conflict_status)) throw new EvaluationEngineError("CONFLICT_DECLARATION_REQUIRED", "Declare your conflict-of-interest status before submitting.", 409);
      if (input.eventType !== "draft" && !input.rationale.trim()) throw new EvaluationEngineError("SCORE_RATIONALE_REQUIRED", "Submitted scores require a rationale.");
      const criterion = await client.query<any>(
        `SELECT c.* FROM rfpilot.evaluation_criteria c JOIN rfpilot.evaluation_assignment_criteria a ON a.criterion_id=c.id
         WHERE a.assignment_id=$1 AND c.id=$2 AND c.matrix_version_id=$3`, [assignment.rows[0].id, input.criterionId, run.matrix_version_id],
      );
      if (!criterion.rows[0]) throw new EvaluationEngineError("CRITERION_NOT_ASSIGNED", "This criterion is not assigned to you.", 403);
      if (input.eventType !== "draft" && criterion.rows[0].human_only !== true && input.evidenceFragmentIds.length === 0)
        throw new EvaluationEngineError("SCORE_CITATION_REQUIRED", "Submitted scores require cited vendor evidence.");
      if (criterion.rows[0].price_visibility === "hidden" && run.sealed_price) {
        const grant = await client.query<any>("SELECT decision FROM rfpilot.commercial_access_events WHERE assignment_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [assignment.rows[0].id]);
        if (grant.rows[0]?.decision !== "granted") throw new EvaluationEngineError("SEALED_PRICE_ACCESS_REQUIRED", "Commercial scoring is sealed until access is granted.", 403);
      }
      const oldKey = await client.query<any>("SELECT * FROM rfpilot.evaluator_score_events WHERE organization_id=$1 AND idempotency_key=$2", [organizationId, input.idempotencyKey]);
      if (oldKey.rows[0]) return { eventId: oldKey.rows[0].id, created: false };
      const latest = await client.query<any>("SELECT * FROM rfpilot.evaluator_score_events WHERE assignment_id=$1 AND criterion_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [assignment.rows[0].id, input.criterionId]);
      if (["submitted", "superseded"].includes(latest.rows[0]?.event_type)) throw new EvaluationEngineError("SCORE_ALREADY_SUBMITTED", "Reopen the submitted score before correcting it.", 409);
      const maximum = rubricMaximum(criterion.rows[0].rubric), weight = Number(criterion.rows[0].weight), contribution = calculateContribution({ score: input.score, rubricMaximum: maximum, weight });
      const allowedEvidence = await client.query<{ id: string }>(
        `SELECT DISTINCT f.id FROM rfpilot.evidence_fragments f
         JOIN rfpilot.assessment_evidence ae ON ae.evidence_fragment_id=f.id
         JOIN rfpilot.ai_assessments a ON a.id=ae.assessment_id
         JOIN rfpilot.requirements r ON r.id=a.requirement_id
         WHERE f.id=ANY($1::uuid[]) AND a.evaluation_run_id=$2 AND r.criterion_id=$3
           AND ($4::boolean OR r.group_key IS DISTINCT FROM $5)`, [
          input.evidenceFragmentIds,
          run.id,
          input.criterionId,
          proposalWorkflowSectionEnabled("video_recording"),
          LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY,
        ],
      );
      if (allowedEvidence.rows.length !== new Set(input.evidenceFragmentIds).size) throw new EvaluationEngineError("SCORE_CITATION_INVALID", "A score citation is outside this vendor response.");
      const eventId = uuidv7();
      await client.query(
        `INSERT INTO rfpilot.evaluator_score_events(id,organization_id,evaluation_run_id,assignment_id,criterion_id,event_type,score,rubric_maximum,criterion_weight,weighted_contribution,rationale,evidence_fragment_ids,supersedes_event_id,scoring_policy_version,actor_external_user_id,idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16)`,
        [eventId, organizationId, run.id, assignment.rows[0].id, input.criterionId, input.eventType, input.score, maximum, weight, contribution, input.rationale.trim(), JSON.stringify([...new Set(input.evidenceFragmentIds)]), input.eventType === "superseded" ? latest.rows[0]?.id ?? null : null, SCORING_POLICY_VERSION, input.actorUserMongoId, input.idempotencyKey],
      );
      const incomplete = await client.query<{ count: number }>(
        `SELECT count(*)::int count FROM rfpilot.evaluation_assignment_criteria ac WHERE ac.assignment_id=$1 AND NOT EXISTS(
          SELECT 1 FROM (SELECT DISTINCT ON(criterion_id) criterion_id,event_type FROM rfpilot.evaluator_score_events WHERE assignment_id=$1 ORDER BY criterion_id,created_at DESC,id DESC) e
          WHERE e.criterion_id=ac.criterion_id AND e.event_type IN('submitted','superseded'))`, [assignment.rows[0].id],
      );
      if (input.eventType !== "draft" && Number(incomplete.rows[0]?.count ?? 1) === 0) await client.query("UPDATE rfpilot.evaluation_assignments SET status='complete',version=version+1,updated_at=now() WHERE id=$1", [assignment.rows[0].id]);
      await audit(client, input, organizationId, "vendor_evaluation.score_recorded", run.id, { criterionId: input.criterionId, eventType: input.eventType });
      return { eventId, created: true };
    });
  },

  async reopen(input: Context & { runId: string; assignmentId: string; criterionId: string; reason: string; idempotencyKey: string }) {
    await loadVersion(input, true);
    if (!input.reason.trim()) throw new EvaluationEngineError("REOPEN_REASON_REQUIRED", "A reopen reason is required.");
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId), proposalRow = await proposal(client, input.proposalMongoId), run = await latestRun(client, proposalRow.id, input.versionMongoId, input.runId);
      if (proposalRow.owner_external_user_id !== input.actorUserMongoId) throw new EvaluationEngineError("EVALUATION_ACCESS_DENIED", "Only the proposal owner can reopen a score.", 403);
      const oldKey = await client.query<any>("SELECT id FROM rfpilot.evaluator_score_events WHERE organization_id=$1 AND idempotency_key=$2", [organizationId, input.idempotencyKey]); if (oldKey.rows[0]) return { eventId: oldKey.rows[0].id, created: false };
      const latest = await client.query<any>("SELECT * FROM rfpilot.evaluator_score_events WHERE evaluation_run_id=$1 AND assignment_id=$2 AND criterion_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1", [run.id, input.assignmentId, input.criterionId]);
      if (!["submitted", "superseded"].includes(latest.rows[0]?.event_type)) throw new EvaluationEngineError("SCORE_NOT_SUBMITTED", "Only a submitted score can be reopened.", 409);
      const eventId = uuidv7();
      await client.query(
        `INSERT INTO rfpilot.evaluator_score_events(id,organization_id,evaluation_run_id,assignment_id,criterion_id,event_type,rubric_maximum,criterion_weight,rationale,supersedes_event_id,scoring_policy_version,actor_external_user_id,idempotency_key)
         VALUES($1,$2,$3,$4,$5,'reopened',$6,$7,$8,$9,$10,$11,$12)`,
        [eventId, organizationId, run.id, input.assignmentId, input.criterionId, latest.rows[0].rubric_maximum, latest.rows[0].criterion_weight, input.reason.trim().slice(0, 3000), latest.rows[0].id, SCORING_POLICY_VERSION, input.actorUserMongoId, input.idempotencyKey],
      );
      await client.query("UPDATE rfpilot.evaluation_assignments SET status='reopened',version=version+1,updated_at=now() WHERE id=$1", [input.assignmentId]);
      await audit(client, input, organizationId, "vendor_evaluation.score_reopened", run.id, { assignmentId: input.assignmentId, criterionId: input.criterionId });
      return { eventId, created: true };
    });
  },

  async commercialAccess(input: Context & { runId: string; assignmentId: string; decision: "granted" | "revoked"; reason: string; idempotencyKey: string }) {
    await loadVersion(input, true);
    if (!input.reason.trim()) throw new EvaluationEngineError("COMMERCIAL_ACCESS_REASON_REQUIRED", "A commercial-access reason is required.");
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId), proposalRow = await proposal(client, input.proposalMongoId), run = await latestRun(client, proposalRow.id, input.versionMongoId, input.runId);
      if (proposalRow.owner_external_user_id !== input.actorUserMongoId) throw new EvaluationEngineError("EVALUATION_ACCESS_DENIED", "Only the proposal owner can manage sealed-price access.", 403);
      const assignment = await client.query<any>("SELECT id FROM rfpilot.evaluation_assignments WHERE id=$1 AND evaluation_run_id=$2", [input.assignmentId, run.id]); if (!assignment.rows[0]) throw new EvaluationEngineError("ASSIGNMENT_NOT_FOUND", "Assignment was not found.", 404);
      const old = await client.query<any>("SELECT id FROM rfpilot.commercial_access_events WHERE organization_id=$1 AND idempotency_key=$2", [organizationId, input.idempotencyKey]); if (old.rows[0]) return { eventId: old.rows[0].id, created: false };
      const eventId = uuidv7(); await client.query("INSERT INTO rfpilot.commercial_access_events(id,organization_id,evaluation_run_id,assignment_id,decision,reason,actor_external_user_id,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [eventId, organizationId, run.id, input.assignmentId, input.decision, input.reason.trim().slice(0, 1000), input.actorUserMongoId, input.idempotencyKey]);
      await audit(client, input, organizationId, "vendor_evaluation.commercial_access", run.id, { assignmentId: input.assignmentId, decision: input.decision });
      return { eventId, created: true };
    });
  },
};
