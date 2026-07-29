# AI Assistant controlled pilot and release readiness

Status: engineering preparation complete. No production deployment, flag
enablement, allowlist change, destructive retention execution, or model
promotion is authorized by this document.

## Current verdict

**CONDITIONAL GO** for a flags-off staging deployment and a named internal
pilot after the release record passes every automated and human gate below.

**NO-GO for production enablement** until a named release owner and Product
approver sign the record, exact organization IDs are approved, the model
decision is recorded, governed releases and provider terms are verified, an
approved retention policy exists, and staging smoke/kill-switch evidence and
alerts are attached.

Run the read-only checker against a copy of the template:

```sh
npm run release:assistant:check -- \
  --record=docs/templates/assistant-pilot-release-record.example.json
```

Use `--require-go` only in a controlled release pipeline. The repository
template intentionally returns `NO-GO`.

## Environment inventory

Backend secrets: `OPENAI_API_KEY`, `AI_SAFETY_IDENTIFIER_SECRET`,
`AI_ANALYTICS_PSEUDONYM_KEY`, database/Redis/Mongo credentials, JWT,
`BFF_SHARED_SECRET`, and telemetry secrets. They stay in the encrypted backend
secret store and never use a `NEXT_PUBLIC_` name.

Backend release controls: `AI_ENVIRONMENT`, `AI_ASSISTANT_ENABLED`,
`AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS`, `AI_ASSISTANT_KILL_SWITCH`,
`AI_ASSISTANT_MODEL`, `AI_ASSISTANT_ANALYTICS_ENABLED`, bounded token/latency/
rate settings, governed knowledge/pricing flags, and provider flags.

Retention execution remains separately disabled with
`AI_RETENTION_PURGE_ENABLED=false`,
`AI_RETENTION_POLICY_APPROVED=false`, and
`AI_RETENTION_PRODUCTION_EXECUTION_APPROVED=false`.

Dashboard visibility uses only `NEXT_PUBLIC_AI_ASSISTANT_ENABLED`; backend
authorization and the exact organization cohort remain authoritative. See
`PLATFORM_ASSISTANT_ENVIRONMENT.md` for the complete handoff.

## Migration order

1. Deploy application artifacts with Assistant flags off and kill switches on.
2. Back up/verify point-in-time recovery.
3. Run `npm run migrate:postgres -- status`.
4. Apply pending migrations in order, including `026_platform_assistant`
   through `036_assistant_retention_privacy`.
5. Run status again and verify every migration through `036` is applied.
6. Verify health, RLS, ordinary proposal workflows, and flags-off behavior.

Do not use schema rollback as an operational Assistant rollback.

## Organization allowlist

The Product approver supplies exact 24-character organization IDs. Security
reviews tenant ownership and the Release owner copies only those IDs into the
server-only allowlist. Empty, malformed, mixed-wildcard, or partially invalid
production values must fail closed. Use no wildcard for internal or limited
cohorts. Test one authorized and one unauthorized organization before each
cohort change and retain content-free evidence.

## Model decision

Keep the approved baseline unless the candidate is compared against the same
versioned fixture set, deterministic assertions, critical safety cases,
latency, and approved cost budgets. A human Product approver records
`baseline_approved`, `candidate_approved`, or `candidate_rejected`. A candidate
never promotes itself and a model change is not bundled silently with a
knowledge, prompt, or cohort change.

## Governed knowledge, rule, and price releases

Record exact release identifiers. Each must be approved, active, effective,
unexpired, owned, source-referenced, and verified for the deployed application
release. Block rollout for legacy migration markers, overdue reviews, revoked
assets, missing rates, unsupported currencies, or mismatched application
versions. Missing price data stays unavailable; it is never displayed as an
authoritative estimate.

## Smoke tests

Run signed-in tests in staging for:

1. authorized launcher and out-of-cohort denial;
2. navigation, field guidance, event planning, and safe refusal;
3. explicit proposal selection and owner-scoped proposal-specific guidance;
4. streaming first token, completion, Stop/Retry, focus, and no duplicates;
5. citations and route allowlist;
6. conversation reload/history, delete confirmation, recovery, and isolation;
7. feedback and analytics with no prompt/response leakage;
8. deterministic proposal findings and calculation preservation;
9. 320 px, keyboard, reduced-motion, and screen-reader status behavior;
10. secrets absent from HTML, browser payloads, logs, and client state.

Attach browser, database-terminal-state, and aggregate monitoring evidence.

## Kill-switch drill

With an authorized staging organization and backend feature enabled, keep
`AI_ASSISTANT_KILL_SWITCH=true`. Verify new messages fail safely, history stays
readable, and no billable provider attempt starts. Then set it false for one
grounded response, restore the intended state, and attach the attempt/audit
evidence. Do not perform this drill first in production.

## Monitoring and alerts

Configure alerts before cohort enablement for:

- unexpected tenant/access events (page immediately);
- citation/output-validation regressions and deterministic mismatch (page);
- elevated response failures/interruption/retry rate;
- p95 first-token/completion latency;
- helpfulness decline or abstention spike;
- token/cost ceiling breach;
- stale or revoked knowledge/rule/price use;
- incorrect or unavailable pricing shown as authoritative;
- rate/concurrency protection or telemetry outage.

Alerts use bounded codes, versions, timings, counts, pseudonyms, and cost—not
message content, contacts, client identifiers, provider payloads, or hidden
reasoning.

## Rollback

1. Set `AI_ASSISTANT_KILL_SWITCH=true`.
2. Remove/empty the approved cohort and set `AI_ASSISTANT_ENABLED=false`.
3. Hide the launcher on the next safe dashboard build if needed.
4. Verify history remains readable and no new provider attempt starts.
5. Preserve correlation IDs, terminal states, audits, and aggregate evidence.
6. Classify the incident, support affected users, fix and evaluate in staging.
7. Repeat smoke and kill-switch tests before any re-enable.

Do not purge conversations, roll back migration `026`–`036`, or change models
as an emergency shortcut.

## Pilot support

Publish the cohort, support hours, named support owner, escalation path, and
response targets before launch. Support captures time, safe correlation ID,
route, visible error code, and expected behavior. Never request API keys,
passwords, contact data, or confidential proposal content. The Release owner
reviews open cases before every cohort expansion.

## Incident classification

| Severity | Examples | Immediate action |
| --- | --- | --- |
| SEV-1 | tenant/access leak, credential exposure, deterministic calculation altered | Kill switch, remove cohort, incident response |
| SEV-2 | sustained failures, invalid citations, authoritative stale knowledge/pricing | Pause cohort, preserve evidence, owner decision |
| SEV-3 | isolated retry/latency/UI issue with safe fallback | Support, monitor, scheduled fix |
| SEV-4 | cosmetic or documentation issue | Backlog with owner/date |

## Weekly quality review

Use `docs/templates/AI_ASSISTANT_WEEKLY_REVIEW.md`. The review covers release
identity, cohort, feedback, safety/grounding, deterministic findings,
reliability, latency, usage/cost, support cases, human-review samples, and a
named continue/hold/reduce/pause decision. Never train or update governed
knowledge automatically from user conversations or feedback.
