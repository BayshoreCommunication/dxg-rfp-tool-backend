# DXG Approval Pack — Slice 2F Cited AI Draft Generation

## What this slice would deliver

Slice 2F would generate a read-only, section-based proposal draft from the current version of an owned draft proposal.

```text
Current structured proposal
        ↓
Durable deterministic drafting
        ↓
Cited draft sections and information gaps
        ↓
Human review only
```

It does not update proposal fields, publish, email, retrieve DXG knowledge, or call a live provider.

## Recommended defaults

- Isolated test environment only.
- `mock/deterministic-v1` and fixed synthetic fixtures.
- Authenticated proposal owner only.
- Unsubmitted, non-archived drafts only.
- Expected proposal version required.
- Seven approved section types.
- Every factual paragraph requires a canonical proposal-path citation.
- Missing facts become visible gaps.
- PostgreSQL stores immutable draft intelligence; MongoDB remains authoritative proposal content.
- Redis carries reference-only durable jobs.
- Maximum 10 sections, 30 paragraphs, 12,000 characters, and 100 citations.
- 30-day test retention.
- No free-form prompts and no apply/rewrite/publish endpoint.

## What DXG will be able to test

1. Generate a structured draft from a current owned proposal draft.
2. Review sections, citations, and missing-information gaps.
3. Confirm stale versions and submitted proposals fail safely.
4. Confirm another planner cannot access the draft.
5. Confirm refresh and worker recovery preserve the result.
6. Confirm MongoDB proposal content/version is unchanged.
7. Confirm no knowledge retrieval, live provider, publication, or external telemetry occurs.

## Decisions requested

Please confirm:

1. The seven proposed initial sections are acceptable.
2. Neutral RFP language is acceptable for initial drafts.
3. Every factual paragraph must have proposal-path evidence.
4. Missing information should appear as explicit gaps.
5. Old drafts may remain visible with a stale label.
6. A 30-day test retention period is acceptable.
7. No draft application, arbitrary prompt, or rewriting is included.

## Approval statement

> DXG formally accepts the Slice 2E human-review and controlled-candidate-application implementation and test-environment evidence. DXG also approves the Slice 2F cited AI proposal-draft-generation design and authorizes isolated test-environment implementation using the defaults in this approval pack. Execution must use the provider-neutral durable path, `mock/deterministic-v1`, fixed synthetic fixtures, current owner-scoped unsubmitted proposal versions, immutable cited draft sections, explicit information gaps, and content-free telemetry. PostgreSQL stores draft intelligence and references while MongoDB remains authoritative and unchanged. Draft application, proposal mutation from generated prose, arbitrary prompts, rewriting or tone adjustment, clarification questions, DXG knowledge or pricing retrieval during drafting, investment guidance, live-provider or confidential-data processing, publication, production provisioning, and external telemetry or alerts remain separately gated.

## After approval

Implementation proceeds through contract/validator, migration/RLS, canonical proposal reader, durable mock generation, APIs, dashboard review, and evidence milestones. No implementation begins until the approval statement is received.
