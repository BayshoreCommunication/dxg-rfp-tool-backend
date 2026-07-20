# Slice 3A Manual Test Guide

## Configuration

Backend `.env.local`:

```text
NODE_ENV=test
PROPOSAL_WORKFLOW_ENABLED=true
```

Dashboard `.env`:

```text
NEXT_PUBLIC_PROPOSAL_WORKFLOW_ENABLED=true
```

Keep the previously approved private-ingestion, durable-job, proposal-context and proposal-draft flags enabled. Run the API, dashboard, durable dispatcher, source-security worker and AI gateway worker used for Slice 2D–2F.

## Test

1. Sign in as a planner and open an owned, unsubmitted proposal for editing.
2. Confirm the five cards appear in this order: Provide Information, Review the Draft, Answer Key Questions, See Guidance, Publish.
3. Upload two clean synthetic files. Confirm each is independently processed and both appear under Attached sources.
4. Refresh. Confirm the same current step and attached-source list return.
5. Open Review the Draft. Extract, review and explicitly apply one structured candidate. Confirm no unselected field changes.
6. Generate the cited read-only draft. Confirm citations and gaps appear and proposal prose is not automatically applied.
7. Open Answer Key Questions. Confirm the screen explains existing gaps and does not generate conversational questions.
8. Open See Guidance. Confirm no price, equipment or investment recommendation is shown.
9. Open Publish. Confirm it hands the planner to existing detailed fields/publication controls and does not publish automatically.
10. Use Edit all details and confirm the existing editor remains usable.
11. Refresh on each step and confirm authoritative step recovery.
12. Attempt access as another planner or tenant. Confirm the workflow and sources return not found/denied.

## Expected result

The five-step experience organizes accepted capabilities while every retained gate remains enforced. Record screenshots of the five cards, multi-source status, recovered step, cited draft, gated Guidance and manual Publish handoff.
