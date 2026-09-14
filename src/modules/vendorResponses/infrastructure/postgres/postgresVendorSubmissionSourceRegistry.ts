import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { postgresEnabled, withPostgresTransaction } from "../../../../../config/postgres";
import type {
  VendorSubmissionSourceRegistry,
  VendorSubmissionVersionRecord,
} from "../../domain/ports/vendorSubmissionRepository";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STRUCTURED_PROVENANCE_VERSION = "structured-response-provenance.v1";

type StructuredFragment = {
  path: string;
  value: string | number | boolean;
  provenance: "vendor_stated" | "server_calculated";
};

const pointerToken = (value: string) =>
  value.replace(/~/g, "~0").replace(/\//g, "~1");

const stableArrayId = (value: Record<string, unknown>): string | null => {
  for (const key of [
    "roomId",
    "specId",
    "equipmentLineId",
    "categoryId",
    "laborLineId",
    "crewMemberId",
    "feeId",
    "alternateId",
    "referenceId",
    "documentId",
    "acknowledgementId",
  ]) {
    if (typeof value[key] === "string" && value[key]) return String(value[key]);
  }
  return null;
};

const flattenStructuredValue = (
  value: unknown,
  path: string,
  provenance: StructuredFragment["provenance"],
  target: StructuredFragment[],
): void => {
  if (
    typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    target.push({ path, value, provenance });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      const stableId = entry && typeof entry === "object"
        ? stableArrayId(entry as Record<string, unknown>)
        : null;
      flattenStructuredValue(
        entry,
        `${path}/${pointerToken(stableId ?? String(index))}`,
        provenance,
        target,
      );
    });
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    flattenStructuredValue(
      entry,
      `${path}/${pointerToken(key)}`,
      provenance,
      target,
    );
  }
};

export const structuredProvenanceFragments = (
  record: VendorSubmissionVersionRecord,
): StructuredFragment[] => {
  if (!record.structuredResponse || !record.calculationSnapshot) return [];
  const fragments: StructuredFragment[] = [];
  flattenStructuredValue(
    record.structuredResponse,
    "/response",
    "vendor_stated",
    fragments,
  );
  flattenStructuredValue(
    record.calculationSnapshot,
    "/calculation",
    "server_calculated",
    fragments,
  );
  return fragments;
};

const checksum = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

const registerStructuredProvenance = async (
  client: PoolClient,
  input: {
    organizationId: string;
    proposalReferenceId: string;
    record: VendorSubmissionVersionRecord;
  },
) => {
  const fragments = structuredProvenanceFragments(input.record);
  if (fragments.length === 0) return 0;
  const idempotencyKey = `structured-response:${input.record.versionId}:${input.record.manifestChecksum}`;
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM rfpilot.source_extraction_runs WHERE organization_id=$1 AND idempotency_key=$2",
    [input.organizationId, idempotencyKey],
  );
  if (existing.rows[0]) return fragments.length;

  const runId = uuidv7();
  const payloadChecksum = checksum(JSON.stringify(fragments));
  await client.query(
    `INSERT INTO rfpilot.source_extraction_runs(
       id,organization_id,proposal_reference_id,document_source_id,
       vendor_submission_mongo_id,vendor_submission_version_mongo_id,
       vendor_document_id,source_kind,source_label,mime_type,source_checksum,
       policy_version,status,extraction_method,native_parser,native_parser_version,
       page_count,character_count,fragment_count,table_count,coverage,warnings,
       warning_count,output_checksum,idempotency_key,started_at,completed_at
     ) VALUES(
       $1,$2,$3,NULL,$4,$5,NULL,'structured_response',
       'Vendor-entered structured response','application/vnd.rfpilot.vendor-response+json',
       $6,$7,'succeeded','native','rfpilot-structured-response',$7,
       0,$8,$9,0,1,'[]'::jsonb,0,$6,$10,$11,$11
     )`,
    [
      runId,
      input.organizationId,
      input.proposalReferenceId,
      input.record.submissionId,
      input.record.versionId,
      payloadChecksum,
      STRUCTURED_PROVENANCE_VERSION,
      fragments.reduce((total, fragment) => total + String(fragment.value).length, 0),
      fragments.length,
      idempotencyKey,
      input.record.receivedAt,
    ],
  );
  for (let ordinal = 0; ordinal < fragments.length; ordinal += 1) {
    const fragment = fragments[ordinal];
    const content = `${fragment.path}: ${String(fragment.value)}`;
    await client.query(
      `INSERT INTO rfpilot.evidence_fragments(
         id,organization_id,extraction_run_id,ordinal,kind,content,locator,
         content_checksum,trust_class
       ) VALUES($1,$2,$3,$4,'structured_field',$5,$6::jsonb,$7,$8)`,
      [
        uuidv7(),
        input.organizationId,
        runId,
        ordinal,
        content,
        JSON.stringify({
          fieldPath: fragment.path,
          versionId: input.record.versionId,
          submissionId: input.record.submissionId,
          questionnaireId: input.record.questionnaire?.questionnaireId,
          questionnaireVersion: input.record.questionnaire?.questionnaireVersion,
          provenance: fragment.provenance,
        }),
        checksum(content),
        fragment.provenance === "server_calculated"
          ? "server_calculation"
          : "first_party_vendor_statement",
      ],
    );
  }
  await client.query(
    `INSERT INTO rfpilot.audit_events(
       id,organization_id,actor_external_user_id,action,target_type,target_id,
       decision,reason,correlation_id,metadata
     ) VALUES($1,$2,NULL,'vendor_submission.structured_provenance.register',
       'vendor_submission_version',$3,'allowed','immutable_structured_snapshot',$4,$5::jsonb)`,
    [
      uuidv7(),
      input.organizationId,
      input.record.versionId,
      `vendor-submission-${input.record.versionId}`,
      JSON.stringify({
        submissionId: input.record.submissionId,
        versionId: input.record.versionId,
        fragmentCount: fragments.length,
        responseSchemaVersion: input.record.responseSchemaVersion,
      }),
    ],
  );
  return fragments.length;
};

