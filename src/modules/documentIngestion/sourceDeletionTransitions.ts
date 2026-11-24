import type { PoolClient } from "pg";

// The one place that walks a document source to its tombstone.
//
// rfpilot.enforce_document_source_transition (migration 003) allows `deleted`
// only from `deletion_pending`, and `deletion_pending` only from
// pending_upload, uploaded, scan_failed, ready and blocked. An UPDATE that
// jumps straight to `deleted` raises and rolls its whole transaction back,
// which is how permanent delete removed files from storage while every row
// stayed `ready`. tests/document-source-tombstone-guard.test.js fails when a
// new statement writes status='deleted' outside this file.
//
// Both functions run inside the caller's transaction, after the caller has set
// the tenant GUCs: row-level security scopes every statement here.

/** Statuses the trigger lets move to `deletion_pending` in one step. */
const DIRECTLY_DELETABLE = ["pending_upload", "uploaded", "scan_failed", "ready", "blocked"];

export type DeletionPendingOutcome = {
  /** Now `deletion_pending` (including rows that already were). */
  pending: string[];
  /** Live rows the trigger gives no way out of (`expired`). Left untouched. */
  notDeletable: string[];
};

/**
 * Moves live sources to `deletion_pending` and locks them.
 *
 * A source being scanned cannot go there directly. The trigger does allow
 * scanning -> scan_failed -> deletion_pending, and that is what an abandoned
 * scan is: finishScan() ignores a source that is no longer `scanning`, so a
 * scan still in flight ends without writing anything. Without this step a
 * source whose scan was interrupted could never be deleted, because
 * beginScan() refuses a `scanning` source too.
 */
export const markSourcesDeletionPending = async (
  client: PoolClient,
  sourceIds: string[],
): Promise<DeletionPendingOutcome> => {
  if (!sourceIds.length) return { pending: [], notDeletable: [] };
  const locked = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM rfpilot.document_sources
      WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
      ORDER BY id FOR UPDATE`,
    [sourceIds],
  );
  const scanning = locked.rows.filter((row) => row.status === "scanning").map((row) => row.id);
  if (scanning.length) {
    await client.query(
      "UPDATE rfpilot.document_sources SET status='scan_failed',updated_at=now() WHERE id = ANY($1::uuid[]) AND status='scanning'",
      [scanning],
    );
  }
  const movable = locked.rows
    .filter((row) => row.status === "scanning" || DIRECTLY_DELETABLE.includes(row.status))
    .map((row) => row.id);
  if (movable.length) {
    await client.query(
      "UPDATE rfpilot.document_sources SET status='deletion_pending',updated_at=now() WHERE id = ANY($1::uuid[]) AND status = ANY($2::text[])",
      [movable, DIRECTLY_DELETABLE],
    );
  }
  const alreadyPending = locked.rows.filter((row) => row.status === "deletion_pending").map((row) => row.id);
  const pending = [...movable, ...alreadyPending];
  return {
    pending,
    notDeletable: locked.rows.filter((row) => !pending.includes(row.id)).map((row) => row.id),
  };
};

/**
 * Tombstones sources that are `deletion_pending`. Call it only once the
 * source's object is gone from storage. Returns the ids it tombstoned; a
 * source in any other status is left alone.
 */
export const markSourcesDeleted = async (client: PoolClient, sourceIds: string[]): Promise<string[]> => {
  if (!sourceIds.length) return [];
  const result = await client.query<{ id: string }>(
    `UPDATE rfpilot.document_sources
        SET status='deleted',deleted_at=now(),updated_at=now()
      WHERE id = ANY($1::uuid[]) AND status='deletion_pending' AND deleted_at IS NULL
      RETURNING id`,
    [sourceIds],
  );
  return result.rows.map((row) => row.id);
};
