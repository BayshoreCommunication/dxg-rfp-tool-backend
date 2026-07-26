# Durable jobs

Slice 1E adds PostgreSQL-authoritative background work delivered through Redis/BullMQ. Redis contains reference-only messages; it is not the source of truth.

## Processes

- API: creates an `ai_jobs` record and `job.queued` outbox event atomically, then returns `202`.
- Dispatcher: `npm run worker:dispatcher`; claims outbox events and reconciles queued PostgreSQL jobs with Redis.
- Source-security worker: `npm run worker:source-security`; runs only the allowlisted malware-scan handler.

All processes require `POSTGRES_FOUNDATION_ENABLED=true`, `DURABLE_JOBS_ENABLED=true`, `POSTGRES_URL`, and `REDIS_URL`. The worker also requires the private-storage and ClamAV settings documented in `PRIVATE_DOCUMENT_INGESTION.md`.

## Environment

```text
DURABLE_JOBS_ENABLED=false
REDIS_URL=rediss://user:password@private-host:6379
JOB_MAX_ATTEMPTS=5
JOB_BACKOFF_BASE_MS=5000
JOB_LEASE_SECONDS=90
SOURCE_SECURITY_CONCURRENCY=2
```

Production must use TLS/private networking and separate credentials. Never log `REDIS_URL`.

## Lifecycle and guarantees

PostgreSQL enforces `queued → running → succeeded|failed|retry_scheduled|cancelled|dead_letter`. Delivery is at least once. Stable PostgreSQL/BullMQ IDs, database leases, attempt records, idempotency keys, and idempotent document transitions make duplicate delivery safe. Completion checks cooperative cancellation before recording success.

The dispatcher republishes missing queued work. Failed/completed BullMQ entries are safely recreated only when PostgreSQL has been explicitly requeued. Queue messages include IDs, checksum/version, correlation ID, and organization/user references; they exclude documents, proposal bodies, prompts, signed URLs, tokens, and credentials.

## API

- `POST /api/v1/sources/:sourceId/scan-jobs` (`Idempotency-Key` required)
- `GET /api/v1/jobs`
- `GET /api/v1/jobs/:jobId`
- `POST /api/v1/jobs/:jobId/cancel`
- `POST /api/v1/admin/jobs/:jobId/retry` (security admin; reason required)
- `GET /api/v1/admin/queues/health`

## Operations

Monitor queue counts, oldest waiting age, outbox lag, retries, stalls, dead letters, Redis memory/evictions, and worker/dispatcher health. During Redis loss, keep PostgreSQL job/outbox records, restore Redis, start the dispatcher, and run reconciliation. Do not mark work successful from Redis alone.

For isolated real-service verification, run `npm run verify:durable-jobs` with the guarded local PostgreSQL, Redis, MinIO, and ClamAV configuration. It verifies idempotency, clean/EICAR processing, cancellation, Redis reconstruction, dead-lettering, and operator recovery.

