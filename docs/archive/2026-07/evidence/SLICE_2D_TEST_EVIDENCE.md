# Slice 2D Test-Environment Evidence

**Date:** 2026-07-20  
**Environment:** Isolated local test services  
**Provider:** `mock/deterministic-v1`  
**Proposal mutation:** disabled

## DXG acceptance

DXG formally accepted the Slice 2D implementation and isolated test-environment evidence on 2026-07-20:

> DXG accepts the Slice 2D proposal-context and requirement-extraction implementation and its isolated test-environment evidence. DXG confirms that canonical cited suggestions, missing-requirement reporting, proposal-owner isolation, durable recovery, and the no-proposal-mutation boundary operate as approved. This acceptance does not authorize candidate application, proposal mutation, AI drafting, DXG knowledge retrieval during extraction, clarification questions, investment guidance, live-provider or confidential-data processing, production provisioning, or external telemetry and alerts.

This acceptance closes Slice 2D. All separately gated capabilities remain unauthorized until a later design approval explicitly authorizes them.

## Manual acceptance result

DXG completed the Slice 2D manual test workflow and reported that all tests passed.

Verified through the dashboard:

- the detailed synthetic fixture produced four canonical suggestions;
- every displayed suggestion included a citation and confidence;
- missing show end time appeared as a question rather than an invented value;
- the simple synthetic fixture completed successfully;
- proposal fields remained unchanged after extraction and refresh;
- queued-job recovery completed after worker restart; and
- a different planner could not access the proposal extraction result.

The test confirms the approved synthetic, read-only Slice 2D boundary. It does not demonstrate real-document or live-provider extraction quality.

## Implemented boundary

- Migration `009_proposal_context` is applied.
- PostgreSQL stores tenant-scoped runs, cited candidate operations, evidence, and issues.
- MongoDB remains authoritative; the Slice 2D repository has no MongoDB/Mongoose dependency.
- Redis carries reference-only messages through the durable dispatcher, lease, heartbeat, and completion path.
- Create/read endpoints require authentication, permission, tenant scope, and proposal ownership.
- Execution is test-only and requires the mock provider and explicit feature flag.

## Durable end-to-end result

```json
{
  "runId": "019f7e39-7f34-7091-b415-6a57c06e7de1",
  "jobId": "019f7e39-7f34-7091-b415-653d44faafdf",
  "status": "succeeded",
  "operationCount": 2,
  "evidenceCount": 2,
  "issueCount": 0,
  "canonicalPaths": true,
  "citationsPresent": true,
  "provider": "mock/deterministic-v1",
  "proposalMutation": false
}
```

An older running worker initially consumed the new job as a document scan and failed safely with `SOURCE_NOT_FOUND`. Restarting on the Slice 2D code resolved it; the runbook now requires worker restart for new job types.

## Automated evidence

Six Slice 2D tests cover fixture allowlisting/private-source rejection, canonical paths, required evidence, prompt-injection suppression, invalid-output rejection, production fail-closed behavior, forced RLS, immutable evidence, and absence of a proposal mutation path.

Backend `npm run ci` passed: contracts, zero-warning lint, TypeScript, migration checks, 197 tests, and production build. Dashboard TypeScript passed; lint has no errors (22 pre-existing warnings).

## Separately gated

Candidate application, proposal mutation, drafting, knowledge retrieval during extraction, clarification questions, investment guidance, live-provider/confidential processing, production, and external telemetry/alerts remain disabled and unimplemented.
