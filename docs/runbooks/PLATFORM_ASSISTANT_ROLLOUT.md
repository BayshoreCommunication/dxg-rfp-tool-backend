# Platform AI Assistant Rollout

> Production runbook. Last updated: 2026-07-29. Operational owner role: Platform Operations. Approval owner role: Product Owner.

## Safety position

Deploy the code and migration with the Assistant disabled. Enabling a provider
or the dashboard launcher is a separate release action. Never place provider
credentials, safety secrets, or backend-only flags in a dashboard public
environment variable.

The approved baseline is `gpt-5.4-mini-2026-03-17`. The evaluated candidate
must not replace it until the Product Owner records an explicit approve/reject
decision.

Use [Platform Assistant environment setup](./PLATFORM_ASSISTANT_ENVIRONMENT.md)
for the exact backend/dashboard variables, migration commands, and senior
developer handoff.

## Required release record

Create a release record before changing any flag. Record:

| Field | Required value |
|---|---|
| Release owner | Named person on duty |
| Product approver | Named Product Owner |
| Application versions | Backend and dashboard commit SHAs |
| Schema version | Migrations `033_platform_assistant` through `043_assistant_retention_privacy` applied |
| Prompt version | Version in `src/modules/platformAssistant/prompt.ts` |
| Model | Exact dated model identifier |
| Knowledge release | Active eligible release/policy identifiers |
| Organization scope | Internal or explicitly approved organization IDs |
| Rollout stage | Off, internal, limited cohort, or wider |
| Monitoring window | Start/end and on-call owner |
| Rollback trigger | Threshold and decision owner |

## Pre-deployment checks

1. Run backend contracts, lint, type-check, unit/integration tests, migration
   up/down verification, and build.
2. Run dashboard contracts, lint, type-check, Jest, production build, and the
   authenticated Assistant browser flow.
3. Confirm the OpenAI key and `AI_SAFETY_IDENTIFIER_SECRET` are present only in
   the backend secret store.
4. Confirm `AI_SAFETY_IDENTIFIER_SECRET` contains at least 32 characters.
5. Confirm the baseline model and prompt passed the versioned evaluation gate.
6. Confirm PostgreSQL, Redis, and the active knowledge release are healthy.
7. Confirm `assistant:use` assignments match the approved roles.
8. Confirm `AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS` contains only the exact
   approved 24-character organization IDs. An empty or invalid production
   value must return `enabled: false`; use `*` only for an explicitly approved
   all-organization rollout.
9. Confirm the release record contains a named owner and rollback authority.
10. If product analytics is enabled, confirm
    `AI_ANALYTICS_PSEUDONYM_KEY` is a backend-only secret with at least 32
    characters and the analytics privacy-canary test is clean.
11. Confirm every knowledge/rule/price asset selected for the release is
    approved, active, effective, unexpired, has a named owner and source
    reference, and records the deployed application release as verified.
12. Confirm no required governed asset remains on the temporary
    `legacy-migration-035` marker or has an overdue review date.

## Deploy flags off

Use these safe values for the first production deployment:

```dotenv
AI_ASSISTANT_ENABLED=false
AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS=
AI_ASSISTANT_KILL_SWITCH=true
AI_ASSISTANT_ANALYTICS_ENABLED=false
NEXT_PUBLIC_AI_ASSISTANT_ENABLED=false
```

Apply migrations 026 through 036, deploy backend and dashboard, then verify normal
non-Assistant dashboard workflows before proceeding.

The complete Phase 18 release record, read-only readiness checker,
alert/support requirements, incident classification, weekly review template,
and current verdict are in
[AI Assistant controlled pilot](./AI_ASSISTANT_PILOT_RELEASE.md).

## Kill-switch test

Perform this test in staging before every production enablement:

1. Enable the environment/provider prerequisites.
2. Set `AI_ASSISTANT_ENABLED=true`.
3. Set `AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS` to the staging test
   organization's exact ID.
