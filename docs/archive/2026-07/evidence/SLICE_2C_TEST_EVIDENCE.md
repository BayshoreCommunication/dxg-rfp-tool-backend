# Slice 2C Test-Environment Evidence

**Date:** 2026-07-20  
**Environment:** Isolated local test services  
**Provider:** `mock/deterministic-v1`  
**Proposal mutation:** disabled

## Manual acceptance

DXG completed the admin review, same-admin submission/approval, and knowledge-retrieval test workflow and reported the test complete. Slice 2C is ready for client acceptance; the separately gated boundaries below remain unchanged.

## Migration and extension

- PostgreSQL migration `008_knowledge_retrieval`: applied.
- `pgvector` installed version: `0.8.2`.
- PostgreSQL remains authoritative for release, index, query, result, and audit state.

## Durable indexing

- Outbox payload used `jobType=knowledge_index_release` with references only.
- Updated dispatcher and worker processed the indexing job.
- Final durable job status: `succeeded`.
- Final progress stage: `completed`.
- Safe error code: none.

A stale pre-Slice-2C worker initially interpreted the new job as a security scan and failed with `SOURCE_NOT_FOUND`. Restarting the worker on the approved code resolved the condition. The runbook now explicitly requires worker restart when introducing a new job type.

## Retrieval E2E

```json
{
  "releaseId": "019f7a13-f67c-768f-9750-fe1343b60566",
  "indexedFragmentCount": 3,
  "queryId": "019f7df8-33b0-778b-972f-ddbec9d260f5",
  "resultCount": 1,
  "citationsValid": true,
  "queryTimeEligibilityEnforced": true,
  "provider": "mock/deterministic-v1",
  "proposalMutation": false
}
```

The test release is synthetic. DXG-internal releases remain lexical-only; confidential, pricing, and contract semantic indexing remain blocked.

## Tenant RLS evidence

The configured test connection is a PostgreSQL superuser and therefore cannot provide meaningful RLS evidence. A no-login `NOSUPERUSER NOBYPASSRLS` verifier role was used under `SET LOCAL ROLE`:

```json
{
  "ownTenantRows": 3,
  "crossTenantRows": 0,
  "rlsEnforced": true
}
```

This verifier role is test-only and has no login credentials.

## Automated quality gate

`npm run ci` passed:

- contract generation check;
- ESLint with zero warnings;
- TypeScript type check;
- migration command checks;
- 190 tests passed, 0 failed;
- production build completed.

Six Slice 2C-specific unit/security tests cover deterministic vectors, approved fixtures and filters, idempotency fingerprinting, relevance metrics, test-only fail-closed behavior, and migration/repository security boundaries.

## Remaining acceptance boundaries

- Results prove architecture and synthetic execution, not real-world semantic quality.
- Recall@10 and MRR@10 require a client-agreed labeled fixture set before they can be treated as meaningful acceptance metrics.
- Live providers, confidential embeddings, pricing/contract semantic indexing, drafting, proposal auto-application, production, and external telemetry remain unauthorized.
