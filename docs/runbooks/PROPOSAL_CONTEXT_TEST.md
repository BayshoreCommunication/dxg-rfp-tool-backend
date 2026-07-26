# Slice 2D Proposal Context Test Runbook

## Configure

Use only isolated test services and the mock provider:

```bash
export NODE_ENV=test
export PROPOSAL_CONTEXT_ENABLED=true
export PROPOSAL_CONTEXT_PROVIDER=mock
export DURABLE_JOBS_ENABLED=true
export REDIS_URL=redis://:rfpilot-redis-secret@127.0.0.1:56379
```

Set the existing test `POSTGRES_URL`/`POSTGRES_MIGRATION_URL`. Do not configure live-provider credentials. For the dashboard, set `NEXT_PUBLIC_PROPOSAL_CONTEXT_ENABLED=true` and point `BACKEND_URL` to the local backend.

## Start

```bash
npm run migrate:postgres -- up
npm run worker:source-security
npm run worker:dispatcher
```

Restart both processes after pulling code that introduces a new durable job type. An old worker fails closed but cannot route the new handler.

## Verify

```bash
NODE_ENV=test PROPOSAL_CONTEXT_ENABLED=true PROPOSAL_CONTEXT_PROVIDER=mock \
DURABLE_JOBS_ENABLED=true REDIS_URL=redis://:rfpilot-redis-secret@127.0.0.1:56379 \
npm run verify:proposal-context
```

Expected: `succeeded`, canonical paths and citations true, provider `mock/deterministic-v1`, and `proposalMutation: false`.

## Manual flow

1. Open an owned proposal in edit mode.
2. In **AI requirement extraction (test)**, select a synthetic example.
3. Choose **Extract requirements** and wait for `succeeded`.
4. Review suggested information, citations, and issues.
5. Confirm proposal fields and the MongoDB document are unchanged.
