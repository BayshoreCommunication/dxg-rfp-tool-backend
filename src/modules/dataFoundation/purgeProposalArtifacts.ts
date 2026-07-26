import { v7 as uuidv7 } from "uuid";
import { postgresEnabled, withPostgresTransaction } from "../../../config/postgres";
import { s3PrivateDocumentStorage } from "../documentIngestion/s3PrivateDocumentStorage";
import { safeLog } from "../../shared/observability/safeTelemetry";

// Cross-store deletion propagation: when Mongo hard-deletes a purged proposal,
// its private source objects are removed from storage and the Postgres source
// rows are tombstoned. Immutable AI evidence/audit rows are intentionally
// retained until their own retention windows expire (they hold no raw
// document content — only checksums, locators and validated outputs).
export const purgeProposalArtifacts = async (proposalMongoIds: string[]): Promise<void> => {
  if (!proposalMongoIds.length || !postgresEnabled()) return;
  for (const proposalMongoId of proposalMongoIds) {
    try {
      await withPostgresTransaction(async (c) => {
        const ref = await c.query<{ id: string; organization_id: string }>(
          "SELECT p.id,p.organization_id FROM rfpilot.proposal_references p WHERE p.external_mongo_id=$1",
          [proposalMongoId],
        );
        if (!ref.rows[0]) return;
        await c.query("SELECT set_config('app.organization_id',$1,true)", [ref.rows[0].organization_id]);
        const sources = await c.query<{ id: string; object_key: string }>(
          "SELECT id,object_key FROM rfpilot.document_sources WHERE proposal_reference_id=$1 AND deleted_at IS NULL",
          [ref.rows[0].id],
        );
        for (const source of sources.rows) {
          try {
            await s3PrivateDocumentStorage.delete(source.object_key);
          } catch {
            // Object may already be gone; the tombstone below still records intent.
          }
          await c.query("UPDATE rfpilot.document_sources SET deleted_at=now(),status='deleted',updated_at=now() WHERE id=$1", [source.id]);
        }
        await c.query(
          "UPDATE rfpilot.conversations SET status='archived',updated_at=now() WHERE proposal_reference_id=$1 AND status='active'",
          [ref.rows[0].id],
        );
        await c.query(
          "INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata) VALUES($1,$2,$3,'proposal_artifacts_purged','proposal',$4,'allowed',$5,$6::jsonb)",
          [uuidv7(), ref.rows[0].organization_id, "000000000000000000000000", ref.rows[0].id, uuidv7(), JSON.stringify({ count: sources.rows.length })],
        );
      });
      safeLog("info", "proposal_artifacts_purged", { outcome: "success" });
    } catch {
      safeLog("warn", "proposal_artifacts_purge_failed", { outcome: "failure" });
    }
  }
};
