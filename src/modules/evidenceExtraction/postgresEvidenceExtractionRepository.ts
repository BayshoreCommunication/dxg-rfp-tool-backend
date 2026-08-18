/* eslint-disable @typescript-eslint/no-explicit-any */
import { v7 as uuidv7 } from "uuid";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../../../config/postgres";
import VendorSubmission from "../../../modal/vendorSubmissionModel";
import VendorSubmissionVersion from "../../../modal/vendorSubmissionVersionModel";
import { s3PrivateDocumentStorage } from "../documentIngestion/s3PrivateDocumentStorage";
import { awsTextractOcrProvider } from "./awsTextractOcrProvider";
import {
  checksum,
  EvidenceExtractionError,
  EXTRACTION_POLICY_VERSION,
  MAX_EXTRACTION_BYTES,
  supportedEvidenceMimeTypes,
} from "./domain";
import { extractEvidenceSource } from "./extractSource";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const tenant = async (client: PoolClient, organizationMongoId: string) => {
  await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [organizationMongoId]);
  const result = await client.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [organizationMongoId],
  );
  if (!result.rows[0]) throw new EvidenceExtractionError("ORGANIZATION_NOT_READY", "Organization unavailable.", 503);
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
  if (!result.rows[0]) throw new EvidenceExtractionError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  return result.rows[0].id;
};

const loadVersion = async (input: {
  organizationMongoId: string;
  actorUserMongoId: string;
  proposalMongoId: string;
  submissionMongoId: string;
  versionMongoId: string;
}) => {
  const submission = await VendorSubmission.findOne({
    _id: input.submissionMongoId,
    organizationId: input.organizationMongoId,
    proposalId: input.proposalMongoId,
    proposalOwnerId: input.actorUserMongoId,
  }).lean<any>();
  if (!submission) throw new EvidenceExtractionError("VENDOR_SUBMISSION_NOT_FOUND", "Vendor submission was not found.", 404);
  const version = await VendorSubmissionVersion.findOne({
    _id: input.versionMongoId,
    organizationId: input.organizationMongoId,
    proposalId: input.proposalMongoId,
    submissionId: input.submissionMongoId,
  }).lean<any>();
  if (!version) throw new EvidenceExtractionError("VENDOR_VERSION_NOT_FOUND", "Vendor submission version was not found.", 404);
  return version;
};

const rowView = (row: any) => ({
  runId: row.id,
  jobId: row.job_id ?? null,
  sourceKind: row.source_kind,
  sourceLabel: row.source_label,
  mimeType: row.mime_type,
  status: row.status,
  method: row.extraction_method ?? null,
  coverage: Number(row.coverage ?? 0),
  fragmentCount: Number(row.fragment_count ?? 0),
  tableCount: Number(row.table_count ?? 0),
  pageCount: Number(row.page_count ?? 0),
  warnings: Array.isArray(row.warnings) ? row.warnings : [],
  reused: Boolean(row.reused_from_run_id),
  createdAt: row.created_at,
  completedAt: row.completed_at ?? null,
});

