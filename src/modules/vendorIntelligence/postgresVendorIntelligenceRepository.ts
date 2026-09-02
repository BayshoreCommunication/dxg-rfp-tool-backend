/* eslint-disable @typescript-eslint/no-explicit-any */
import { v7 as uuidv7 } from "uuid";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../../../config/postgres";
import VendorSubmission from "../../../modal/vendorSubmissionModel";
import VendorSubmissionVersion from "../../../modal/vendorSubmissionVersionModel";
import {
  contentChecksum,
  FACT_VERSION,
  MAPPING_VERSION,
  PROMPT_VERSION,
  sourceCoverageWarnings,
  validateFactCorrectionPayload,
  VALIDATION_VERSION,
  VendorIntelligenceError,
} from "./domain";
import { openAiVendorFactMappingProvider } from "./openAiVendorFactMappingProvider";
import { runVendorFactMappingPipeline } from "./pipeline";
import type { IntelligenceEvidence, IntelligenceRequirement } from "./ports";
import { REQUIREMENT_GENERATOR_VERSION } from "../requirementRegistry/generator";
import {
  LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY,
  proposalWorkflowSectionEnabled,
} from "../proposals/domain/workflowSections";

type Context = {
  organizationMongoId: string;
  actorUserMongoId: string;
  proposalMongoId: string;
  submissionMongoId: string;
  versionMongoId: string;
};

const tenant = async (client: PoolClient, organizationMongoId: string) => {
  await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [organizationMongoId]);
  const result = await client.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [organizationMongoId],
  );
  if (!result.rows[0]) throw new VendorIntelligenceError("ORGANIZATION_NOT_READY", "Organization unavailable.", 503);
  await client.query("SELECT set_config('app.organization_id',$1,true)", [result.rows[0].id]);
  return result.rows[0].id;
};

const ownedProposal = async (client: PoolClient, proposalMongoId: string, actorMongoId: string) => {
  const result = await client.query<{ id: string }>(
    `SELECT p.id FROM rfpilot.proposal_references p
     JOIN rfpilot.users u ON u.id=p.owner_user_id
     WHERE p.external_mongo_id=$1 AND u.external_mongo_id=$2`,
    [proposalMongoId, actorMongoId],
  );
  if (!result.rows[0]) throw new VendorIntelligenceError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  return result.rows[0].id;
};

const loadVersion = async (input: Context) => {
  const submission = await VendorSubmission.findOne({
    _id: input.submissionMongoId,
    organizationId: input.organizationMongoId,
    proposalId: input.proposalMongoId,
    proposalOwnerId: input.actorUserMongoId,
  }).select("_id").lean<any>();
  if (!submission) throw new VendorIntelligenceError("VENDOR_SUBMISSION_NOT_FOUND", "Vendor submission was not found.", 404);
  const version = await VendorSubmissionVersion.findOne({
    _id: input.versionMongoId,
    organizationId: input.organizationMongoId,
    proposalId: input.proposalMongoId,
    submissionId: input.submissionMongoId,
  }).select("manifestChecksum documents.documentId documents.name").lean<any>();
  if (!version) throw new VendorIntelligenceError("SUBMISSION_VERSION_NOT_FOUND", "Vendor submission version was not found.", 404);
  return version as { manifestChecksum: string; documents?: Array<{ documentId?: string; name?: string }> };
};

const approvedRequirementSet = async (client: PoolClient, proposalReferenceId: string, requirementSetId?: string | null) => {
  const result = requirementSetId
    ? await client.query<any>(
      "SELECT * FROM rfpilot.requirement_sets WHERE id=$1 AND proposal_reference_id=$2 AND status='approved' AND generator_version=$3",
      [requirementSetId, proposalReferenceId, REQUIREMENT_GENERATOR_VERSION],
    )
    : await client.query<any>(
      "SELECT * FROM rfpilot.requirement_sets WHERE proposal_reference_id=$1 AND status='approved' AND generator_version=$2 ORDER BY version DESC LIMIT 1",
      [proposalReferenceId, REQUIREMENT_GENERATOR_VERSION],
    );
  if (!result.rows[0]) throw new VendorIntelligenceError("REQUIREMENT_SET_NOT_APPROVED", "An approved requirement set is required.", 409);
  return result.rows[0];
};

