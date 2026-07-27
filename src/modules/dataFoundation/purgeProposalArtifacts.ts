import { v7 as uuidv7 } from "uuid";
import { postgresEnabled, withPostgresTransaction } from "../../../config/postgres";
import { s3PrivateDocumentStorage } from "../documentIngestion/s3PrivateDocumentStorage";
import { safeLog } from "../../shared/observability/safeTelemetry";

// Cross-store deletion propagation: when Mongo hard-deletes a purged proposal,
// its private source objects are removed from storage and the Postgres source
// rows are tombstoned. Immutable AI evidence/audit rows are intentionally
// retained until their own retention windows expire (they hold no raw
// document content — only checksums, locators and validated outputs).
export const purgeProposalArtifacts = async (
  proposals: Array<{ proposalMongoId: string; organizationMongoId: string }>,
): Promise<void> => {
  if (!proposals.length || !postgresEnabled()) return;
  for (const { proposalMongoId, organizationMongoId } of proposals) {
    try {
      await withPostgresTransaction(async (c) => {
        // The tenant is resolved from Mongo, the identity authority, and the
        // GUC is set before any tenant table is read. Deriving the organization
        // FROM proposal_references was circular: that table is RLS-protected on
        // organization_id = current_organization_id(), so with no GUC set it
        // matched zero rows and the purge returned silently — after Mongo had
        // already hard-deleted the proposal.
        await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [organizationMongoId]);
        const org = await c.query<{ id: string }>(
          "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
          [organizationMongoId],
        );
        if (!org.rows[0]) return;
        await c.query("SELECT set_config('app.organization_id',$1,true)", [org.rows[0].id]);
        const ref = await c.query<{ id: string; organization_id: string }>(
          "SELECT p.id,p.organization_id FROM rfpilot.proposal_references p WHERE p.external_mongo_id=$1",
          [proposalMongoId],
        );
        if (!ref.rows[0]) return;
        // object_key lives on document_objects, not document_sources. Selecting
        // it from the wrong table raised 42703, aborting the transaction into
        // the swallowed catch below — so no S3 delete, no tombstone, no audit
        // event has ever run. LEFT JOIN because a source can exist before its
        // object row does (upload session created, bytes never PUT).
        const sources = await c.query<{ id: string; object_key: string | null }>(
          `SELECT s.id, o.object_key
             FROM rfpilot.document_sources s
             LEFT JOIN rfpilot.document_objects o ON o.source_id = s.id
            WHERE s.proposal_reference_id=$1 AND s.deleted_at IS NULL`,
          [ref.rows[0].id],
        );
        for (const source of sources.rows) {
          if (source.object_key) {
            try {
              await s3PrivateDocumentStorage.delete(source.object_key);
            } catch {
              // Object may already be gone; the tombstone below still records intent.
            }
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
    } catch (error) {
      // Loud, and with the driver's error code. Mongo has already hard-deleted
      // the proposal by the time this runs, so a failure here means storage
      // objects and Postgres rows are orphaned with no other signal. A silent
      // warn is how a permanently broken purge went unnoticed.
      safeLog("error", "proposal_artifacts_purge_failed", {
        outcome: "failure",
        errorCode: (error as { code?: string } | null)?.code ?? "UNKNOWN",
      });
    }
  }
};
