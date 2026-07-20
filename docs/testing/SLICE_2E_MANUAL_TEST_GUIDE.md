# Slice 2E Manual Test Guide

## Setup

Backend `.env.local`:

```env
NODE_ENV=test
PROPOSAL_CONTEXT_ENABLED=true
PROPOSAL_CONTEXT_PROVIDER=mock
CANDIDATE_APPLICATION_ENABLED=true
DURABLE_JOBS_ENABLED=true
```

Dashboard environment:

```env
NEXT_PUBLIC_PROPOSAL_CONTEXT_ENABLED=true
NEXT_PUBLIC_CANDIDATE_APPLICATION_ENABLED=true
```

Restart the API, worker, dispatcher, and dashboard after configuration changes.

```bash
npm run dev:proposal-context
npm run worker:source-security
npm run worker:dispatcher
```

## Required test proposal

Create a new proposal and save it as a draft. Slice 2E intentionally refuses submitted, reviewed, approved, rejected, or archived proposals. The legacy `isActive` field is not used because ordinary unpublished drafts have it set to false.

## Main test

1. Open the active draft in edit mode.
2. Run **Detailed conference** extraction.
3. For the four suggestions, choose a mixture of Accept, Edit, Reject, and Pending.
4. For any existing value selected for application, check **Confirm overwrite**.
5. Select **Save review**. Refresh and confirm the decisions remain.
6. Select **Apply selected fields**.
7. Wait for the durable job to succeed, then refresh the proposal.

Expected:

- only accepted or edited fields changed;
- rejected and pending fields did not change;
- edited values are used instead of the original suggestion;
- the proposal version increments once;
- citations and original candidates remain unchanged;
- no proposal draft text is generated and nothing is published.

## Conflict test

1. Extract and save a review.
2. Change and save the proposal in another tab.
3. Attempt to apply the older review.

Expected: safe proposal-version conflict and no candidate mutation.

## Security tests

- Another planner cannot read the review or apply candidates.
- An existing value cannot be overwritten without confirmation.
- A submitted or inactive proposal cannot be changed.
- Retrying the same application does not increment the version twice.

## Evidence checklist

```text
Tester:
Date:
Draft proposal ID:
Context run ID:
Application job ID:
Application ID:
Previous version:
Resulting version:
Accepted field changed: Yes / No
Edited field changed: Yes / No
Rejected field unchanged: Yes / No
Pending field unchanged: Yes / No
Overwrite confirmation enforced: Yes / No
Stale-version conflict enforced: Yes / No
Owner isolation enforced: Yes / No
Duplicate application prevented: Yes / No
```
