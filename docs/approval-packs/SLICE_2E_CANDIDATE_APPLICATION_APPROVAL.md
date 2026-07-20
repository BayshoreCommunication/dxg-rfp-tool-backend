# DXG Approval Pack — Slice 2E Human Review and Controlled Candidate Application

## What this slice would deliver

Slice 2E would let a proposal owner review AI-extracted suggestions and explicitly apply selected, validated values to a draft proposal.

```text
Review cited suggestions
        ↓
Accept, edit, reject, or leave pending
        ↓
Select accepted fields
        ↓
Confirm any overwrite
        ↓
Apply once to the current draft version
```

The AI never decides what to apply. There is no automatic apply or “accept all.”

## Important correction

The current synthetic extraction uses several legacy field names. Before any proposal change, Slice 2E will normalize them to the canonical Proposal V1 contract and validate both path and value. A deny-by-default adapter will then map approved canonical fields to the existing MongoDB proposal fields.

This correction is mandatory. Current Slice 2D candidate paths will not be directly applied.

## Recommended defaults

- Isolated test environment only.
- Proposal owner only.
- Draft/unsubmitted, active, non-archived proposals only.
- Review decisions can be saved at any time; pending/rejected candidates do not block selected accepted candidates.
- Rejection reason is optional.
- No bulk accept; select each field explicitly.
- Existing non-empty values require explicit overwrite confirmation.
- First release supports only event name, event format, event objectives, and room count.
- Atomic Mongo update with expected proposal version and exactly one version increment.
- PostgreSQL stores review/application intelligence and audit references; MongoDB remains authoritative proposal content.
- Durable reference-only application job with idempotency and cross-store reconciliation.
- No automatic rollback; normal manual editing remains available.

## What DXG will be able to test

1. Accept, edit, reject, and leave individual suggestions pending.
2. Apply only selected accepted/edited fields.
3. Confirm citations and original suggestions remain unchanged.
4. See a safe conflict when the proposal changed after extraction.
5. Confirm the same application cannot run twice.
6. Confirm another planner cannot review or apply.
7. Confirm submitted/archived proposals cannot be changed.
8. Confirm no drafting, knowledge retrieval, live provider, publication, or external telemetry occurs.

## Decisions requested

Please confirm:

1. Controlled proposal mutation is authorized in the isolated test environment.
2. Proposal owner only and draft/unsubmitted only are acceptable initial restrictions.
3. No automatic or bulk candidate application is allowed.
4. Optional rejection reason is acceptable.
5. Existing non-empty values require explicit overwrite confirmation.
6. Initial support is limited to the four approved normalized fields.
7. Proposal versioning, Mongo idempotency marker, durable job, and reconciliation are approved.
8. One-year test retention for application audit metadata is acceptable.

## Approval statement

> DXG approves the Slice 2E human-review and controlled-candidate-application design and authorizes isolated test-environment implementation using the defaults in this approval pack. Only the authenticated owner may explicitly apply individually selected accepted or modified candidates to an active draft/unsubmitted proposal. Implementation must normalize legacy-shaped Slice 2D candidates to the canonical Proposal V1 contract, validate values, require overwrite confirmation for existing values, enforce optimistic proposal versioning, and apply through a deny-by-default canonical-to-Mongo adapter. MongoDB remains authoritative for proposal content; PostgreSQL stores review/application records and references; Redis carries reference-only durable jobs. Automatic or bulk application, submitted/published proposal mutation, AI drafting, DXG knowledge retrieval during extraction or application, clarification questions, investment guidance, live-provider or confidential-data processing, production provisioning, and external telemetry or alerts remain separately gated.

## After approval

Implementation proceeds milestone by milestone: contract correction, migration/RLS, atomic mutation adapter, durable APIs, dashboard review UI, and acceptance evidence. No implementation begins before this approval statement is received.
