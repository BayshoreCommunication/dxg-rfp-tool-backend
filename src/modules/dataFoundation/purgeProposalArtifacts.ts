import { v7 as uuidv7 } from "uuid";
import type { PoolClient } from "pg";
import { postgresEnabled, withPostgresTransaction } from "../../../config/postgres";
import { s3PrivateDocumentStorage } from "../documentIngestion/s3PrivateDocumentStorage";
import { markSourcesDeleted, markSourcesDeletionPending } from "../documentIngestion/sourceDeletionTransitions";
import { safeLog } from "../../shared/observability/safeTelemetry";

// Cross-store deletion propagation: when a proposal is permanently deleted, its
// private source objects are removed from storage and the Postgres source rows
// are tombstoned. Immutable AI evidence/audit rows are intentionally retained
// until their own retention windows expire (they hold no raw document content —
// only checksums, locators and validated outputs).
//
// Order of operations for one proposal, and what a failure leaves behind:
//
//   1. One transaction marks every live source `deletion_pending` and commits.
//      A failure here changes nothing.
//   2. Each source's object is deleted from storage, outside any transaction.
//      A failure leaves that source `deletion_pending`; its object may or may
//      not still exist.
//   3. One transaction tombstones the sources whose object delete succeeded
//      and, only when no live source is left, archives the conversation and
//      writes the `proposal_artifacts_purged` audit event. A failure here
//      leaves the sources `deletion_pending` with their objects already gone.
//
// Every one of those states is finished by calling this function again with
// the same proposal: deleting an object that is already gone succeeds, and a
// `deletion_pending` source is picked up like any other live source. The
// callers that keep the MongoDB record retry on their next run; for a proposal
// MongoDB no longer has, finishStrandedProposalPurges does it from the daily
// job. The result below is how a caller learns that a purge did not finish.

export type ProposalArtifactPurgeResult = {
  proposalMongoId: string;
  organizationMongoId: string;
  /** True when no live source of the proposal is left (or there was nothing to purge). */
  complete: boolean;
  /**
   * Set when there was nothing to purge: Postgres is off, the organization was
   * never written to Postgres, or it has no reference for this proposal.
   * `complete` is true for these. An organization that IS in Postgres but not
   * active is different: its rows cannot be reached, so the result is not
   * complete and carries errorCode ORGANIZATION_INACTIVE.
   */
  skipped?: "postgres_disabled" | "organization_not_in_postgres" | "proposal_reference_not_found";
  sources: {
    /** Tombstoned by this call. */
    tombstoned: number;
    /** Left `deletion_pending` because the object delete or the last step failed. */
    pending: number;
    /** Not touched: under legal hold or retention, or in a status with no way to `deleted`. */
    notDeletable: number;
  };
  /** First failure's code when `complete` is false. */
  errorCode?: string;
};

type Scope = { organizationId: string; referenceId: string };
type NoScope = "organization_not_in_postgres" | "organization_inactive" | "proposal_reference_not_found";

export type PurgeOptions = {
  /**
   * Finish only sources that are already `deletion_pending`; mark nothing new.
   * For a proposal known only from Postgres (MongoDB no longer has it), where
   * an earlier purge already marked what it was allowed to mark.
   */
  onlyPending?: boolean;
};

// A missing object is a deleted object. S3 answers a delete of an unknown key
// with success; a store that answers NoSuchKey instead means the same thing.
// Nothing else counts: NoSuchBucket or a bare 404 is a failure.
const objectAlreadyGone = (error: unknown): boolean => (error as { name?: unknown } | null)?.name === "NoSuchKey";

const errorCodeOf = (error: unknown): string => {
  const candidate = error as { code?: unknown; name?: unknown } | null;
  if (typeof candidate?.code === "string" && candidate.code) return candidate.code;
  if (typeof candidate?.name === "string" && candidate.name && candidate.name !== "Error") return candidate.name;
  return "UNKNOWN";
};