const setTenant = async (client: PoolClient, organizationMongoId: string) => {
  await client.query(
    "SELECT set_config('app.organization_mongo_id',$1,true)",
    [organizationMongoId],
  );
  const organization = await client.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [organizationMongoId],
  );
  if (!organization.rows[0]) return null;
  await client.query("SELECT set_config('app.organization_id',$1,true)", [
    organization.rows[0].id,
  ]);
  return organization.rows[0].id;
};

export const postgresVendorSubmissionSourceRegistry: VendorSubmissionSourceRegistry = {
  async register(record: VendorSubmissionVersionRecord) {
    if (!postgresEnabled()) {
      return { registered: 0, pending: record.documents.length };
    }
    return withPostgresTransaction(async (client) => {
      const organizationId = await setTenant(client, record.organizationId);
      if (!organizationId) {
        return { registered: 0, pending: record.documents.length };
      }
      const proposal = await client.query<{ id: string }>(
        "SELECT id FROM rfpilot.proposal_references WHERE organization_id=$1 AND external_mongo_id=$2",
        [organizationId, record.proposalId],
      );
      if (!proposal.rows[0]) {
        return { registered: 0, pending: record.documents.length };
      }

      const registeredStructuredFacts = await registerStructuredProvenance(
        client,
        {
          organizationId,
          proposalReferenceId: proposal.rows[0].id,
          record,
        },
      );

      let registered = 0;
      let pending = 0;
      for (const document of record.documents) {
        if (
          !UUID_PATTERN.test(document.sourceId) ||
          !UUID_PATTERN.test(document.documentId) ||
          document.sizeBytes === null ||
          document.sizeBytes < 1 ||
          !/^[0-9a-f]{64}$/.test(document.sha256 ?? "") ||
          document.scanStatus === "legacy_unknown"
        ) {
          pending += 1;
          continue;
        }
        const source = await client.query<{ id: string }>(
          `INSERT INTO rfpilot.document_sources(
             id,organization_id,proposal_reference_id,uploader_external_user_id,
             purpose,confidentiality,status,origin,vendor_submission_mongo_id,
             vendor_submission_version_mongo_id,vendor_document_id
           ) VALUES($1,$2,$3,NULL,'vendor_submission','restricted','ready','upload',$4,$5,$6)
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            document.sourceId,
            organizationId,
            proposal.rows[0].id,
            record.submissionId,
            record.versionId,
            document.documentId,
          ],
        );
        if (!source.rows[0]) {
          registered += 1;
          continue;
        }
        const objectId = uuidv7();
        await client.query(
          `INSERT INTO rfpilot.document_objects(
             id,organization_id,source_id,object_key,original_filename,safe_filename,
             declared_mime_type,detected_mime_type,expected_size_bytes,actual_size_bytes,
             sha256,uploaded_at,verified_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$8,$9,now(),now())`,
          [
            objectId,
            organizationId,
            document.sourceId,
            document.objectKey,
            document.name.slice(0, 255),
            document.name.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 255),
            document.mimeType,
            document.sizeBytes,
            document.sha256,
          ],
        );
        await client.query(
          `INSERT INTO rfpilot.document_scan_results(
             id,organization_id,object_id,scanner,status,diagnostic_code,started_at,completed_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
          [
            uuidv7(),
            organizationId,
            objectId,
            document.scanStatus === "clean" ? "clamav" : "submission_policy",
            document.scanStatus,
            document.scanStatus === "skipped" ? "SCAN_OPTIONAL_BY_POLICY" : null,
            record.receivedAt,
          ],
        );
        await client.query(
          `INSERT INTO rfpilot.audit_events(
             id,organization_id,actor_external_user_id,action,target_type,target_id,
             decision,reason,correlation_id,metadata
           ) VALUES($1,$2,NULL,'vendor_submission.source.register','document_source',$3,
             'allowed',$4,$5,$6::jsonb)`,
          [
            uuidv7(),
            organizationId,
            document.sourceId,
            document.scanStatus === "skipped" ? "scan_optional_by_policy" : "clean_scan",
            `vendor-submission-${record.versionId}`,
            JSON.stringify({
              submissionId: record.submissionId,
              versionId: record.versionId,
              documentId: document.documentId,
              sha256: document.sha256,
            }),
          ],
        );
        registered += 1;
      }
      return { registered, pending, registeredStructuredFacts };
    });
  },
};
