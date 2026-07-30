# Proposal Analysis

## Boundary

Proposal analysis is the existing deterministic readiness path used by the
dedicated proposal workspace. It is separate from the general Platform AI
Assistant. A report is generated only for the proposal ID in the authenticated
route, after Mongo owner scoping, PostgreSQL organization RLS, and an
organization/owner proposal-reference check all succeed.

The analysis is read-only. It does not call a model, change proposal fields,
publish, send, price, or apply suggestions.

## Versioned report

`proposal-analysis.v3` produces:

- a concise summary containing only event name, format, date range, attendance,
  and room count;
- section completeness and an overall score;
- deterministic missing, conditional, schedule, production, budget, and risk
  findings;
- a stable finding ID, affected fields, bounded evidence state, explanation,
  suggested next step, confidence, and current-proposal provenance;
- proposal and analysis versions on every finding.

Migration `035_proposal_analysis_summary` adds the summary object to the
existing `guidance_reports` table and advances the default engine version.
Historical reports remain readable.

Migration `036_room_schedule_analysis` adds the separately versioned
[`room-schedule-analysis.v1`](./ROOM_SCHEDULE_ANALYSIS.md) result. Historical
reports without that object remain readable.

## Staleness and safety

The latest-report read reloads the authoritative owner-scoped Mongo proposal
version. If it differs from the stored report version, the API returns
`stale=true` and both versions. Stale findings remain viewable for audit and
comparison, but the dashboard asks the user to refresh before relying on them.

Evidence includes only the field path, presence/conflict state, and short
scalar values when safe. Contact values and arbitrary long proposal text are
not copied into the summary. Audit metadata remains content-free.

Equipment and scope dependency checks are supplied by the separately versioned
[`scope-guidance.v1`](./SCOPE_GUIDANCE.md) registry. Room/session conflicts and
conditional reuse are supplied by
[`room-schedule-analysis.v1`](./ROOM_SCHEDULE_ANALYSIS.md). Budget calculation
remains a separate deterministic phase.