// The tenant is resolved from Mongo, the identity authority, and the GUC is
// set before any tenant table is read. Deriving the organization FROM
// proposal_references was circular: that table is RLS-protected on
// organization_id = current_organization_id(), so with no GUC set it matched
// zero rows and the purge returned silently.
const enterScope = async (
  c: PoolClient,
  proposalMongoId: string,
  organizationMongoId: string,
): Promise<Scope | NoScope> => {
  await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [organizationMongoId]);
  const org = await c.query<{ id: string; status: string }>(
    "SELECT id, status FROM rfpilot.organizations WHERE external_mongo_id=$1",
    [organizationMongoId],
  );
  // No row: nothing of this organization is in Postgres. A row that is not
  // active: its documents may well be there, and this purge will not reach them.
  if (!org.rows[0]) return "organization_not_in_postgres";
  if (org.rows[0].status !== "active") return "organization_inactive";
  await c.query("SELECT set_config('app.organization_id',$1,true)", [org.rows[0].id]);
  // The organization is in the statement as well as in the policy, so the
  // lookup is still scoped under a login that row-level security does not bind.
  // A reference filed under a DIFFERENT organization than MongoDB names is
  // invisible here by design and reads as "no reference".
  const ref = await c.query<{ id: string }>(
    "SELECT p.id FROM rfpilot.proposal_references p WHERE p.external_mongo_id=$1 AND p.organization_id=$2",
    [proposalMongoId, org.rows[0].id],
  );
  if (!ref.rows[0]) return "proposal_reference_not_found";
  return { organizationId: org.rows[0].id, referenceId: ref.rows[0].id };
};

const purgeOne = async (
  proposalMongoId: string,
  organizationMongoId: string,
  options: PurgeOptions,
): Promise<ProposalArtifactPurgeResult> => {
  const result: ProposalArtifactPurgeResult = {
    proposalMongoId,
    organizationMongoId,
    complete: false,
    sources: { tombstoned: 0, pending: 0, notDeletable: 0 },
  };

  // Step 1: mark, and commit, before anything leaves storage.
  const marked = await withPostgresTransaction(async (c) => {
    const scope = await enterScope(c, proposalMongoId, organizationMongoId);
    if (typeof scope === "string") return scope;
    // object_key lives on document_objects, not document_sources. LEFT JOIN
    // because a source can exist before its object row does (upload session
    // created, bytes never PUT).
    const sources = await c.query<{ id: string; status: string; object_key: string | null; protected: boolean }>(
      `SELECT s.id, s.status, o.object_key,
              (s.legal_hold OR coalesce(s.retention_until > now(), false)) AS protected
         FROM rfpilot.document_sources s
         LEFT JOIN rfpilot.document_objects o ON o.source_id = s.id
        WHERE s.proposal_reference_id=$1 AND s.deleted_at IS NULL
        ORDER BY s.id FOR UPDATE OF s`,
      [scope.referenceId],
    );
    // Legal hold and retention win over a proposal delete, as they do for a
    // single-document delete (requestDeletion) and the retention sweep.
    const candidates = sources.rows.filter((source) => !source.protected);
    const pendingIds = options.onlyPending
      ? candidates.filter((source) => source.status === "deletion_pending").map((source) => source.id)
      : (await markSourcesDeletionPending(c, candidates.map((source) => source.id))).pending;
    return {
      pending: candidates.filter((source) => pendingIds.includes(source.id)),
      notDeletable: sources.rows.length - pendingIds.length,
    };
  });
  if (marked === "organization_inactive") return { ...result, errorCode: "ORGANIZATION_INACTIVE" };
  if (typeof marked === "string") return { ...result, complete: true, skipped: marked };
  result.sources.notDeletable = marked.notDeletable;
  if (marked.notDeletable > 0) result.errorCode = "SOURCE_NOT_DELETABLE";

  // Step 2: storage. A source whose object could not be deleted stays
  // `deletion_pending`; it is never tombstoned over a file that may still exist.
  const objectGone: string[] = [];
  for (const source of marked.pending) {
    if (source.object_key) {
      try {
        await s3PrivateDocumentStorage.delete(source.object_key);
      } catch (error) {
        if (!objectAlreadyGone(error)) {
          result.errorCode ??= errorCodeOf(error);
          continue;
        }
      }
    }
    objectGone.push(source.id);
  }

  // Step 3: tombstone, and close the proposal out only if nothing live is left.
  const closed = await withPostgresTransaction(async (c) => {
    const scope = await enterScope(c, proposalMongoId, organizationMongoId);
    if (typeof scope === "string") return { tombstoned: 0, remaining: marked.pending.length + marked.notDeletable };
    // Two purges of one proposal take this step one after the other: the
    // second sees what the first tombstoned and the event it wrote.
    await c.query("SELECT id FROM rfpilot.proposal_references WHERE id=$1 FOR UPDATE", [scope.referenceId]);
    const tombstoned = await markSourcesDeleted(c, objectGone);
    const live = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM rfpilot.document_sources WHERE proposal_reference_id=$1 AND deleted_at IS NULL",
      [scope.referenceId],
    );
    const remaining = live.rows[0]?.n ?? 0;
    if (remaining > 0) return { tombstoned: tombstoned.length, remaining };
    const archived = await c.query(
      "UPDATE rfpilot.conversations SET status='archived',updated_at=now() WHERE proposal_reference_id=$1 AND status='active'",
      [scope.referenceId],
    );
    // One event when the proposal is closed out. A repeat call that finds
    // nothing left to do and an event already written adds no second one.
    // `count` is every tombstoned source of the proposal, whichever call (or
    // earlier single-document delete) tombstoned it.
    const total = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM rfpilot.document_sources WHERE proposal_reference_id=$1 AND deleted_at IS NOT NULL",
      [scope.referenceId],
    );
    const already = await c.query(
      "SELECT 1 FROM rfpilot.audit_events WHERE action='proposal_artifacts_purged' AND target_type='proposal' AND target_id=$1 LIMIT 1",
      [scope.referenceId],
    );
    if (tombstoned.length > 0 || (archived.rowCount ?? 0) > 0 || !already.rows[0]) {
      await c.query(
        "INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata) VALUES($1,$2,$3,'proposal_artifacts_purged','proposal',$4,'allowed',$5,$6::jsonb)",
        [uuidv7(), scope.organizationId, "000000000000000000000000", scope.referenceId, uuidv7(), JSON.stringify({ count: total.rows[0]?.n ?? 0 })],
      );
    }
    return { tombstoned: tombstoned.length, remaining };
  });

  result.sources.tombstoned = closed.tombstoned;
  result.sources.pending = Math.max(0, closed.remaining - marked.notDeletable);
  result.complete = closed.remaining === 0;
  if (result.complete) delete result.errorCode;
  else result.errorCode ??= "SOURCES_REMAIN";
  return result;
};

