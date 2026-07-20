# Slice 3A Test-Environment Evidence

**Date:** July 20, 2026  
**Status:** Automated and authenticated manual test evidence complete; formal DXG acceptance pending

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

DXG completed the authenticated browser scenarios in [the manual test guide](../testing/SLICE_3A_MANUAL_TEST_GUIDE.md) on July 20, 2026 and reported that manual testing passed. This closes the remaining test checkpoint. Formal Slice 3A acceptance remains pending.

Live-provider or confidential-data AI processing, AI-generated clarification questions, DXG knowledge or pricing retrieval, investment guidance, generated-prose application, automatic proposal mutation or publication, production provisioning, and external telemetry or alerts remain gated.
