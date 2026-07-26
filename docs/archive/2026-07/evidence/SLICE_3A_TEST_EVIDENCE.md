# Slice 3A Test-Environment Evidence

**Date:** July 20, 2026  
**Status:** Formally accepted by DXG

## Implemented boundary

- Additive migration `012_proposal_workflow` applied in the isolated PostgreSQL test environment.
- Tenant/owner-scoped workflow read model and current-step persistence.
- Exact five-step dashboard shell with backend-authoritative refresh recovery.
- Existing private ingestion, extraction/review/application and cited drafting components reused.
- Multiple private source records are listed with independent processing status.
- Existing detailed editor remains available; old panels remain available when the workflow flag is disabled.
- Guidance, generated questions, generated-prose mutation, live AI and automatic publication remain disabled.

## Authoritative repository verification

The workflow repository was executed against existing isolated test records and returned:

```json
{
  "step": 1,
  "steps": [
    "Provide Information",
    "Review the Draft",
    "Answer Key Questions",
    "See Guidance",
    "Publish"
  ],
  "boundaries": {
    "proposalAuthority": "mongodb",
    "aiRecords": "postgresql",
    "queue": "reference-only",
    "generatedProseMutation": false,
    "liveProvider": false
  }
}
```

## Automated quality gates

- Workflow policy tests: 4 passed.
- Backend CI: contracts, zero-warning scoped lint, type checking, migration checks, 211 tests and production build passed.
- Dashboard CI: lint completed with pre-existing warnings and no errors, type checking, 17 suites/199 tests and production build passed.
- PostgreSQL migration status reports `012_proposal_workflow` applied.

## Authenticated manual evidence

DXG completed the authenticated browser scenarios on July 20, 2026 and reported
that the five-step workflow, multi-source intake, controlled candidate
application, cited drafting, refresh recovery, and authorization boundaries
passed. This closed the remaining test checkpoint. The superseded procedural
guide was removed during the 2026-07 documentation consolidation.

## Formal acceptance

DXG formally accepted the Slice 3A implementation and isolated test-environment evidence on July 20, 2026. DXG confirmed that authoritative step recovery, private multi-source status, controlled candidate application, cited read-only drafting, manual editing, and the existing publication handoff operate as approved.

Live-provider or confidential-data AI processing, AI-generated clarification questions, DXG knowledge or pricing retrieval, investment guidance, generated-prose application, automatic proposal mutation or publication, production provisioning, and external telemetry or alerts remain gated.
