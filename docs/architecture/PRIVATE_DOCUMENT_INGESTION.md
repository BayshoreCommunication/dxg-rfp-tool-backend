# Private document ingestion

Slice 1D provides the quarantine and safety boundary for future document processing. It does not parse documents or call an AI provider.

## Lifecycle

`pending_upload → uploaded → scanning → ready` is the successful path. Infected scans become `blocked`; scanner errors become `scan_failed` and may be retried. Deletion uses `deletion_pending → deleted` and fails when retention or legal hold applies. PostgreSQL enforces allowed state transitions. Only `ready` is eligible for a later parsing workflow.

### Deletion with the proposal (2026-11-24)

Permanently deleting a proposal, and the 30-day sweep of archived proposals,
run `purgeProposalArtifacts` for it.

**Before anything is removed the proposal is marked** (`purgeStarted` on the
MongoDB proposal). The planner's delete writes it under the same access policy
as the delete itself; the sweep writes it on proposals that are still archived.
It is never cleared. From that write on:

- restore answers `409 PROPOSAL_BEING_DELETED` ("This Proposal is being
  permanently deleted and can no longer be restored.");
- an edit (`PUT /api/proposals/:id`, status and metadata updates) no longer
  matches the proposal and answers 404, so it cannot be un-archived that way;
- the proposal still shows in its owner's archive, and can still be copied or
  saved as a template: both read only its MongoDB content and create a new,
  unmarked proposal with no source documents;
- a restore and the mark are each one conditional write on the same document,
  so exactly one of a racing restore and delete wins.

The marker lives in MongoDB because restore is a MongoDB write: the condition
and the write are atomic there. A check of the Postgres sources at restore time
would be a read in one store followed by a write in another, would pass when
Postgres is off or unreachable, and cannot tell a purge from a single document
its owner deleted.

Then, for every live source of the proposal:

1. the source is marked `deletion_pending` and that is committed. A source that
   is being scanned goes `scanning → scan_failed → deletion_pending`: the scan
   is abandoned, and `finishScan` ignores a source that is no longer `scanning`;
2. the object is deleted from private storage (an object that is already
   missing, `NoSuchKey`, counts as deleted);
3. the source is marked `deleted` with `deleted_at`. When no live source is
   left the proposal's conversation is archived and one
   `proposal_artifacts_purged` audit event is written, whose `count` is every
   tombstoned source of the proposal. This step takes a lock on the proposal
   reference, so two purges of one proposal cannot both write the event.

A source whose object could not be deleted stays `deletion_pending` and is not
tombstoned; the conversation is not archived and no audit event is written.
Running the purge again for the same proposal finishes it. The function
returns, per proposal, whether it completed.

- The 30-day sweep and `scripts/purgeOldProposals.ts` keep the MongoDB record
  of a proposal that did not complete, so their next run retries it.
- The planner's "permanently delete" always removes the proposal and answers
  200. If the purge did not complete it logs `proposal_artifacts_purge_failed`
  with an error code, and the daily job finishes it (below).
- A source under legal hold or unexpired `retention_until`, and a source in
  `expired` (the trigger has no transition out of it), is left untouched and
  reported as not completed.
- An organization that is in Postgres but not `active` is reported as not
  completed (`ORGANIZATION_INACTIVE`): its rows cannot be reached. Only
  "Postgres is off", "the organization is not in Postgres" and "no reference
  for this proposal" count as nothing to do. A reference filed under a
  different organization than MongoDB names cannot be seen under row-level
  security and reads as "no reference".
- `sourceDeletionTransitions.ts` is the shared way to a tombstone.
  `tests/document-source-tombstone-guard.test.js` pins every statement that
  writes a source's status and fails on a new one.

**Finishing a stranded purge.** The daily archive job (`purgeArchivedProposals`
in `utils/cronJobs.ts`, which has no separate switch) ends with
`finishStrandedProposalPurges`. It lists organizations from MongoDB, leaves out
blocked ones, and reads each organization in its own transaction under that
organization's row-level-security scope. Within an organization it takes
proposals that have a `deletion_pending` source not under hold or retention,
up to 200 per run (`PROPOSAL_PURGE_RECONCILE_BATCH`), oldest first, and asks
MongoDB about each:

| MongoDB says | What the pass does |
|---|---|
| the proposal carries `purgeStarted` | runs the whole purge again |
| the proposal no longer exists | finishes the sources that are already `deletion_pending`; marks nothing new |
| the proposal exists and is not marked | nothing: that pending document came from a single-document delete |

Nothing finishes a single-document delete (`DELETE /api/v1/sources/:id`) whose
storage step failed; the planner can repeat that delete.

Known limits, not addressed here: an upload link issued before the delete can
still be used to put an object back after the tombstone; object versions are
not removed if the bucket is versioned; a new upload session can still be
opened on a proposal that is being deleted (the next run purges it).

Before this fix the purge wrote `deleted` straight onto the row, which the
transition trigger rejects, after it had already deleted the object. Proposals
permanently deleted before the fix therefore have source rows still marked
`ready` (or whatever status they had) whose objects are gone, with no audit
event. Repairing those rows is a one-off that is not part of this change; the
daily pass does not pick them up, because they are not `deletion_pending`.

## Storage boundary

- The API creates `quarantine/<organization>/<source>/original.<extension>` server-side.
- The browser receives a short-lived, single-object signed PUT URL with content type and length signed.
- The adapter never adds a public ACL or returns a permanent object URL.
- Completion verifies exact size and content signature, then calculates SHA-256.
- Object keys and signed URLs must never be logged.

The legacy public proposal upload helper is intentionally separate and is not used here.

## Scanner boundary

The scanner port has a ClamAV INSTREAM adapter. Connection errors, timeouts, and invalid responses fail closed as `scan_failed`. The `test-signature` scanner is available only with `NODE_ENV=test` and recognizes the EICAR test signature.

## Data and isolation

Migration `003_private_document_ingestion` creates document source, object, and scan-result records. Every table contains `organization_id`, uses forced Row-Level Security, and is accessed after resolving the tenant inside a transaction. MongoDB remains authoritative for proposal content; PostgreSQL stores its reference and the ingestion lifecycle.

## API

- `POST /api/v1/proposals/:id/sources/upload-session`
- `POST /api/v1/sources/:sourceId/complete`
- `POST /api/v1/sources/:sourceId/scan`
- `GET /api/v1/sources/:sourceId`
- `GET /api/v1/proposals/:id/sources`
- `DELETE /api/v1/sources/:sourceId`

Upload creation requires `Idempotency-Key`. Every route requires a session-bound token and proposal permission. Scan requests are rate-limited.

## Configuration

```text
DOCUMENT_INGESTION_ENABLED=false
DOCUMENT_MAX_FILE_BYTES=52428800
DOCUMENT_UPLOAD_TTL_SECONDS=900
DOCUMENT_STORAGE_BUCKET=
DOCUMENT_STORAGE_REGION=
DOCUMENT_STORAGE_ENDPOINT=
DOCUMENT_STORAGE_KEY=
DOCUMENT_STORAGE_SECRET=
DOCUMENT_STORAGE_FORCE_PATH_STYLE=false
DOCUMENT_SCANNER_MODE=clamav
CLAMAV_HOST=127.0.0.1
CLAMAV_PORT=3310
CLAMAV_TIMEOUT_MS=15000
```

Keep the feature disabled until migration `003` is applied, the bucket is private, its identity is least-privileged, and scanner health is verified. Never use `test-signature` outside automated tests.

## Operating checks

1. Confirm public bucket/object access is denied.
2. Verify clean fixtures reach `ready` only after scanning.
3. Verify the EICAR security-test fixture becomes `blocked`.
4. Stop the scanner, verify `scan_failed`, restore it, and retry.
5. Verify cross-tenant reads return zero with the non-superuser role.
6. Reconcile pending uploads with storage and investigate orphans before deletion.

For an isolated local verification target, configure the named `rfpilot-private-test` bucket and run `npm run verify:document-ingestion`. The verifier refuses other bucket names and covers signed upload, anonymous denial, clean scan, EICAR block, scanner outage/retry, and deletion.
