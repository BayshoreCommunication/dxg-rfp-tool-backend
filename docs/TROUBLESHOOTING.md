# Troubleshooting

> Purpose: recurring failure patterns and first checks. Last updated: 2026-07-22. Owner: engineering.

## Generic AI failure after scope expansion

Check for old limits, enums, or all-or-nothing normalization left from the four-field era. Known examples include selected-count and ordinal caps, eager failure on unmappable candidates, exact-token enum handling, questions tied only to extraction runs, and completion state held only in React state. Prefer per-item resilience and surface invalid operations.

## API changed but worker behavior did not

The API, worker, and dispatcher are separate processes. Run `npm run dev:worker` and `npm run dev:dispatcher` locally, or restart the plain production workers after deployment.

## Job queued or stalled

Check PostgreSQL job/outbox state, worker health, Redis delivery, and feature flags in that order. PostgreSQL is authoritative. Follow [runbooks/DURABLE_JOBS.md](runbooks/DURABLE_JOBS.md).

## Source never becomes eligible

Check private upload completion, ClamAV availability, scan status, retention/deletion state, supported parser, tenant/proposal ownership, and capability flags. Scanning fails closed.

## Estimate refuses or looks low-confidence

Confirm approved pricing coverage, baseline-tier disclosure, region/modifiers, and required questionnaire inputs. Refusal is expected when the corpus cannot support a category.

## Workflow state disagrees

The assistant, extraction runs, and legacy stepper use different gap signals. Refresh durable state and distinguish empty canonical fields from extraction issues. This remains a roadmap item.

See `runbooks/` for incident recovery and [PROJECT_STATE.md](PROJECT_STATE.md) for the current known-issues list.
