import { v7 as uuidv7 } from "uuid";
import type { PoolClient } from "pg";
import { postgresEnabled, withPostgresTransaction } from "../../../config/postgres";
import { s3PrivateDocumentStorage } from "../documentIngestion/s3PrivateDocumentStorage";
import { safeLog } from "../../shared/observability/safeTelemetry";
import Organization from "../../../modal/organizationModel";

/**
 * Governed retention enforcement.
 *
 * Every AI run writes a retention_until, but nothing ever deleted on it — the
 * column was only ever a read filter, so expired evidence, extracted candidate
 * values, draft prose, and vendor findings stayed in the database and in
 * backups indefinitely while CLIENT_SCOPE.md promised controlled retention.
 *
 * Two properties make this more than "DELETE WHERE retention_until < now()":
 *
 * 1. Retention windows differ across a foreign key. proposal_context_runs
 *    expire after 30 days, but candidate_applications referencing them are
 *    retained for a YEAR. Deleting an expired parent would therefore destroy
 *    application records still inside their own window. Every parent here is
 *    guarded by a NOT EXISTS check against surviving dependants.
 * 2. No FK uses ON DELETE CASCADE — the schema is RESTRICT throughout, which is
 *    a good safety net. Children are deleted explicitly, innermost outward, so
 *    RESTRICT keeps protecting every other code path.
 */

export type SweepCounts = Record<string, number>;
export type SweepResult = { dryRun: boolean; organizations: number; deleted: SweepCounts };

export const retentionSweepEnabled = (): boolean =>
  process.env.RETENTION_SWEEP_ENABLED === "true";

/**
 * Default is a DRY RUN. Enabling the sweep and actually deleting are separate
 * decisions: a multi-table deleter should be observed reporting the right
 * counts before it is allowed to act.
 */
export const retentionSweepApplies = (): boolean =>
  process.env.RETENTION_SWEEP_APPLY === "true";

const BATCH = Math.max(1, Math.min(Number(process.env.RETENTION_SWEEP_BATCH) || 500, 5000));

const add = (counts: SweepCounts, key: string, n: number) => {
  if (n > 0) counts[key] = (counts[key] ?? 0) + n;
};

/** Expired ids for one family, capped per pass, with dependants excluded. */
const expiredIds = async (c: PoolClient, sql: string, limit: number): Promise<string[]> => {
  const result = await c.query<{ id: string }>(sql, [limit]);
  return result.rows.map((row) => row.id);
};

const del = async (
  c: PoolClient,
  counts: SweepCounts,
  table: string,
  column: string,
  ids: string[],
  apply: boolean,
): Promise<void> => {
  if (!ids.length) return;
  if (!apply) {
    // Dry run still measures, so the report reflects what would go.
    const seen = await c.query<{ n: string }>(
      `SELECT count(*)::text n FROM rfpilot.${table} WHERE ${column} = ANY($1::uuid[])`,
      [ids],
    );
    add(counts, table, Number(seen.rows[0]?.n ?? 0));
    return;
  }
  const result = await c.query(
    `DELETE FROM rfpilot.${table} WHERE ${column} = ANY($1::uuid[])`,
    [ids],
  );
  add(counts, table, result.rowCount ?? 0);
};

