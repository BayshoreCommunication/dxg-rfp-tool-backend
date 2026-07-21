# Slice 3B Manual Test Guide

## Setup

1. Back up the test databases, then run `npm run migrate:postgres -- up` in the backend.
2. Keep the existing `OPENAI_API_KEY` only in the backend environment. Add the settings below and restart the API, dispatcher, source-security worker, and dashboard:

```text
NODE_ENV=test
PROPOSAL_CONTEXT_ENABLED=true
PROPOSAL_DRAFT_ENABLED=true
LIVE_AI_PILOT_ENABLED=true
LIVE_AI_PROVIDER=openai
LIVE_AI_MODEL=gpt-5.4-mini
LIVE_AI_SYNTHETIC_ENABLED=true
LIVE_AI_NON_CONFIDENTIAL_ENABLED=true
LIVE_AI_KILL_SWITCH=false
LIVE_AI_INPUT_TOKEN_LIMIT=32000
LIVE_AI_OUTPUT_TOKEN_LIMIT=4000
```

## Authenticated planner checks

1. Open an owned, active, unsubmitted draft in the five-step workflow.
2. In step 2 choose **Detailed conference**, click **Extract with OpenAI**, and wait for success.
3. Confirm each candidate shows one or more citations. Confirm the run reports provider `openai`, model `gpt-5.4-mini`, and input/output usage when inspected through the API.
4. Review candidates. Do not apply them for the read-only boundary test.
5. Click **Draft with OpenAI**. Confirm every factual paragraph has canonical-path evidence and the persistent label says the candidate is read-only.
6. Reload the page and confirm both completed results recover from durable PostgreSQL state.
7. Snapshot the MongoDB proposal before and after both generations. Confirm content, version, lifecycle, and publication state are identical.

## Failure and isolation checks

1. Set `LIVE_AI_KILL_SWITCH=true`, restart the worker, and start a new live run. Confirm it fails with `LIVE_AI_KILLED` before a provider request. Restore it to `false` afterward.
2. Set `LIVE_AI_SYNTHETIC_ENABLED=false`; confirm live extraction is denied. Set `LIVE_AI_NON_CONFIDENTIAL_ENABLED=false`; confirm live drafting is denied.
3. Change the proposal after queuing a live draft. Confirm the job fails with `PROPOSAL_VERSION_CONFLICT` and produces no candidate.
4. Sign in as a different user or tenant and request the run IDs directly. Confirm both return not found.
5. Temporarily use an invalid provider key in an isolated worker. Confirm the job fails safely without prompt/evidence/output appearing in logs.
6. In the admin dashboard confirm the readiness card shows only provider/model, credential presence, flags, kill-switch state, token ceilings, and immutable read-only boundaries.

## Automated verification

Run `npm run ci` in the backend and dashboard, then `npm run lint && npm run type-check && npm run build` in the admin repository.