export const evidenceExtractionRepository = {
  async create(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    proposalMongoId: string;
    submissionMongoId: string;
    versionMongoId: string;
    idempotencyKey: string;
    correlationId: string;
  }) {
    const version = await loadVersion(input);
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId);
      const proposalId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId);
      const registered = await client.query<any>(
        `SELECT s.id source_id,s.vendor_document_id,o.object_key,o.detected_mime_type,o.declared_mime_type,
                o.sha256,o.actual_size_bytes,s.status
         FROM rfpilot.document_sources s
         JOIN rfpilot.document_objects o ON o.source_id=s.id
         WHERE s.organization_id=$1 AND s.proposal_reference_id=$2
           AND s.vendor_document_id = ANY($3::uuid[])`,
        [organizationId, proposalId, (version.documents ?? []).map((document: any) => document.documentId).filter((id: string) => UUID.test(id))],
      );
      const byDocument = new Map(registered.rows.map((row: any) => [String(row.vendor_document_id), row]));
      const sources: Array<any> = [];
      const unavailable: Array<{ sourceLabel: string; code: string }> = [];
      const message = String(version.message ?? "").trim();
      if (message) sources.push({
        kind: "cover_message",
        label: "Cover message",
        mimeType: "text/plain",
        sourceChecksum: checksum(message),
        documentId: null,
        documentSourceId: null,
      });
      for (const document of version.documents ?? []) {
        const registration = byDocument.get(String(document.documentId));
        if (!registration || registration.status !== "ready") {
          unavailable.push({ sourceLabel: String(document.name || "Attachment"), code: "SOURCE_NOT_REGISTERED" });
          continue;
        }
        const mimeType = String(registration.detected_mime_type || registration.declared_mime_type || document.mimeType);
        if (!supportedEvidenceMimeTypes.has(mimeType)) {
          unavailable.push({ sourceLabel: String(document.name || "Attachment"), code: "SOURCE_TYPE_UNSUPPORTED" });
          continue;
        }
        sources.push({
          kind: "document",
          label: String(document.name || "Attachment").slice(0, 255),
          mimeType,
          sourceChecksum: String(registration.sha256 || document.sha256),
          documentId: document.documentId,
          documentSourceId: registration.source_id,
        });
      }
      const runs: Array<any> = [];
      for (const source of sources) {
        const sourceKey = `evidence:${input.versionMongoId}:${source.kind}:${source.documentId || "message"}:${source.sourceChecksum}:${EXTRACTION_POLICY_VERSION}`;
        const stableKey = `${sourceKey}:request:${input.idempotencyKey}`;
        const priorRequest = await client.query<any>(
          "SELECT * FROM rfpilot.source_extraction_runs WHERE organization_id=$1 AND idempotency_key=$2",
          [organizationId, stableKey],
        );
        if (priorRequest.rows[0]) { runs.push(rowView(priorRequest.rows[0])); continue; }
        const existing = await client.query<any>(
          `SELECT * FROM rfpilot.source_extraction_runs
           WHERE organization_id=$1 AND vendor_submission_version_mongo_id=$2 AND source_kind=$3
             AND coalesce(vendor_document_id::text,'cover_message')=$4 AND source_checksum=$5 AND policy_version=$6
           ORDER BY created_at DESC,id DESC LIMIT 1`,
          [organizationId, input.versionMongoId, source.kind, source.documentId || "cover_message", source.sourceChecksum, EXTRACTION_POLICY_VERSION],
        );
        if (existing.rows[0] && ["queued", "running", "succeeded"].includes(existing.rows[0].status)) { runs.push(rowView(existing.rows[0])); continue; }
        const reusable = await client.query<any>(
          `SELECT * FROM rfpilot.source_extraction_runs
           WHERE organization_id=$1 AND source_checksum=$2 AND mime_type=$3 AND policy_version=$4
             AND status='succeeded'
           ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
          [organizationId, source.sourceChecksum, source.mimeType, EXTRACTION_POLICY_VERSION],
        );
        const runId = uuidv7();
        if (reusable.rows[0]) {
          const reused = await client.query<any>(
            `INSERT INTO rfpilot.source_extraction_runs(
               id,organization_id,proposal_reference_id,document_source_id,vendor_submission_mongo_id,
               vendor_submission_version_mongo_id,vendor_document_id,source_kind,source_label,mime_type,
               source_checksum,policy_version,reused_from_run_id,status,extraction_method,native_parser,
               native_parser_version,ocr_provider,ocr_provider_version,page_count,character_count,
               fragment_count,table_count,coverage,warnings,warning_count,output_checksum,idempotency_key,
               completed_at
             ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,id,status,extraction_method,native_parser,
               native_parser_version,ocr_provider,ocr_provider_version,page_count,character_count,
               fragment_count,table_count,coverage,warnings,warning_count,output_checksum,$13,now()
             FROM rfpilot.source_extraction_runs WHERE id=$14 RETURNING *`,
            [runId, organizationId, proposalId, source.documentSourceId, input.submissionMongoId, input.versionMongoId,
              source.documentId, source.kind, source.label, source.mimeType, source.sourceChecksum,
              EXTRACTION_POLICY_VERSION, stableKey, reusable.rows[0].id],
          );
          runs.push(rowView(reused.rows[0]));
          continue;
        }
        const jobId = uuidv7();
        await client.query(
          `INSERT INTO rfpilot.ai_jobs(
             id,organization_id,proposal_reference_id,job_type,status,idempotency_key,input_reference,
             input_version,input_checksum,max_attempts,correlation_id,initiator_external_user_id
           ) VALUES($1,$2,$3,'vendor_source_extract','queued',$4,$5,$6,$7,3,$8,$9)`,
          [jobId, organizationId, proposalId, stableKey, runId, EXTRACTION_POLICY_VERSION, source.sourceChecksum, input.correlationId, input.actorUserMongoId],
        );
        const inserted = await client.query<any>(
          `INSERT INTO rfpilot.source_extraction_runs(
             id,organization_id,proposal_reference_id,document_source_id,vendor_submission_mongo_id,
             vendor_submission_version_mongo_id,vendor_document_id,source_kind,source_label,mime_type,
             source_checksum,policy_version,job_id,idempotency_key
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [runId, organizationId, proposalId, source.documentSourceId, input.submissionMongoId, input.versionMongoId,
            source.documentId, source.kind, source.label, source.mimeType, source.sourceChecksum,
            EXTRACTION_POLICY_VERSION, jobId, stableKey],
        );
        const payload = {
          jobId,
          organizationMongoId: input.organizationMongoId,
          actorUserMongoId: input.actorUserMongoId,
          jobType: "vendor_source_extract",
          inputReference: runId,
          inputVersion: EXTRACTION_POLICY_VERSION,
          correlationId: input.correlationId,
        };
        await client.query(
          `INSERT INTO rfpilot.outbox_events(
             id,organization_id,aggregate_type,aggregate_id,event_type,idempotency_key,payload
           ) VALUES($1,$2,'ai_job',$3,'job.queued',$4,$5::jsonb)`,
          [uuidv7(), organizationId, jobId, `job.queued:${jobId}:1`, JSON.stringify(payload)],
        );
        runs.push(rowView(inserted.rows[0]));
      }
      return { runs, unavailable, requestIdempotencyKey: input.idempotencyKey };
    });
  },

  async execute(input: { organizationMongoId: string; actorUserMongoId: string; runId: string }) {
    const metadata = await withPostgresTransaction(async (client) => {
      await tenant(client, input.organizationMongoId);
      const result = await client.query<any>(
        `SELECT r.*,o.object_key FROM rfpilot.source_extraction_runs r
         LEFT JOIN rfpilot.document_objects o ON o.source_id=r.document_source_id
         WHERE r.id=$1 FOR UPDATE OF r`,
        [input.runId],
      );
      const row = result.rows[0];
      if (!row) throw new EvidenceExtractionError("EXTRACTION_RUN_NOT_FOUND", "Extraction run was not found.", 404);
      if (["succeeded", "partial", "unreadable"].includes(row.status)) return row;
      await client.query(
        "UPDATE rfpilot.source_extraction_runs SET status='running',started_at=coalesce(started_at,now()),updated_at=now(),safe_error_code=NULL WHERE id=$1",
        [input.runId],
      );
      return row;
    });
    if (["succeeded", "partial", "unreadable"].includes(metadata.status)) return { resultReference: input.runId };
    let bytes: Buffer;
    if (metadata.source_kind === "cover_message") {
      const version = await VendorSubmissionVersion.findOne({
        _id: metadata.vendor_submission_version_mongo_id,
        organizationId: input.organizationMongoId,
        submissionId: metadata.vendor_submission_mongo_id,
      }).select("message").lean<any>();
      if (!version) throw new EvidenceExtractionError("VENDOR_VERSION_NOT_FOUND", "Vendor submission version was not found.", 404);
      bytes = Buffer.from(String(version.message ?? "").trim(), "utf8");
    } else {
      if (!metadata.object_key) throw new EvidenceExtractionError("SOURCE_OBJECT_NOT_FOUND", "The source object is unavailable.", 404);
      bytes = (await s3PrivateDocumentStorage.read({ objectKey: metadata.object_key, maxBytes: MAX_EXTRACTION_BYTES })).bytes;
    }
    if (checksum(bytes) !== metadata.source_checksum) {
      throw new EvidenceExtractionError("SOURCE_CHECKSUM_MISMATCH", "The source failed integrity verification.", 409);
    }
    const extracted = await extractEvidenceSource({ bytes, mimeType: metadata.mime_type, ocr: awsTextractOcrProvider });
    await withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId);
      for (const fragment of extracted.fragments) {
        await client.query(
          `INSERT INTO rfpilot.evidence_fragments(
             id,organization_id,extraction_run_id,ordinal,kind,content,locator,content_checksum
           ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
          [uuidv7(), organizationId, input.runId, fragment.ordinal,
            metadata.source_kind === "cover_message" ? "cover_message" : ["csv", "xlsx"].includes(extracted.parserKind ?? "") ? "table_row" : extracted.method === "ocr" ? "line" : "paragraph",
            fragment.content, JSON.stringify(fragment.coordinates), fragment.checksum],
        );
      }
      for (const table of extracted.tables) {
        const tableId = uuidv7();
        await client.query(
          `INSERT INTO rfpilot.evidence_tables(
             id,organization_id,extraction_run_id,table_key,label,locator,ordinal,row_count,column_count,content_checksum
           ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
          [tableId, organizationId, input.runId, table.key, table.label, JSON.stringify(table.coordinates),
            table.ordinal, table.rowCount, table.columnCount, table.checksum],
        );
        for (const cell of table.cells) {
          await client.query(
            `INSERT INTO rfpilot.evidence_table_cells(
               id,organization_id,evidence_table_id,row_index,column_index,content,content_checksum,is_header,locator
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
            [uuidv7(), organizationId, tableId, cell.row, cell.column, cell.content, cell.checksum, cell.isHeader, JSON.stringify(cell.coordinates)],
          );
        }
      }
      await client.query(
        `UPDATE rfpilot.source_extraction_runs SET
           status=$2,extraction_method=$3,native_parser=$4,native_parser_version=$5,
           ocr_provider=$6,ocr_provider_version=$7,page_count=$8,character_count=$9,
           fragment_count=$10,table_count=$11,coverage=$12,warnings=$13::jsonb,
           warning_count=$14,output_checksum=$15,completed_at=now(),updated_at=now()
         WHERE id=$1`,
        [input.runId, extracted.status, extracted.method, extracted.parserKind, extracted.parserVersion,
          extracted.ocrProvider, extracted.ocrProviderVersion, extracted.pageCount,
          extracted.fragments.reduce((total, item) => total + item.content.length, 0),
          extracted.fragments.length, extracted.tables.length, extracted.coverage,
          JSON.stringify(extracted.warnings), extracted.warnings.length, extracted.outputChecksum],
      );
    });
    return { resultReference: input.runId };
  },

  async fail(input: { organizationMongoId: string; runId: string; code: string }) {
    return withPostgresTransaction(async (client) => {
      await tenant(client, input.organizationMongoId);
      await client.query(
        "UPDATE rfpilot.source_extraction_runs SET status='failed',safe_error_code=$2,completed_at=now(),updated_at=now() WHERE id=$1 AND status NOT IN ('succeeded','partial','unreadable')",
        [input.runId, input.code.slice(0, 100)],
      );
    });
  },

  async read(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    proposalMongoId: string;
    submissionMongoId: string;
    versionMongoId: string;
  }) {
    await loadVersion(input);
    return withPostgresTransaction(async (client) => {
      await tenant(client, input.organizationMongoId);
      await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId);
      const result = await client.query<any>(
        `SELECT DISTINCT ON (source_kind,coalesce(vendor_document_id::text,'cover_message')) *
         FROM rfpilot.source_extraction_runs
         WHERE vendor_submission_mongo_id=$1 AND vendor_submission_version_mongo_id=$2
         ORDER BY source_kind,coalesce(vendor_document_id::text,'cover_message'),created_at DESC,id DESC`,
        [input.submissionMongoId, input.versionMongoId],
      );
      const runs = [];
      for (const row of result.rows) {
        const effectiveRunId = row.reused_from_run_id || row.id;
        const preview = await client.query<any>(
          `SELECT ordinal,kind,content,locator FROM rfpilot.evidence_fragments
           WHERE extraction_run_id=$1 ORDER BY ordinal LIMIT 8`,
          [effectiveRunId],
        );
        runs.push({ ...rowView(row), preview: preview.rows.map((item: any) => ({
          ordinal: item.ordinal,
          kind: item.kind,
          content: String(item.content).slice(0, 1200),
          locator: item.locator,
          trustClass: "untrusted_vendor_content",
        })) });
      }
      const statuses = runs.map((run) => run.status);
      const status = !runs.length ? "not_started"
        : statuses.some((value) => ["queued", "running"].includes(value)) ? "processing"
        : statuses.every((value) => value === "succeeded") ? "ready"
        : statuses.some((value) => ["succeeded", "partial"].includes(value)) ? "partial"
        : statuses.every((value) => value === "unreadable") ? "unreadable" : "failed";
      return { status, runs };
    });
  },
};