const sweepOrganization = async (
  c: PoolClient,
  organizationId: string,
  apply: boolean,
): Promise<SweepCounts> => {
  const counts: SweepCounts = {};
  await c.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);

  // 1. Candidate applications (1 year). Deleted first because they are what
  //    pins expired context runs alive.
  const applications = await expiredIds(
    c,
    `SELECT id FROM rfpilot.candidate_applications
      WHERE retention_until < now() ORDER BY retention_until LIMIT $1`,
    BATCH,
  );
  await del(c, counts, "candidate_application_items", "application_id", applications, apply);
  await del(c, counts, "candidate_applications", "id", applications, apply);

  // 2. Vendor analysis (30 days).
  const vendorRuns = await expiredIds(
    c,
    `SELECT id FROM rfpilot.vendor_analysis_runs
      WHERE retention_until < now() ORDER BY retention_until LIMIT $1`,
    BATCH,
  );
  await del(c, counts, "vendor_analysis_findings", "run_id", vendorRuns, apply);
  await del(c, counts, "vendor_analysis_runs", "id", vendorRuns, apply);

  // 3. Draft runs (30 days). A scoped regeneration references its parent run,
  //    so children go before parents within the family too.
  const draftRuns = await expiredIds(
    c,
    `SELECT r.id FROM rfpilot.proposal_draft_runs r
      WHERE r.retention_until < now()
        AND NOT EXISTS (SELECT 1 FROM rfpilot.proposal_draft_runs child
                         WHERE child.parent_run_id = r.id AND child.retention_until >= now())
      ORDER BY r.retention_until LIMIT $1`,
    BATCH,
  );
  await del(c, counts, "proposal_draft_citations", "run_id", draftRuns, apply);
  await del(c, counts, "proposal_draft_paragraphs", "run_id", draftRuns, apply);
  await del(c, counts, "proposal_draft_sections", "run_id", draftRuns, apply);
  await del(c, counts, "proposal_draft_gaps", "run_id", draftRuns, apply);
  await del(c, counts, "proposal_draft_section_decisions", "run_id", draftRuns, apply);
  await del(c, counts, "proposal_draft_runs", "id", draftRuns, apply);

  // 4. Context runs (30 days by default) — only once no candidate application
  //    or review set still referencing them survives. This is the guard that
  //    stops a 30-day parent taking year-retained records with it.
  const contextRuns = await expiredIds(
    c,
    `SELECT r.id FROM rfpilot.proposal_context_runs r
      WHERE r.retention_until < now()
        AND NOT EXISTS (SELECT 1 FROM rfpilot.candidate_applications a WHERE a.run_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM rfpilot.candidate_applications a
                          JOIN rfpilot.candidate_review_sets s ON s.id = a.review_set_id
                         WHERE s.run_id = r.id)
      ORDER BY r.retention_until LIMIT $1`,
    BATCH,
  );
  await del(c, counts, "clarification_questions", "context_run_id", contextRuns, apply);
  await del(c, counts, "proposal_context_run_sources", "run_id", contextRuns, apply);
  await del(c, counts, "proposal_context_evidence", "run_id", contextRuns, apply);
  await del(c, counts, "proposal_context_operations", "run_id", contextRuns, apply);
  await del(c, counts, "proposal_context_issues", "run_id", contextRuns, apply);
  if (contextRuns.length) {
    // Review decisions hang off review sets, which hang off the run.
    const sets = await c.query<{ id: string }>(
      "SELECT id FROM rfpilot.candidate_review_sets WHERE run_id = ANY($1::uuid[])",
      [contextRuns],
    );
    const setIds = sets.rows.map((row) => row.id);
    await del(c, counts, "candidate_review_decisions", "review_set_id", setIds, apply);
    await del(c, counts, "candidate_review_sets", "id", setIds, apply);
  }
  await del(c, counts, "proposal_context_runs", "id", contextRuns, apply);

  // 5. Source documents. Legal hold always wins, and a source is only released
  //    once nothing surviving still points at it. The source row is tombstoned
  //    rather than removed so the audit trail keeps a record that it existed;
  //    the bytes and the filename metadata are what actually go.
  const sources = await c.query<{ id: string; object_key: string | null }>(
    `SELECT s.id, o.object_key
       FROM rfpilot.document_sources s
       LEFT JOIN rfpilot.document_objects o ON o.source_id = s.id
      WHERE s.deleted_at IS NULL
        AND s.legal_hold = false
        AND s.retention_until IS NOT NULL
        AND s.retention_until < now()
        AND NOT EXISTS (SELECT 1 FROM rfpilot.proposal_context_run_sources rs WHERE rs.source_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM rfpilot.conversation_message_attachments a WHERE a.source_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM rfpilot.knowledge_import_documents k WHERE k.document_source_id = s.id)
      ORDER BY s.retention_until LIMIT $1`,
    [BATCH],
  );
  if (sources.rows.length) {
    add(counts, "document_sources", sources.rows.length);
    if (apply) {
      for (const source of sources.rows) {
        if (source.object_key) {
          try {
            await s3PrivateDocumentStorage.delete(source.object_key);
          } catch {
            // Object may already be gone; the tombstone still records intent.
          }
        }
      }
      const ids = sources.rows.map((row) => row.id);
      // Scan results hang off document_objects by object_id, not off the source
      // directly — the same shape of mistake that made purgeProposalArtifacts a
      // permanent no-op, so it is resolved through the objects table here.
      await c.query(
        `DELETE FROM rfpilot.document_scan_results
          WHERE object_id IN (SELECT id FROM rfpilot.document_objects WHERE source_id = ANY($1::uuid[]))`,
        [ids],
      );
      await c.query("DELETE FROM rfpilot.document_objects WHERE source_id = ANY($1::uuid[])", [ids]);
      await c.query(
        "UPDATE rfpilot.document_sources SET deleted_at=now(),status='deleted',updated_at=now() WHERE id = ANY($1::uuid[])",
        [ids],
      );
    }
  }

  if (apply && Object.keys(counts).length) {
    await c.query(
      `INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata)
       VALUES($1,$2,$3,'retention_sweep_applied','organization',$2,'allowed',$4,$5::jsonb)`,
      [uuidv7(), organizationId, "000000000000000000000000", uuidv7(), JSON.stringify(counts)],
    );
  }
  return counts;
};

export const sweepExpiredArtifacts = async (): Promise<SweepResult> => {
  const dryRun = !retentionSweepApplies();
  const result: SweepResult = { dryRun, organizations: 0, deleted: {} };
  if (!postgresEnabled() || !retentionSweepEnabled()) return result;

  // Organizations are enumerated from MongoDB, the identity authority, not from
  // rfpilot.organizations. That table is RLS-protected on
  // external_mongo_id = current_organization_mongo_id(), so selecting from it
  // with no tenant GUC set matches zero rows and the sweep silently does
  // nothing — which is exactly what the first dry run reported. Resolving the
  // tenant from Mongo and then setting the GUC per organization uses the same
  // pattern as every other module and needs no RLS exemption.
  const tenants = await Organization.find({ status: "active" }).select("_id").lean<{ _id: unknown }[]>();
  const organizationMongoIds = tenants.map((row) => String(row._id));

  for (const organizationMongoId of organizationMongoIds) {
    try {
      const counts = await withPostgresTransaction(async (c) => {
        await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [organizationMongoId]);
        const org = await c.query<{ id: string }>(
          "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
          [organizationMongoId],
        );
        if (!org.rows[0]) return {};
        return sweepOrganization(c, org.rows[0].id, !dryRun);
      });
      result.organizations += 1;
      for (const [table, n] of Object.entries(counts)) add(result.deleted, table, n);
    } catch (error) {
      safeLog("error", "retention_sweep_failed", {
        outcome: "failure",
        errorCode: (error as { code?: string } | null)?.code ?? "UNKNOWN",
      });
    }
  }

  safeLog("info", "retention_sweep_completed", {
    outcome: dryRun ? "dry_run" : "applied",
    organizations: result.organizations,
    total: Object.values(result.deleted).reduce((sum, n) => sum + n, 0),
  });
  return result;
};