const extractionInput = async (client: PoolClient, versionMongoId: string, expectedDocuments: Array<{ documentId?: string; name?: string }> = []) => {
  const result = await client.query<any>(
    `SELECT DISTINCT ON (source_kind,coalesce(vendor_document_id::text,'cover_message'))
            id,vendor_document_id,status,source_label,coalesce(reused_from_run_id,id) effective_run_id,output_checksum,warnings
     FROM rfpilot.source_extraction_runs
     WHERE vendor_submission_version_mongo_id=$1
     ORDER BY source_kind,coalesce(vendor_document_id::text,'cover_message'),created_at DESC,id DESC`,
    [versionMongoId],
  );
  const rows = [...result.rows];
  const currentDocumentIds = new Set(rows.map((row) => String(row.vendor_document_id ?? "")).filter(Boolean));
  for (const document of expectedDocuments) if (document.documentId && !currentDocumentIds.has(String(document.documentId))) rows.push({
    id: `unavailable:${document.documentId}`,
    status: "unavailable",
    source_label: String(document.name || "Attachment"),
    effective_run_id: null,
    output_checksum: null,
    warnings: [],
  });
  if (!rows.length) throw new VendorIntelligenceError("SOURCE_NOT_READY", "Vendor evidence has not been extracted.", 409);
  if (rows.some((row) => ["queued", "running"].includes(row.status)))
    throw new VendorIntelligenceError("SOURCE_NOT_READY", "Vendor evidence extraction is still running.", 409);
  const usable = rows.filter((row) => ["succeeded", "partial"].includes(row.status));
  if (!usable.length) throw new VendorIntelligenceError("SOURCE_NOT_READY", "Vendor evidence is unreadable.", 409);
  return rows;
};

const runView = (row: any) => ({
  runId: row.id,
  jobId: row.job_id,
  requirementSetId: row.requirement_set_id,
  status: row.status,
  provider: row.provider ?? null,
  model: row.model ?? null,
  requirementCount: Number(row.requirement_count ?? 0),
  mappedRequirementCount: Number(row.mapped_requirement_count ?? 0),
  factCount: Number(row.fact_count ?? 0),
  contradictionCount: Number(row.contradiction_count ?? 0),
  warnings: Array.isArray(row.warnings) ? row.warnings : [],
  safeErrorCode: row.safe_error_code ?? null,
  createdAt: row.created_at,
  completedAt: row.completed_at ?? null,
});

const audit = (
  client: PoolClient,
  input: { actorUserMongoId: string; correlationId: string },
  organizationId: string,
  action: string,
  targetId: string,
  metadata: Record<string, unknown>,
) => client.query(
  `INSERT INTO rfpilot.audit_events(
     id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata
   ) VALUES($1,$2,$3,$4,'vendor_intelligence_run',$5,'allow',$6,$7::jsonb)`,
  [uuidv7(), organizationId, input.actorUserMongoId, action, targetId, input.correlationId, JSON.stringify(metadata)],
);