4. Keep `AI_ASSISTANT_KILL_SWITCH=true`.
5. Attempt a new message and verify a safe `AI_ASSISTANT_KILLED` response.
6. Verify no new billable `platform_assistant` provider attempt was started.
7. Verify existing thread history remains readable.
8. Set `AI_ASSISTANT_KILL_SWITCH=false`, restart/reload configuration as
   required, and complete one grounded smoke-test response.
9. Restore the intended release state and attach evidence to the release
   record.

## Staged enablement

### Stage 0 — Off

Keep all Assistant flags off. Validate migration, health, and unrelated
workflows.

### Stage 1 — Internal

Set `AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS` to the named internal
organization IDs. Verify:

- `/api/v1/assistant/access` returns `enabled: true` for the internal
  organization and `enabled: false` for an organization outside the cohort;
- launcher visibility and authorized bootstrap;
- one grounded platform question;
- one unsupported/out-of-scope question;
- stream interruption and retry;
- persisted private history;
- kill-switch recovery.

### Stage 2 — Limited organization cohort

Update `AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS` with the exact approved cohort
and record its membership. Do not use the global feature flag or `*` as a
limited-cohort mechanism. Hold the cohort constant through the monitoring
window.

### Stage 3 — Wider rollout

Expand only after the Product Owner accepts the monitored Stage 2 results.
Keep the same model/prompt versions during expansion unless a separate release
record approves a change.

Production parsing is fail-closed: an absent, malformed, mixed wildcard, or
partially invalid allowlist enables no organization. Test and staging retain
global-flag behavior when the allowlist is absent, but an explicitly configured
allowlist is enforced there as well.

## Smoke tests

For each enabled stage:

1. Open the dashboard helper from the sidebar.
2. Verify a user with `assistant:use` outside the cohort receives
   `enabled: false` and sees no launcher.
3. Ask how to create a proposal and verify an internal `/proposals` citation.
4. Ask for a platform-changing action and verify the Assistant explains its
   read-only boundary.
5. Start a new conversation, reload, and reopen history.
6. Verify a different user in the same organization cannot read the thread.
7. Trigger a bounded retry and verify one user message with distinct assistant
   attempts.
8. Close an active stream and verify terminal aborted/interrupted persistence.
9. Confirm the API key and prompts are absent from browser network payloads,
   HTML, logs, and client state.

## Monitoring

Review at least the following by stage and organization:

- request and completion counts;
- safe error rate by `code`;
- user/org rate-limit rejections;
- active-stream concurrency rejections;
- p50/p95 time to first token;
- p50/p95 completion latency;
- aborted and interrupted response rate;
- provider-attempt outcome, token usage, and conservative cost;
- citation/output-validation failures;
- retry rate and duplicate-idempotency conflicts;
- user feedback and support contacts.

Provider-attempt rows, assistant message terminal states, audit events, and
structured application logs are the durable evidence sources. Do not log
message bodies, prompt text, credentials, direct personal identifiers, or raw
safety identifiers in operational dashboards.

## Rollback triggers

Immediately stop new messages when any of these occurs:

- tenant or owner-isolation failure;
- credential/prompt leakage;
- fabricated actions or unsafe external links;
- repeated citation/output-validation failures;
- sustained provider or completion error rate above the release record;
- p95 latency or cost above the approved budget;
- rate/concurrency controls unavailable without an accepted fallback;
- Product Owner or on-call owner requests rollback.

## Rollback procedure

1. Set `AI_ASSISTANT_KILL_SWITCH=true`.
2. Set `NEXT_PUBLIC_AI_ASSISTANT_ENABLED=false` if the launcher must disappear.
3. Keep thread tables and history intact; do not roll back migration 026 during
   an operational incident.
4. Confirm new messages fail safely and no new provider attempt starts.
5. Preserve correlation IDs, attempt rows, audit events, and aggregate metrics.
6. Diagnose and remediate in staging.
7. Re-run the kill-switch and smoke tests before any re-enable.

Use migration rollback only for a separately approved schema rollback after
data-retention and recovery implications have been reviewed.
