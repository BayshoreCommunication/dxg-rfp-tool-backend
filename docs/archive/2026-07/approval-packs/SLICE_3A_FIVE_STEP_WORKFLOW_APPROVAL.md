# DXG Approval Pack — Slice 3A Five-Step Proposal Workflow

## What this slice will deliver

Slice 3A turns the accepted foundations into one simple proposal-creation workspace:

```text
Provide Information → Review the Draft → Answer Key Questions → See Guidance → Publish
```

Planners can create or resume a proposal, provide multiple sources, recover processing progress, review cited information, explicitly apply selected structured facts, view a cited read-only draft and gaps, edit all details manually, and hand off to the existing publication process.

## What this slice will not deliver

- No live AI model or confidential-data AI processing.
- No AI-generated questions beyond displaying existing deterministic gaps.
- No DXG knowledge or pricing retrieval.
- No investment guidance.
- No generated-prose application or automatic proposal mutation.
- No automatic publication or change to publication permissions.
- No production provisioning or external telemetry/alerts.

## Recommended defaults

- Isolated test environment and feature flag only.
- Exact five-step labels approved by DXG.
- MongoDB remains authoritative for proposal content and lifecycle.
- PostgreSQL stores workflow/source references and existing AI-domain records.
- Private object storage holds quarantined source bytes.
- Redis/BullMQ carries reference-only job messages.
- Existing Slice 2D–2F controls and deterministic mock execution remain unchanged.
- Upload, pasted notes through the private-source boundary, owned previous-proposal reference, and manual entry are the initial intake methods.
- Browser state is never authoritative; refresh restores state from backend records.
- The current detailed editor remains available for advanced users and rollback.

## What DXG will be able to test

1. Create and resume an assisted draft proposal.
2. Navigate the five-step workspace and understand available versus gated capabilities.
3. Attach multiple eligible sources and recover progress after refresh or worker restart.
4. Review citations and conflicts and explicitly apply selected structured facts.
5. Generate and recover a cited read-only draft without changing proposal prose.
6. Complete missing fields through the manual editor.
7. Reach the existing validation/publication handoff without automatic publication.
8. Confirm tenant, owner, lifecycle, version, accessibility, telemetry and regression boundaries.

## Decisions requested

Please confirm:

1. The five labels and order are acceptable.
2. Assisted and full manual modes should remain available together.
3. The four proposed intake methods are acceptable for the first increment.
4. Steps 3 and 4 should show only approved gaps/validation plus clear gated messaging.
5. Existing publication remains the only Step 5 execution path.
6. Implementation may proceed in the isolated test environment using the recommended defaults.

## Approval statement

> DXG approves the Slice 3A five-step proposal-workflow and multi-source-intake design and authorizes isolated test-environment implementation using the defaults in this approval pack. The workflow must reuse the accepted private-ingestion, durable-job, proposal-context extraction, controlled-candidate application, and cited read-only drafting boundaries. MongoDB remains authoritative for proposal content and lifecycle; PostgreSQL stores workflow/source references and AI-domain records; private object storage holds quarantined source bytes; Redis/BullMQ carries reference-only jobs. The existing manual editor and publication controls remain available. Live-provider or confidential-data AI processing, AI-generated clarification questions, DXG knowledge or pricing retrieval, investment guidance, generated-prose application, automatic proposal mutation or publication, production provisioning, and external telemetry or alerts remain separately gated.

## After approval

Implementation proceeds through shared contracts, additive persistence, the workflow read model, the feature-flagged five-step shell, multi-source intake, reuse of accepted review/draft components, guarded publication handoff, and test evidence. No implementation begins until DXG provides the approval statement.

Detailed design: [Five-Step Proposal Workflow](../architecture/FIVE_STEP_PROPOSAL_WORKFLOW.md).
