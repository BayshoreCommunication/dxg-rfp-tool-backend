# RFPilot AI Intelligence Layer

## Milestone 1 — Slice 1F Provider-Neutral AI Gateway Status

**Status date:** July 19, 2026  
**Implementation state:** Accepted by DXG as the provider-neutral AI gateway foundation on July 19, 2026  
**Authorized boundary:** Test environment, deterministic mock provider, fixed synthetic fixtures only

## Delivered

- Provider-neutral gateway port with a deterministic, offline mock adapter.
- Deny-by-default test policy restricted to `mock/deterministic-v1`, `contract_test`, `synthetic`, and non-production execution.
- Fixed fixture allowlist; the API cannot accept arbitrary fixture/document content.
- Immutable seeded policy, prompt, and JSON Schema releases with SHA-256 checksums.
- Schema, output-size, and evidence-citation validation before success.
- PostgreSQL run, attempt, validation, request-reference, budget-account, and append-only ledger records.
- Atomic USD 1.00-equivalent per-run reservation, USD 10 daily and USD 100 monthly test limits, and two-run concurrency limit.
- Idempotent run and durable-job creation with conflict detection.
- Tenant RLS and safe audit metadata.
- Slice 1E integration using PostgreSQL job state, transactional outbox, Redis reference-only messages, and a dedicated bounded-concurrency worker.
- Administrative APIs for test-run submission and safe run/policy/prompt/schema/budget metadata.
- Production, non-synthetic processing, live providers, fallback, credentials/spend, and proposal auto-application remain technically and procedurally disabled.

## Evidence

| Check | Result |
|---|---|
| Full repository CI | Passed: contracts, zero-warning lint, TypeScript, migration command checks, 165 tests, production build |
| Migration lifecycle | PostgreSQL 16 apply, rollback, and reapply passed |
| Durable execution | Job/request → outbox → Redis → worker → mock gateway → succeeded run/job passed |
| Reference-only queue | Queue message carried IDs/type/version/correlation only; no fixture or proposal body |
| Idempotency | Same request returned the same run; changed input with the same key returned `IDEMPOTENCY_CONFLICT` |
| Output validation | Valid fixture succeeded; invalid structured output was rejected |
| Classification gate | `customer_confidential` was denied before provider execution |
| Tenant isolation | A second PostgreSQL tenant saw zero runs from the test tenant |
| Ledger integrity | Budget-ledger update was rejected as append-only |
| Provider/network gate | Only deterministic mock code exists; no credential, provider SDK call, or network endpoint is used |
| Cleanup | Temporary PostgreSQL and Redis verification containers were removed |

The workspace `.env` does not currently contain `POSTGRES_URL`/`POSTGRES_MIGRATION_URL`, so migration `005_ai_gateway` was verified against an isolated temporary PostgreSQL test database rather than applied to a shared DXG environment.

## Test-environment activation

1. Configure the approved test PostgreSQL and Redis values.
2. Keep `NODE_ENV` non-production.
3. Apply migration `005_ai_gateway` with the migration-role connection.
4. Set `POSTGRES_FOUNDATION_ENABLED=true`, `DURABLE_JOBS_ENABLED=true`, and `AI_GATEWAY_ENABLED=true` for the approved test services only.
5. Start the dispatcher and `npm run worker:ai-gateway`.
6. Run authenticated API E2E with a `security:admin` user and fixed synthetic fixtures.

## Acceptance decision

> DXG accepts Slice 1F as the provider-neutral AI gateway foundation and confirms that it is directionally aligned with the target five-step proposal creation journey: Provide Information, Review the Draft, Answer Key Questions, See Guidance, and Publish. This acceptance does not represent delivery of the user-facing AI proposal workflow. Real-model processing, DXG knowledge retrieval, AI drafting, clarification questions, investment guidance, and redesigned frontend workflow remain separately gated future increments.

This decision accepts the Slice 1F foundation and its evidence. It does not authorize Slice 1G implementation, live-provider enablement, confidential-data processing, provider credentials/spend, production provisioning, or proposal auto-application.
