# Slice 2D Manual Test Guide

## Purpose

Use this guide to test the Slice 2D **Proposal Context and Requirement Extraction** feature in the isolated test environment.

This slice extracts structured, cited proposal information from approved synthetic examples. It must not update the proposal, draft proposal text, use DXG knowledge, or call a live AI provider.

## Expected user journey

```text
Open an existing proposal
        ↓
Choose a synthetic example
        ↓
Start AI requirement extraction
        ↓
Wait for the background job
        ↓
Review suggested information and citations
        ↓
Confirm the proposal was not changed
```

## 1. Prerequisites

Confirm these services are running:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

Expected containers include:

- `rfpilot-postgres-test`
- `rfpilot-redis-test`

MongoDB and the existing backend dependencies must also be available.

## 2. Backend configuration

In `dxg-rfp-tool-backend/.env.local`, confirm the existing test PostgreSQL values and add:

```env
NODE_ENV=test
POSTGRES_ENABLED=true
PROPOSAL_CONTEXT_ENABLED=true
PROPOSAL_CONTEXT_PROVIDER=mock
PROPOSAL_CONTEXT_MODEL=deterministic-v1
PROPOSAL_CONTEXT_RETENTION_DAYS=30
DURABLE_JOBS_ENABLED=true
REDIS_URL=redis://:rfpilot-redis-secret@127.0.0.1:56379
```

Do not add OpenAI or another live-provider credential for this test.

Apply and check the database migration:

```bash
cd /Users/swoptechnologies/Desktop/rfp/dxg-rfp-tool-backend
npm run migrate:postgres -- up
npm run migrate:postgres -- status
```

Expected result:

```text
009 proposal_context applied
```

## 3. Start backend processes

Use three terminal windows.

### Terminal 1 — API

```bash
cd /Users/swoptechnologies/Desktop/rfp/dxg-rfp-tool-backend
npm run dev:proposal-context
```

The regular `npm run dev` command deliberately sets `NODE_ENV=development`. Use the Slice 2D command above because this feature is authorized only when the backend process runs with `NODE_ENV=test`.

### Terminal 2 — durable worker

```bash
cd /Users/swoptechnologies/Desktop/rfp/dxg-rfp-tool-backend
npm run worker:source-security
```

Expected result:

```text
Source-security worker started
```

The worker name is historical. It now handles document scanning, knowledge jobs, and Slice 2D proposal-context jobs.

### Terminal 3 — dispatcher

```bash
cd /Users/swoptechnologies/Desktop/rfp/dxg-rfp-tool-backend
npm run worker:dispatcher
```

Restart both worker processes whenever code containing a new job type is pulled or changed.

## 4. Dashboard configuration

In `dxg-rfp-tool-dashboard/.env.local`, add:

```env
NEXT_PUBLIC_PROPOSAL_CONTEXT_ENABLED=true
BACKEND_URL=http://localhost:8000
```

Use the actual local backend port if it is not `8000`.

Restart the dashboard after changing environment variables:

```bash
cd /Users/swoptechnologies/Desktop/rfp/dxg-rfp-tool-dashboard
npm run dev
```

## 5. Automated smoke test

Run this before testing the UI:

```bash
cd /Users/swoptechnologies/Desktop/rfp/dxg-rfp-tool-backend

NODE_ENV=test \
PROPOSAL_CONTEXT_ENABLED=true \
PROPOSAL_CONTEXT_PROVIDER=mock \
DURABLE_JOBS_ENABLED=true \
REDIS_URL=redis://:rfpilot-redis-secret@127.0.0.1:56379 \
npm run verify:proposal-context
```

Expected output contains:

```json
{
  "status": "succeeded",
  "canonicalPaths": true,
  "citationsPresent": true,
  "provider": "mock/deterministic-v1",
  "proposalMutation": false
}
```

## 6. Main UI test

1. Sign in as a planner or organization administrator.
2. Open **Proposals**.
3. Open an existing proposal in edit mode.
4. Find **AI requirement extraction (test)**.
5. Select **Detailed conference**.
6. Select **Extract requirements**.
7. Wait for the displayed status to change:

```text
queued → running → succeeded
```

8. Review the suggested information.

Expected detailed-conference suggestions include:

- Event name: `Synthetic DXG Leadership Conference`
- Event format: `Hybrid`
- Event objectives
- Number of event rooms: `6`
- A question or warning for missing show end time
- Confidence and citation count for each suggestion

9. Confirm the message:

```text
Review only — no proposal fields were changed.
```

10. Refresh or reopen the proposal and verify its existing form fields were not overwritten.

## 7. Simple-example test

1. Select **Simple conference**.
2. Start extraction again.
3. Wait for `succeeded`.

Expected suggestions:

- Event name: `Synthetic DXG Conference`
- Event format: `In-Person`
- Two cited suggestions
- No proposal fields automatically changed

## 8. Access-control test

1. Sign in as another planner who does not own the proposal.
2. Try to open or extract context for the first planner's proposal.

Expected result:

- The proposal or context run is not available.
- No extracted information is displayed.
- The system does not reveal whether a cross-owner run exists.

## 9. Feature-flag test

Change the backend value:

```env
PROPOSAL_CONTEXT_ENABLED=false
```

Restart the backend and attempt extraction.

Expected result:

- The operation is safely rejected.
- No extraction job runs.
- No live-provider fallback occurs.

Restore the value to `true` after the test.

## 10. Recovery test

1. Stop the durable worker.
2. Start an extraction from the dashboard.
3. Confirm the job remains queued instead of losing the request.
4. Start the durable worker again.
5. If required, run the dispatcher again.

Expected result:

- The durable job resumes and reaches `succeeded`.
- The user does not need to re-enter proposal information.

## 11. Acceptance checklist

| Test | Expected | Pass/Fail |
|---|---|---|
| Migration 009 applied | Status is `applied` | |
| Automated smoke test | Job succeeds | |
| Detailed fixture | Four cited suggestions displayed | |
| Missing requirement | Missing show end time appears as an issue | |
| Simple fixture | Two cited suggestions displayed | |
| Proposal mutation | Existing proposal remains unchanged | |
| Provider boundary | `mock/deterministic-v1` only | |
| Owner isolation | Another planner cannot access the result | |
| Feature flag | Disabled state fails safely | |
| Worker recovery | Queued job completes after restart | |
| Accessibility | Keyboard can reach selector/button and status is announced | |

## 12. Record test evidence

Record the following after testing:

```text
Tester:
Date:
Environment:
Proposal ID:
Fixture tested:
Job ID:
Run ID:
Final status:
Proposal unchanged: Yes / No
All suggestions cited: Yes / No
Access-control test passed: Yes / No
Recovery test passed: Yes / No
Notes:
```

## Known boundaries

The following are intentionally unavailable in Slice 2D:

- real document or confidential-data AI processing;
- live AI-provider calls;
- DXG knowledge retrieval during extraction;
- applying suggestions to proposal fields;
- AI proposal drafting;
- clarification-question generation;
- investment guidance;
- publishing or production provisioning.

These unavailable capabilities are not test failures.
