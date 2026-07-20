# Slice 2F Test-Environment Evidence

**Date:** 2026-07-20  
**Provider:** `mock/deterministic-v1`  
**Proposal mutation:** disabled

Migration `011_proposal_draft_generation` is applied. The initial deterministic verification produced:

```json
{
  "runId": "019f7ed4-68f3-76dc-a170-d3614a6a0a90",
  "status": "succeeded",
  "sections": 2,
  "gaps": 1,
  "citationsValid": true,
  "proposalVersionUnchanged": true,
  "proposalContentUnchanged": true,
  "proposalMutation": false,
  "provider": "mock/deterministic-v1"
}
```

Backend and dashboard TypeScript checks and production builds passed. At this initial checkpoint, durable UI, recovery, owner/lifecycle, stale-version, and regression evidence remained pending; the completed evidence and acceptance are recorded below.

## Durable dashboard verification

DXG generated and reviewed the Slice 2F draft in the dashboard. Authoritative records confirm:

```json
{
  "runId": "019f7ed8-4aca-73bf-aac1-fee82dbe1803",
  "jobId": "019f7ed8-4acb-70ad-b62e-9e25ee82534d",
  "runStatus": "succeeded",
  "jobStatus": "succeeded",
  "sectionCount": 2,
  "paragraphCount": 2,
  "citationCount": 3,
  "gapCount": 1,
  "expectedProposalVersion": 4,
  "safeErrorCode": null
}
```

Displayed output included Event Overview, Venue and Schedule Summary, canonical evidence paths, and a missing-event-objectives gap. PostgreSQL confirms the stored citations are canonical `/content/event/name`, `/content/event/format`, and `/content/venueSchedule/roomCount` paths.

## Recovery and safety verification

DXG refreshed the proposal editor and confirmed the same draft sections, citations, information gap, and succeeded state were restored.

```json
{
  "refreshRecovery": true,
  "staleVersionRejected": true,
  "ownerIsolation": true,
  "lifecycleStatus": "rejected",
  "lifecycleRejected": true,
  "proposalVersionUnchanged": true,
  "proposalContentUnchanged": true,
  "providerCallsOnRejectedRuns": 0
}
```

## Regression gates

- Backend CI passed: contracts, configured zero-warning lint, TypeScript, migration checks, 207 tests, and production build.
- Dashboard tests passed: 17 suites and 199 tests.
- Backend and dashboard production builds passed.

## Formal acceptance

DXG accepted Slice 2F on July 20, 2026. DXG confirmed that owner, version, and lifecycle controls, durable recovery, immutable cited sections, explicit information gaps, canonical proposal-path evidence, and the no-proposal-mutation boundary operate as approved.

Draft application, proposal mutation from generated prose, arbitrary prompts, rewriting, clarification questions, knowledge/pricing retrieval, investment guidance, live/confidential processing, publication, production, and external telemetry remain gated.