export const purgeProposalArtifacts = async (
  proposals: Array<{ proposalMongoId: string; organizationMongoId: string }>,
  options: PurgeOptions = {},
): Promise<ProposalArtifactPurgeResult[]> => {
  const results: ProposalArtifactPurgeResult[] = [];
  for (const { proposalMongoId, organizationMongoId } of proposals) {
    const empty = { tombstoned: 0, pending: 0, notDeletable: 0 };
    if (!postgresEnabled()) {
      results.push({ proposalMongoId, organizationMongoId, complete: true, skipped: "postgres_disabled", sources: empty });
      continue;
    }
    let result: ProposalArtifactPurgeResult;
    try {
      result = await purgeOne(proposalMongoId, organizationMongoId, options);
    } catch (error) {
      // A transaction failed. Whatever step 1 committed is still there for the
      // next call; the count of sources left is not known from here.
      result = { proposalMongoId, organizationMongoId, complete: false, sources: empty, errorCode: errorCodeOf(error) };
    }
    results.push(result);
    if (result.complete) {
      safeLog("info", "proposal_artifacts_purged", { outcome: "success", count: result.sources.tombstoned });
    } else {
      // Loud, and with the error code. The caller may delete the proposal from
      // Mongo regardless, after which only this line and the returned result
      // say that source rows are still `deletion_pending`.
      safeLog("error", "proposal_artifacts_purge_failed", {
        outcome: "failure",
        errorCode: result.errorCode ?? "UNKNOWN",
        count: result.sources.pending + result.sources.notDeletable,
      });
    }
  }
  return results;
};

// Re-exported here because the daily archive job may import from this module
// only (tests/organization-block-guard.test.js pins its imports).
export { finishStrandedProposalPurges } from "./finishStrandedProposalPurges";
export type { StrandedPurgeRun } from "./finishStrandedProposalPurges";
