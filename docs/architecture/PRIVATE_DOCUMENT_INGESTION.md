# Private document ingestion

Slice 1D provides the quarantine and safety boundary for future document processing. It does not parse documents or call an AI provider.

## Lifecycle

`pending_upload → uploaded → scanning → ready` is the successful path. Infected scans become `blocked`; scanner errors become `scan_failed` and may be retried. Deletion uses `deletion_pending → deleted` and fails when retention or legal hold applies. PostgreSQL enforces allowed state transitions. Only `ready` is eligible for a later parsing workflow.

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

