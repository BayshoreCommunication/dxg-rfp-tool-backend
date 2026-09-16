import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { postgresEnabled, withPostgresTransaction } from "../../../../../config/postgres";
import { s3PrivateDocumentStorage } from "../../../documentIngestion/s3PrivateDocumentStorage";
import { safeLog } from "../../../../shared/observability/safeTelemetry";
import type { VendorResponseDeletionTarget } from "../../domain/ports/vendorResponseDeleteRepository";

const setTenant = async (client: PoolClient, organizationMongoId: string) => {
  await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [
    organizationMongoId,
  ]);
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

export const purgeVendorResponseArtifacts = async (
  targets: VendorResponseDeletionTarget[],
) => {
  const objectKeys = [...new Set(targets.flatMap((target) => target.objectKeys))];
  for (const objectKey of objectKeys) {
    try {
      await s3PrivateDocumentStorage.delete(objectKey);
    } catch (error) {
      safeLog("warn", "vendor_response_object_delete_failed", {
        outcome: "failure",
        errorCode: (error as { code?: string } | null)?.code ?? "UNKNOWN",
      });
    }
  }

  if (!targets.length || !postgresEnabled()) return;
  const byOrganization = new Map<string, VendorResponseDeletionTarget[]>();
  for (const target of targets) {
    const entries = byOrganization.get(target.organizationId) ?? [];
    entries.push(target);
    byOrganization.set(target.organizationId, entries);
  }

  for (const [organizationMongoId, entries] of byOrganization) {
    try {
      await withPostgresTransaction(async (client) => {
        const organizationId = await setTenant(client, organizationMongoId);
        if (!organizationId) return;
        const submissionIds = entries.flatMap((entry) =>
          entry.submissionId ? [entry.submissionId] : [],
        );
        const sourceIds = [...new Set(entries.flatMap((entry) => entry.sourceIds))];
        await client.query(
          `UPDATE rfpilot.document_sources
              SET deleted_at=now(),status='deleted',updated_at=now()
            WHERE organization_id=$1 AND deleted_at IS NULL
              AND (
                vendor_submission_mongo_id = ANY($2::varchar[])
                OR id::text = ANY($3::varchar[])
              )`,
          [organizationId, submissionIds, sourceIds],
        );
        await client.query(
          `INSERT INTO rfpilot.audit_events(
             id,organization_id,actor_external_user_id,action,target_type,target_id,
             decision,correlation_id,metadata
           ) VALUES($1,$2,$3,'vendor_responses_deleted','vendor_response_set',$4,
             'allowed',$5,$6::jsonb)`,
          [
            uuidv7(),
            organizationId,
            entries[0].ownerUserId,
            entries[0].proposalId,
            uuidv7(),
            JSON.stringify({ count: entries.length }),
          ],
        );
      });
    } catch (error) {
      safeLog("error", "vendor_response_artifacts_purge_failed", {
        outcome: "failure",
        errorCode: (error as { code?: string } | null)?.code ?? "UNKNOWN",
      });
    }
  }
};
