# DXG Approval Pack — Slice 2D Proposal Context and Requirement Extraction

## What this slice delivers

Slice 2D begins the **Provide Information** experience. It converts approved synthetic proposal information into a structured, cited candidate that a planner can review.

```text
Provide synthetic proposal information
        ↓
Durable extraction and validation
        ↓
Canonical candidate fields
        ↓
Missing/conflicting requirement issues
        ↓
Read-only planner review
```

It does not create the proposal draft, ask AI questions, provide investment guidance, change proposal data, call a live provider, or publish anything.

## Recommended defaults

- Isolated test environment only.
- `mock/deterministic-v1` with fixed synthetic fixtures.
- Existing private-ingestion and durable-job foundations.
- PostgreSQL stores candidate intelligence; MongoDB remains authoritative proposal content.
- Candidate operations use the canonical extraction-patch contract.
- Every suggested operation requires exact source evidence and checksum.
- Missing, conflicting, unsupported, or low-confidence data becomes an issue instead of a guess.
- No candidate apply endpoint and no MongoDB proposal mutation.
- Existing `/api/extract-proposal` compatibility endpoint is not used.
- Maximum 200 operations, 200 evidence records, and 100 issues.
- Test candidate retention is 30 days.

## What DXG can test

1. Start a context job for an owned proposal using an approved synthetic fixture.
2. See asynchronous job progress and safe recovery states.
3. Review extracted canonical fields with citations.
4. See missing/conflicting requirements as issues.
5. Confirm prompt injection and invalid output fail safely.
6. Confirm another user/organization cannot access the run.
7. Confirm the MongoDB proposal remains unchanged.

## Decisions requested

Please confirm:

1. Slice 2D should cover structured context/requirement extraction before drafting.
2. Mock provider and synthetic fixtures only are acceptable initially.
3. No candidate application or MongoDB proposal mutation is authorized.
4. The canonical proposal extraction-patch contract is the approved output boundary.
5. Every suggested field must have source evidence.
6. A 30-day test retention period is acceptable.
7. The legacy direct live-model extraction endpoint remains outside this slice.

## Approval statement

> DXG approves the Slice 2D proposal-context and requirement-extraction design and authorizes isolated test-environment implementation using the defaults in this approval pack. Execution must use the provider-neutral durable path, `mock/deterministic-v1`, fixed synthetic fixtures, canonical cited extraction patches, and content-free telemetry. PostgreSQL stores immutable candidate intelligence and references while MongoDB remains authoritative for proposal content. Candidate application, proposal mutation, AI drafting, DXG knowledge retrieval during extraction, clarification questions, investment guidance, live-provider or confidential-data processing, production provisioning, and external telemetry or alerts remain separately gated.

## After approval

Implementation proceeds through migration/policy, durable execution, canonical/evidence validation, read APIs, feature-flagged dashboard review, and test-evidence milestones. No implementation begins until this statement is approved.

