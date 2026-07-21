# Slice 3B Test Evidence

**Date:** July 21, 2026
**Status:** Automated and authenticated live-provider manual verification complete

Implemented boundaries include OpenAI `gpt-5.4-mini` structured-output calls for cited extraction and cited read-only drafting, separate live endpoints, durable reference-only jobs, owner/tenant/version/lifecycle checks, PostgreSQL result authority, MongoDB non-mutation, token ceilings, rate limits, usage metadata, classification flags, and environment kill switches.

## Automated verification

- Backend `npm run ci`: passed (213 tests).
- Dashboard `npm run ci`: passed; 24 pre-existing lint warnings remain and there are no lint errors.
- Admin `npm run type-check`: passed. Repository-wide lint remains blocked by 14 pre-existing errors in unrelated auth/header/settings files.
- Live OpenAI cited extraction smoke check: passed with `gpt-5.4-mini`, 244 input tokens, 124 output tokens, two candidates, and valid citations.
- Live OpenAI cited drafting smoke check: passed with `gpt-5.4-mini`, 271 input tokens, 322 output tokens, four sections, and valid citations.
- PostgreSQL migration `013_live_ai_pilot` applied successfully; backend health reported migration `013`, test environment, and ready PostgreSQL/queue dependencies.

## Authenticated manual verification

DXG completed the authenticated scenarios in [the manual test guide](../testing/SLICE_3B_MANUAL_TEST_GUIDE.md) on July 21, 2026:

- cited OpenAI extraction succeeded with visible provider `openai`, model `gpt-5.4-mini`, input/output token usage, and at least one evidence reference per candidate;
- cited OpenAI read-only drafting succeeded with visible provider/model/token evidence and canonical-path citations on factual paragraphs;
- completed extraction and draft results recovered after a full page reload without a new provider request;
- the emergency kill switch failed a new extraction safely with `LIVE_AI_KILLED`, no run result, and an explicit no-provider-call message; restoring the switch and restarting one worker restored successful execution;
- a newly created second account could not open the first account's proposal URL and was redirected to its empty owner-scoped proposal list;
- a draft queued while the worker was stopped failed after the proposal version changed, producing no replacement AI draft; and
- the dashboard continued to label live results read-only with proposal mutation and automatic publication both disabled.

The deliberately small provider smoke checks and authenticated runs used synthetic/non-confidential test evidence. No automatic proposal mutation or publication path was introduced.
