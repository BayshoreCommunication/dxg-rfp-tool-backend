# Slice 2C Knowledge Retrieval — Test Runbook

## Boundary

This runbook is for the isolated test environment only. Slice 2C permits deterministic mock embeddings for synthetic releases and lexical retrieval for currently eligible DXG-internal releases. It does not authorize live-provider calls, confidential semantic indexing, proposal drafting, proposal mutation, or production use.

## Required services

- PostgreSQL 16 with `pgvector` 0.8.2 or later compatible version.
- Redis 7.
- Backend API, durable dispatcher, and source-security/deterministic worker.
- PostgreSQL migrations through `008_knowledge_retrieval`.

For a reproducible replacement test container, prefer an official pgvector PostgreSQL 16 image rather than installing the extension into a running vanilla PostgreSQL container. Preserve/export the existing test data before replacing any container.

## Configuration

Add these variables to the backend `.env`:

```env
NODE_ENV=test
POSTGRES_FOUNDATION_ENABLED=true
DURABLE_JOBS_ENABLED=true
KNOWLEDGE_RETRIEVAL_ENABLED=true
KNOWLEDGE_RETRIEVAL_MODE=hybrid
KNOWLEDGE_EMBEDDING_PROVIDER=mock
KNOWLEDGE_EMBEDDING_MODEL=deterministic-v1
KNOWLEDGE_RETRIEVAL_MAX_RESULTS=20
KNOWLEDGE_RETRIEVAL_QUERY_TIMEOUT_MS=500
```

Keep retrieval disabled outside the approved test environment.

## Provision and migrate

Verify extension availability:

```sql
SELECT name, default_version, installed_version
FROM pg_available_extensions
WHERE name = 'vector';
```

Apply and verify migrations:

```bash
npm run migrate:postgres -- up
npm run migrate:postgres -- status
```

The status must show `008_knowledge_retrieval` as applied.

## Start durable processing

Run in separate terminals:

```bash
npm run worker:source-security
npm run worker:dispatcher
```

Workers must be restarted after deploying a new job type. A stale worker predating Slice 2C will not understand `knowledge_index_release`.

## Run verification

An approved active synthetic release is required.

```bash
NODE_ENV=test \
KNOWLEDGE_RETRIEVAL_ENABLED=true \
KNOWLEDGE_EMBEDDING_PROVIDER=mock \
npm run verify:knowledge-retrieval
```

Expected evidence includes:

- indexed fragment count;
- query ID and result count;
- valid checksum-backed citations;
- query-time eligibility enforcement;
- `mock/deterministic-v1` provider;
- no proposal mutation.

## API checks

1. `POST /api/v1/knowledge/releases/{releaseId}/index-jobs` with `knowledge:approve` and `Idempotency-Key`.
2. Poll `/api/v1/jobs/{jobId}` until `succeeded`.
3. Read `/api/v1/knowledge/releases/{releaseId}/index-status` with `knowledge:read`.
4. `POST /api/v1/knowledge/retrieval/queries` using an allowlisted fixture and a new `Idempotency-Key`.
5. Confirm each result has `documentId`, checksum, and source coordinates.

## Recovery

- If the worker reports `SOURCE_NOT_FOUND` for a retrieval index job, stop stale workers and restart the updated worker.
- Retry failed/dead-letter jobs through the existing authorized recovery endpoint with an operator reason.
- If an index run fails, the release remains approved but no vector result is authorized by that failed index.
- Revoked, expired, or superseded releases are excluded at query time regardless of cleanup state.
- If `pgvector` is missing, stop; do not silently downgrade an approved hybrid policy.

## Security checks

- Run RLS evidence with a non-superuser, non-`BYPASSRLS` role. Superuser results are not valid RLS evidence.
- Inspect Redis/outbox payloads to confirm they contain only job, organization, actor, release, version, correlation, and trace references.
- Confirm logs and traces contain no query text, fragments, vectors, coordinates, private object keys, or storage URLs.

## Quality gate

```bash
npm run ci
```

Do not accept Slice 2C if migration, RLS, citation, revocation, deterministic mock, durable lifecycle, or CI evidence fails.

