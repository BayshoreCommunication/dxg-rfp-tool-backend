import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { postgresEnabled, withPostgresTransaction } from "../../../../../config/postgres";
import type {
  VendorSubmissionSourceRegistry,
  VendorSubmissionVersionRecord,
} from "../../domain/ports/vendorSubmissionRepository";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      return { registered, pending };
    });
  },
};