export const vendorIntelligenceRepository = {
  async create(input: Context & { requirementSetId?: string | null; idempotencyKey: string; correlationId: string }) {
    const version = await loadVersion(input);
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId);
      const proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId);
      const set = await approvedRequirementSet(client, proposalReferenceId, input.requirementSetId);
      const extraction = await extractionInput(client, input.versionMongoId, version.documents ?? []);
      const inputWarnings = sourceCoverageWarnings(extraction.map((row) => ({
        status: row.status,
        sourceLabel: row.source_label,
        warnings: Array.isArray(row.warnings) ? row.warnings : [],
      })), 0, 0, false);
      const inputChecksum = contentChecksum({
        requirementSet: set.content_checksum,
        submissionVersion: version.manifestChecksum,
        evidence: extraction.map((row) => ({ id: row.id, status: row.status, outputChecksum: row.output_checksum, warnings: row.warnings })),
        mappingVersion: MAPPING_VERSION,
        factVersion: FACT_VERSION,
        validationVersion: VALIDATION_VERSION,
        promptVersion: PROMPT_VERSION,
      });
      const stableKey = `vendor-intelligence:${input.versionMongoId}:${set.id}:${inputChecksum}`;
      const old = await client.query<any>(
        `SELECT r.*,j.status job_status
         FROM rfpilot.vendor_intelligence_runs r
         JOIN rfpilot.ai_jobs j ON j.id=r.job_id
         WHERE r.organization_id=$1 AND r.idempotency_key=$2
         FOR UPDATE OF r,j`,
        [organizationId, stableKey],
      );
      if (old.rows[0]) {
        const prior = old.rows[0];
        const retryable = prior.status === "failed" && ["failed", "dead_letter"].includes(prior.job_status);
        if (!retryable) return { run: runView(prior), created: false };

        await client.query(
          `UPDATE rfpilot.ai_jobs SET
             status='queued',attempt_count=0,available_at=now(),error_code=NULL,
             cancellation_requested_at=NULL,cancelled_by_external_user_id=NULL,
             started_at=NULL,completed_at=NULL,lease_owner=NULL,lease_expires_at=NULL,
             progress=0,progress_stage='queued',result_reference=NULL,updated_at=now()
           WHERE id=$1`,
          [prior.job_id],
        );
        await client.query(
          `UPDATE rfpilot.job_dead_letters SET
             operator_status='requeued',recovered_by_external_user_id=$2,
             recovery_reason='Retry requested from vendor preparation',recovered_at=now()
           WHERE job_id=$1 AND operator_status='open'`,
          [prior.job_id, input.actorUserMongoId],
        );
        const requeued = await client.query<any>(
          `UPDATE rfpilot.vendor_intelligence_runs SET
             status='queued',provider=NULL,model=NULL,requirement_count=0,
             mapped_requirement_count=0,fact_count=0,contradiction_count=0,
             warning_count=$4,warnings=$5::jsonb,
             safe_error_code=NULL,output_checksum=NULL,started_at=NULL,
             completed_at=NULL,correlation_id=$2,actor_external_user_id=$3,updated_at=now()
           WHERE id=$1 RETURNING *`,
          [prior.id, input.correlationId, input.actorUserMongoId, inputWarnings.length, JSON.stringify(inputWarnings)],
        );
        const payload = {
          jobId: prior.job_id,
          organizationMongoId: input.organizationMongoId,
          actorUserMongoId: input.actorUserMongoId,
          jobType: "vendor_requirement_facts",
          inputReference: prior.id,
          inputVersion: FACT_VERSION,
          correlationId: input.correlationId,
        };
        await client.query(
          `INSERT INTO rfpilot.outbox_events(
             id,organization_id,aggregate_type,aggregate_id,event_type,idempotency_key,payload
           ) VALUES($1,$2,'ai_job',$3,'job.queued',$4,$5::jsonb)
           ON CONFLICT(organization_id,idempotency_key) DO NOTHING`,
          [uuidv7(), organizationId, prior.job_id,
            `vendor-intelligence.requeued:${prior.job_id}:${input.idempotencyKey}`,
            JSON.stringify(payload)],
        );
        await audit(client, input, organizationId, "vendor_intelligence.requeued", prior.id, {
          requirementSetId: set.id,
          vendorSubmissionVersionId: input.versionMongoId,
          previousErrorCode: prior.safe_error_code,
        });
        return { run: runView(requeued.rows[0]), created: true };
      }
      const runId = uuidv7(), jobId = uuidv7();
      await client.query(
        `INSERT INTO rfpilot.ai_jobs(
           id,organization_id,proposal_reference_id,job_type,status,idempotency_key,input_reference,
           input_version,input_checksum,max_attempts,correlation_id,initiator_external_user_id
         ) VALUES($1,$2,$3,'vendor_requirement_facts','queued',$4,$5,$6,$7,3,$8,$9)`,
        [jobId, organizationId, proposalReferenceId, stableKey, runId, FACT_VERSION, inputChecksum, input.correlationId, input.actorUserMongoId],
      );
      const inserted = await client.query<any>(
        `INSERT INTO rfpilot.vendor_intelligence_runs(
           id,organization_id,proposal_reference_id,requirement_set_id,vendor_submission_mongo_id,
           vendor_submission_version_mongo_id,job_id,input_checksum,requirement_mapping_version,
           fact_schema_version,validation_version,prompt_version,warning_count,warnings,idempotency_key,correlation_id,actor_external_user_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17) RETURNING *`,
        [runId, organizationId, proposalReferenceId, set.id, input.submissionMongoId, input.versionMongoId,
          jobId, inputChecksum, MAPPING_VERSION, FACT_VERSION, VALIDATION_VERSION, PROMPT_VERSION,
          inputWarnings.length, JSON.stringify(inputWarnings), stableKey, input.correlationId, input.actorUserMongoId],
      );
      const payload = {
        jobId,
        organizationMongoId: input.organizationMongoId,
        actorUserMongoId: input.actorUserMongoId,
        jobType: "vendor_requirement_facts",
        inputReference: runId,
        inputVersion: FACT_VERSION,
        correlationId: input.correlationId,
      };
      await client.query(
        `INSERT INTO rfpilot.outbox_events(
           id,organization_id,aggregate_type,aggregate_id,event_type,idempotency_key,payload
         ) VALUES($1,$2,'ai_job',$3,'job.queued',$4,$5::jsonb)`,
        [uuidv7(), organizationId, jobId, `job.queued:${jobId}:1`, JSON.stringify(payload)],
      );
      await audit(client, input, organizationId, "vendor_intelligence.queued", runId, {
        requirementSetId: set.id,
        vendorSubmissionVersionId: input.versionMongoId,
        requestIdempotencyKey: input.idempotencyKey,
      });
      return { run: runView(inserted.rows[0]), created: true };
    });
  },

  async execute(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    runId: string;
    onProgress?: (progress: number, stage: string) => Promise<void> | void;
  }) {
    const loaded = await withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId);
      const result = await client.query<any>(
        `SELECT r.* FROM rfpilot.vendor_intelligence_runs r
         JOIN rfpilot.requirement_sets s ON s.id=r.requirement_set_id AND s.generator_version=$2
         WHERE r.id=$1 FOR UPDATE OF r`,
        [input.runId, REQUIREMENT_GENERATOR_VERSION],
      );
      const run = result.rows[0];
      if (!run) throw new VendorIntelligenceError("INTELLIGENCE_RUN_NOT_FOUND", "Vendor intelligence run was not found.", 404);
      if (run.status === "succeeded") return { run, organizationId, requirements: [], evidence: [], warnings: [] };
      const set = await client.query<any>(
        "SELECT id,status FROM rfpilot.requirement_sets WHERE id=$1 AND generator_version=$2",
        [run.requirement_set_id, REQUIREMENT_GENERATOR_VERSION],
      );
      if (set.rows[0]?.status !== "approved")
        throw new VendorIntelligenceError("REQUIREMENT_SET_NOT_APPROVED", "The requirement set is no longer approved.", 409);
      const requirements = await client.query<any>(
        `SELECT id,title,normalized_text,kind,mandatory_status
         FROM rfpilot.requirements
         WHERE requirement_set_id=$1 AND included=true
           AND ($2::boolean OR group_key IS DISTINCT FROM $3)
         ORDER BY ordinal`,
        [
          run.requirement_set_id,
          proposalWorkflowSectionEnabled("video_recording"),
          LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY,
        ],
      );
      const sourceRuns = await extractionInput(client, run.vendor_submission_version_mongo_id);
      const available = await client.query<{ count: number }>(
        `WITH current_sources AS (
           SELECT DISTINCT ON (source_kind,coalesce(vendor_document_id::text,'cover_message'))
                  coalesce(reused_from_run_id,id) effective_id,status
           FROM rfpilot.source_extraction_runs WHERE vendor_submission_version_mongo_id=$1
           ORDER BY source_kind,coalesce(vendor_document_id::text,'cover_message'),created_at DESC,id DESC
         )
         SELECT count(*)::int count FROM rfpilot.evidence_fragments f
         JOIN current_sources s ON s.effective_id=f.extraction_run_id
         WHERE s.status IN ('succeeded','partial')`,
        [run.vendor_submission_version_mongo_id],
      );
      const fragments = await client.query<any>(
        `WITH source_runs AS (
           SELECT DISTINCT ON (source_kind,coalesce(vendor_document_id::text,'cover_message'))
                  id,source_label,coalesce(reused_from_run_id,id) effective_id,status
           FROM rfpilot.source_extraction_runs WHERE vendor_submission_version_mongo_id=$1
           ORDER BY source_kind,coalesce(vendor_document_id::text,'cover_message'),created_at DESC,id DESC
         ), ranked AS (
           SELECT f.id,f.content,f.locator,s.source_label,
                  row_number() OVER (PARTITION BY s.id ORDER BY f.ordinal) source_rank
           FROM source_runs s JOIN rfpilot.evidence_fragments f ON f.extraction_run_id=s.effective_id
           WHERE s.status IN ('succeeded','partial')
         )
         SELECT id,content,locator,source_label FROM ranked
         WHERE source_rank<=80 ORDER BY source_label,id LIMIT 240`,
        [run.vendor_submission_version_mongo_id],
      );
      const currentWarnings = sourceCoverageWarnings(sourceRuns.map((row) => ({
        status: row.status,
        sourceLabel: row.source_label,
        warnings: Array.isArray(row.warnings) ? row.warnings : [],
      })), Number(available.rows[0]?.count ?? 0), fragments.rows.length);
      // The latest extraction attempts are authoritative. A source can recover after
      // this run was queued, so retaining its earlier coverage warning would make a
      // fully readable response impossible to evaluate.
      const warnings = currentWarnings;
      await client.query(
        "UPDATE rfpilot.vendor_intelligence_runs SET status='running',started_at=coalesce(started_at,now()),safe_error_code=NULL,updated_at=now() WHERE id=$1",
        [input.runId],
      );
      return {
        run,
        organizationId,
        requirements: requirements.rows.map((row) => ({
          id: row.id, title: row.title, text: row.normalized_text, kind: row.kind,
          mandatory: row.mandatory_status === "mandatory",
        })) as IntelligenceRequirement[],
        evidence: fragments.rows.map((row) => ({
          id: row.id,
          sourceLabel: row.source_label,
          locator: row.locator ?? {},
          content: String(row.content).slice(0, 1600),
          trustClass: "untrusted_vendor_content",
        })) as IntelligenceEvidence[],
        warnings,
      };
    });
    if (loaded.run.status === "succeeded") return { resultReference: input.runId };
    const result = await runVendorFactMappingPipeline({
      requirements: loaded.requirements,
      evidence: loaded.evidence,
      provider: openAiVendorFactMappingProvider,
      ledger: { runType: "vendor_requirement_facts", runId: input.runId, organizationId: loaded.organizationId },
      onProgress: input.onProgress,
    });
    await input.onProgress?.(95, "persisting_vendor_intelligence");
    await withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId);
      let mappingOrdinal = 0;
      for (const mapping of result.mappings) {
        const fragmentIds: Array<string | null> = mapping.relationship === "none" ? [null] : mapping.candidateFragmentIds;
        for (const fragmentId of fragmentIds) {
          await client.query(
            `INSERT INTO rfpilot.requirement_evidence_mappings(
               id,organization_id,intelligence_run_id,requirement_id,evidence_fragment_id,
               relationship,confidence,mapping_method,mapping_version,ambiguity_reasons,ordinal
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
            [uuidv7(), organizationId, input.runId, mapping.requirementId, fragmentId,
              mapping.relationship, mapping.confidence, "model",
              MAPPING_VERSION, JSON.stringify(mapping.ambiguityReasons), mappingOrdinal],
          );
          mappingOrdinal += 1;
        }
      }
      for (let ordinal = 0; ordinal < result.facts.length; ordinal += 1) {
        const fact = result.facts[ordinal], factId = uuidv7();
        await client.query(
          `INSERT INTO rfpilot.extracted_facts(
             id,organization_id,intelligence_run_id,vendor_submission_version_mongo_id,fact_key,
             family,fact_type,statement,value_kind,typed_value,normalized_value,unit,currency,
             period_start,period_end,explicitness,confidence,contradiction_group,extraction_version,ordinal
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [factId, organizationId, input.runId, loaded.run.vendor_submission_version_mongo_id,
            fact.factKey, fact.family, fact.factType, fact.statement, fact.valueKind,
            JSON.stringify(fact.typedValue), fact.normalizedValue, fact.unit, fact.currency,
            fact.periodStart, fact.periodEnd, fact.explicitness, fact.confidence,
            fact.contradictionGroup, FACT_VERSION, ordinal],
        );
        for (let citationOrdinal = 0; citationOrdinal < fact.citations.length; citationOrdinal += 1) {
          const citation = fact.citations[citationOrdinal];
          await client.query(
            `INSERT INTO rfpilot.extracted_fact_evidence(
               id,organization_id,fact_id,evidence_fragment_id,support_role,ordinal
             ) VALUES($1,$2,$3,$4,$5,$6)`,
            [uuidv7(), organizationId, factId, citation.fragmentId, citation.role, citationOrdinal],
          );
        }
        for (const validation of [
          { type: "schema", outcome: "passed", code: "SCHEMA_VALID" },
          { type: "citation", outcome: "passed", code: "CITATIONS_VALID" },
          { type: "typed_value", outcome: "passed", code: "TYPED_VALUE_VALID" },
          ...(fact.contradictionGroup ? [{ type: "contradiction", outcome: "warning", code: "CONTRADICTION_DETECTED" }] : []),
        ]) {
          await client.query(
            `INSERT INTO rfpilot.fact_validation_results(
               id,organization_id,fact_id,check_type,outcome,reason_code
             ) VALUES($1,$2,$3,$4,$5,$6)`,
            [uuidv7(), organizationId, factId, validation.type, validation.outcome, validation.code],
          );
        }
      }
      const contradictionGroups = new Set(result.facts.map((fact) => fact.contradictionGroup).filter(Boolean));
      await client.query(
        `UPDATE rfpilot.vendor_intelligence_runs SET
           status='succeeded',provider=CASE WHEN $2='deterministic:no-evidence' THEN 'deterministic' ELSE 'openai' END,
           model=$2,requirement_count=$3,mapped_requirement_count=$4,
           fact_count=$5,contradiction_count=$6,warning_count=$7,warnings=$8::jsonb,
           output_checksum=$9,completed_at=now(),updated_at=now()
         WHERE id=$1`,
        [input.runId, result.model, loaded.requirements.length, result.mappings.length,
          result.facts.length, contradictionGroups.size, loaded.warnings.length,
          JSON.stringify(loaded.warnings), result.outputChecksum],
      );
      await audit(client, { actorUserMongoId: input.actorUserMongoId, correlationId: loaded.run.correlation_id }, organizationId,
        "vendor_intelligence.completed", input.runId,
        { requirementCount: loaded.requirements.length, factCount: result.facts.length, contradictionCount: contradictionGroups.size });
    });
    return { resultReference: input.runId };
  },

  async fail(input: { organizationMongoId: string; runId: string; code: string }) {
    return withPostgresTransaction(async (client) => {
      await tenant(client, input.organizationMongoId);
      await client.query(
        "UPDATE rfpilot.vendor_intelligence_runs SET status='failed',safe_error_code=$2,completed_at=now(),updated_at=now() WHERE id=$1 AND status<>'succeeded'",
        [input.runId, input.code.slice(0, 100)],
      );
    });
  },

  async read(input: Context & { runId?: string | null }) {
    await loadVersion(input);
    return withPostgresTransaction(async (client) => {
      await tenant(client, input.organizationMongoId);
      const proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId);
      const runResult = input.runId
        ? await client.query<any>(
          `SELECT r.* FROM rfpilot.vendor_intelligence_runs r
           JOIN rfpilot.requirement_sets s ON s.id=r.requirement_set_id AND s.generator_version=$4
           WHERE r.id=$1 AND r.proposal_reference_id=$2 AND r.vendor_submission_version_mongo_id=$3`,
          [input.runId, proposalReferenceId, input.versionMongoId, REQUIREMENT_GENERATOR_VERSION],
        )
        : await client.query<any>(
          `SELECT r.* FROM rfpilot.vendor_intelligence_runs r
           JOIN rfpilot.requirement_sets s ON s.id=r.requirement_set_id AND s.generator_version=$3
           WHERE r.proposal_reference_id=$1 AND r.vendor_submission_version_mongo_id=$2
           ORDER BY r.created_at DESC LIMIT 1`,
          [proposalReferenceId, input.versionMongoId, REQUIREMENT_GENERATOR_VERSION],
        );
      const run = runResult.rows[0];
      if (!run) throw new VendorIntelligenceError("INTELLIGENCE_RUN_NOT_FOUND", "Vendor intelligence has not been generated.", 404);
      const [mappings, activeRequirementCount] = await Promise.all([
        client.query<any>(
        `SELECT m.id,m.requirement_id,r.title,r.kind,r.mandatory_status,m.relationship,m.confidence,
                m.ambiguity_reasons,m.evidence_fragment_id,f.content,f.locator,s.source_label
         FROM rfpilot.requirement_evidence_mappings m
         JOIN rfpilot.requirements r ON r.id=m.requirement_id
         LEFT JOIN rfpilot.evidence_fragments f ON f.id=m.evidence_fragment_id
         LEFT JOIN LATERAL (
           SELECT current_source.source_label
           FROM rfpilot.source_extraction_runs current_source
           WHERE current_source.vendor_submission_version_mongo_id=$2
             AND coalesce(current_source.reused_from_run_id,current_source.id)=f.extraction_run_id
           ORDER BY current_source.created_at,current_source.id LIMIT 1
         ) s ON true
         WHERE m.intelligence_run_id=$1
           AND ($3::boolean OR r.group_key IS DISTINCT FROM $4)
         ORDER BY r.ordinal,m.ordinal`,
        [
          run.id,
          run.vendor_submission_version_mongo_id,
          proposalWorkflowSectionEnabled("video_recording"),
          LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY,
        ],
        ),
        client.query<{ count: number }>(
          `SELECT count(*)::int count FROM rfpilot.requirements
            WHERE requirement_set_id=$1 AND included=true
              AND ($2::boolean OR group_key IS DISTINCT FROM $3)`,
          [
            run.requirement_set_id,
            proposalWorkflowSectionEnabled("video_recording"),
            LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY,
          ],
        ),
      ]);
      const facts = await client.query<any>(
        `SELECT f.*,
          coalesce((SELECT jsonb_agg(jsonb_build_object(
            'fragmentId',e.evidence_fragment_id,'role',e.support_role,'content',left(x.content,1200),
            'locator',x.locator,'sourceLabel',s.source_label) ORDER BY e.ordinal)
            FROM rfpilot.extracted_fact_evidence e
            JOIN rfpilot.evidence_fragments x ON x.id=e.evidence_fragment_id
            LEFT JOIN LATERAL (
              SELECT current_source.source_label
              FROM rfpilot.source_extraction_runs current_source
              WHERE current_source.vendor_submission_version_mongo_id=$2
                AND coalesce(current_source.reused_from_run_id,current_source.id)=x.extraction_run_id
              ORDER BY current_source.created_at,current_source.id LIMIT 1
            ) s ON true
            WHERE e.fact_id=f.id),'[]'::jsonb) citations
         FROM rfpilot.extracted_facts f WHERE f.intelligence_run_id=$1 ORDER BY f.ordinal`,
        [run.id, run.vendor_submission_version_mongo_id],
      );
      const reviews = await client.query<any>(
        "SELECT * FROM rfpilot.human_review_events WHERE intelligence_run_id=$1 ORDER BY created_at,id",
        [run.id],
      );
      const grouped = new Map<string, any>();
      for (const row of mappings.rows) {
        const current = grouped.get(row.requirement_id) ?? {
          mappingId: row.id, requirementId: row.requirement_id, requirementTitle: row.title,
          requirementKind: row.kind, mandatory: row.mandatory_status === "mandatory",
          relationship: row.relationship, confidence: Number(row.confidence), ambiguityReasons: row.ambiguity_reasons,
          evidence: [],
        };
        if (row.evidence_fragment_id) current.evidence.push({
          fragmentId: row.evidence_fragment_id, content: String(row.content).slice(0, 1200),
          locator: row.locator, sourceLabel: row.source_label,
        });
        grouped.set(row.requirement_id, current);
      }
      const visibleMappingIds = new Set(
        mappings.rows.map((mapping) => String(mapping.id)),
      );
      const visibleFactIds = new Set(
        facts.rows.map((fact) => String(fact.id)),
      );
      return {
        run: {
          ...runView(run),
          requirementCount: Number(activeRequirementCount.rows[0]?.count ?? 0),
          mappedRequirementCount: grouped.size,
        },
        mappings: [...grouped.values()],
        facts: facts.rows.map((fact) => ({
          factId: fact.id, factKey: fact.fact_key, family: fact.family, factType: fact.fact_type,
          statement: fact.statement, valueKind: fact.value_kind, typedValue: fact.typed_value,
          normalizedValue: fact.normalized_value, unit: fact.unit, currency: fact.currency,
          periodStart: fact.period_start, periodEnd: fact.period_end, explicitness: fact.explicitness,
          confidence: Number(fact.confidence), contradictionGroup: fact.contradiction_group,
          citations: fact.citations,
        })),
        reviews: reviews.rows.filter((review) =>
          review.target_type === "mapping"
            ? visibleMappingIds.has(String(review.target_id))
            : visibleFactIds.has(String(review.target_id)),
        ).map((review) => ({
          reviewId: review.id, targetType: review.target_type, targetId: review.target_id,
          decision: review.decision, reasonCode: review.reason_code, note: review.note,
          correctedPayload: review.corrected_payload, actorUserId: review.actor_external_user_id,
          createdAt: review.created_at,
        })),
      };
    });
  },

  async reviewAutomatically(input: Context & { runId: string; correlationId: string }) {
    await loadVersion(input);
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId);
      const proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId);
      const run = await client.query<any>(
        `SELECT * FROM rfpilot.vendor_intelligence_runs
         WHERE id=$1 AND proposal_reference_id=$2 AND vendor_submission_version_mongo_id=$3 AND status='succeeded'`,
        [input.runId, proposalReferenceId, input.versionMongoId],
      );
      if (!run.rows[0]) throw new VendorIntelligenceError("INTELLIGENCE_RUN_NOT_READY", "Vendor intelligence is not ready for automatic review.", 409);
      const targets = await client.query<{ target_type: "mapping" | "fact"; target_id: string }>(
        `SELECT 'mapping'::text target_type,m.id target_id
         FROM rfpilot.requirement_evidence_mappings m
         WHERE m.intelligence_run_id=$1 AND NOT EXISTS (
           SELECT 1 FROM LATERAL (
             SELECT h.decision FROM rfpilot.human_review_events h
             WHERE h.intelligence_run_id=$1 AND h.target_type='mapping' AND h.target_id=m.id
             ORDER BY h.created_at DESC,h.id DESC LIMIT 1
           ) latest WHERE latest.decision IN ('accepted','rejected','corrected')
         )
         UNION ALL
         SELECT 'fact'::text target_type,f.id target_id
         FROM rfpilot.extracted_facts f
         WHERE f.intelligence_run_id=$1 AND f.contradiction_group IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM LATERAL (
             SELECT h.decision FROM rfpilot.human_review_events h
             WHERE h.intelligence_run_id=$1 AND h.target_type='fact' AND h.target_id=f.id
             ORDER BY h.created_at DESC,h.id DESC LIMIT 1
           ) latest WHERE latest.decision IN ('accepted','rejected','corrected')
         ) ORDER BY target_type,target_id`,
        [input.runId],
      );
      let createdCount = 0;
      for (const target of targets.rows) {
        const idempotencyKey = `automatic-review:${input.runId}:${target.target_type}:${target.target_id}`;
        const old = await client.query<{ id: string }>(
          "SELECT id FROM rfpilot.human_review_events WHERE organization_id=$1 AND idempotency_key=$2",
          [organizationId, idempotencyKey],
        );
        if (old.rows[0]) continue;
        await client.query(
          `INSERT INTO rfpilot.human_review_events(
             id,organization_id,intelligence_run_id,target_type,target_id,decision,reason_code,note,
             corrected_payload,actor_external_user_id,idempotency_key
           ) VALUES($1,$2,$3,$4,$5,'accepted','automatic_evidence_acknowledgement',$6,NULL,$7,$8)`,
          [uuidv7(), organizationId, input.runId, target.target_type, target.target_id,
            "Automatically acknowledged as the current evidence-derived baseline. The underlying evidence and risks remain visible for optional reviewer correction.",
            input.actorUserMongoId, idempotencyKey],
        );
        createdCount += 1;
      }
      if (createdCount > 0) await audit(client, input, organizationId, "vendor_intelligence.automatically_reviewed", input.runId, { createdReviewCount: createdCount });
      return { runId: input.runId, createdReviewCount: createdCount, created: createdCount > 0 };
    });
  },

  async review(input: Context & {
    runId: string;
    targetType: "fact" | "mapping";
    targetId: string;
    decision: "accepted" | "rejected" | "corrected" | "escalated";
    reasonCode: string;
    note: string;
    correctedPayload: Record<string, unknown> | null;
    idempotencyKey: string;
    correlationId: string;
  }) {
    await loadVersion(input);
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(input.reasonCode) || input.note.length > 2000)
      throw new VendorIntelligenceError("REVIEW_INVALID", "Review reason or note is invalid.", 422);
    if ((input.decision === "corrected") !== Boolean(input.correctedPayload))
      throw new VendorIntelligenceError("REVIEW_INVALID", "A correction requires a corrected value.", 422);
    if (input.correctedPayload && JSON.stringify(input.correctedPayload).length > 8000)
      throw new VendorIntelligenceError("REVIEW_INVALID", "Corrected value is too large.", 422);
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId);
      const proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId);
      const run = await client.query<any>(
        `SELECT r.* FROM rfpilot.vendor_intelligence_runs r
         JOIN rfpilot.requirement_sets s ON s.id=r.requirement_set_id AND s.generator_version=$4
         WHERE r.id=$1 AND r.proposal_reference_id=$2 AND r.vendor_submission_version_mongo_id=$3`,
        [input.runId, proposalReferenceId, input.versionMongoId, REQUIREMENT_GENERATOR_VERSION],
      );
      if (run.rows[0]?.status !== "succeeded")
        throw new VendorIntelligenceError("INTELLIGENCE_RUN_NOT_READY", "Vendor intelligence is not ready for review.", 409);
      const target = input.targetType === "fact"
        ? await client.query<{ id: string; value_kind?: string }>(
          "SELECT id,value_kind FROM rfpilot.extracted_facts WHERE id=$1 AND intelligence_run_id=$2",
          [input.targetId, input.runId],
        )
        : await client.query<{ id: string; value_kind?: string }>(
          `SELECT m.id FROM rfpilot.requirement_evidence_mappings m
             JOIN rfpilot.requirements r ON r.id=m.requirement_id
            WHERE m.id=$1 AND m.intelligence_run_id=$2
              AND ($3::boolean OR r.group_key IS DISTINCT FROM $4)`,
          [
            input.targetId,
            input.runId,
            proposalWorkflowSectionEnabled("video_recording"),
            LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY,
          ],
        );
      if (!target.rows[0]) throw new VendorIntelligenceError("REVIEW_TARGET_NOT_FOUND", "Review target was not found.", 404);
      if (input.decision === "corrected" && input.targetType === "mapping") {
        const relationship = String(input.correctedPayload?.relationship ?? "");
        const fragmentIds = Array.isArray(input.correctedPayload?.fragmentIds) ? input.correctedPayload.fragmentIds : [];
        if (!["supports", "partially_supports", "contradicts", "context_only", "none"].includes(relationship)
          || fragmentIds.some((id) => typeof id !== "string")
          || (relationship === "none" ? fragmentIds.length !== 0 : fragmentIds.length === 0))
          throw new VendorIntelligenceError("REVIEW_INVALID", "Corrected mapping is invalid.", 422);
        const allowed = await client.query<{ id: string }>(
          `WITH current_sources AS (
             SELECT DISTINCT ON (source_kind,coalesce(vendor_document_id::text,'cover_message'))
                    coalesce(reused_from_run_id,id) effective_id,status
             FROM rfpilot.source_extraction_runs WHERE vendor_submission_version_mongo_id=$2
             ORDER BY source_kind,coalesce(vendor_document_id::text,'cover_message'),created_at DESC,id DESC
           )
           SELECT f.id FROM rfpilot.evidence_fragments f
           JOIN current_sources s ON s.effective_id=f.extraction_run_id
           WHERE f.id=ANY($1::uuid[]) AND s.status IN ('succeeded','partial')`,
          [fragmentIds, input.versionMongoId],
        );
        if (allowed.rows.length !== new Set(fragmentIds).size)
          throw new VendorIntelligenceError("CITATION_VALIDATION_FAILED", "Corrected mapping citation is invalid.", 422);
      }
      if (input.decision === "corrected" && input.targetType === "fact") {
        validateFactCorrectionPayload(String(target.rows[0].value_kind), input.correctedPayload);
      }
      const old = await client.query<any>(
        "SELECT * FROM rfpilot.human_review_events WHERE organization_id=$1 AND idempotency_key=$2",
        [organizationId, input.idempotencyKey],
      );
      if (old.rows[0]) return old.rows[0];
      const inserted = await client.query<any>(
        `INSERT INTO rfpilot.human_review_events(
           id,organization_id,intelligence_run_id,target_type,target_id,decision,reason_code,note,
           corrected_payload,actor_external_user_id,idempotency_key
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) RETURNING *`,
        [uuidv7(), organizationId, input.runId, input.targetType, input.targetId, input.decision,
          input.reasonCode, input.note, input.correctedPayload ? JSON.stringify(input.correctedPayload) : null,
          input.actorUserMongoId, input.idempotencyKey],
      );
      await audit(client, input, organizationId, "vendor_intelligence.reviewed", input.runId, {
        targetType: input.targetType, targetId: input.targetId, decision: input.decision, reasonCode: input.reasonCode,
      });
      return inserted.rows[0];
    });
  },
};
