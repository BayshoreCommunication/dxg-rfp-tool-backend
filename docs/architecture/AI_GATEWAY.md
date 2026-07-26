# Provider-Neutral AI Gateway — Slice 1F

The gateway is the only approved entry point for future AI operations. Slice 1F runs only in a non-production environment with `AI_GATEWAY_ENABLED=true`, the deterministic `mock/deterministic-v1` adapter, purpose `contract_test`, classification `synthetic`, and seeded immutable policy/prompt/schema releases.

No provider credentials, network calls, confidential content, proposal updates, tools, browsing, code execution, or provider fallback are present in this increment. The API accepts only fixed fixture names (`basic`, `invalid_output`, and `prompt_injection`), never caller-supplied fixture content.

## Request path

`Authenticated security administrator → validation/rate limit → PostgreSQL job/request reference → outbox → Redis reference-only message → durable worker → tenant RLS → policy lookup → atomic budget reservation → mock adapter → schema/citation validation → usage reconciliation → safe run metadata`

All authorization and budget decisions occur before adapter execution. A provider-shaped success is recorded as successful only after output validation. Run, attempt, validation, ledger, and audit records contain controlled metadata; request fixture content is not persisted.

## Configuration

- `AI_GATEWAY_ENABLED=false` by default; set `true` only in the approved test environment.
- `DURABLE_JOBS_ENABLED=true`, `REDIS_URL`, and the AI gateway worker are required for test-run execution.
- `NODE_ENV=production` always denies execution.
- PostgreSQL foundation and migration `005_ai_gateway` are required.

## API

- `POST /api/v1/ai/test-runs` requires `security:admin` and `Idempotency-Key`.
- Metadata reads under `/api/v1/ai/{runs,policies,prompts,schemas,budgets}` require `security:admin`.

Live adapters and processing of any non-synthetic classification require a later written approval and policy migration.
