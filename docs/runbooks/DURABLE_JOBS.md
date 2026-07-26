# Runbook — Durable Jobs, Workers, and Redis

## Symptoms

Oldest queued age above five minutes, no worker for two minutes, outbox lag above two minutes, repeated stalls, Redis eviction, retry growth, or a dead letter.

## Safe diagnostics

1. Check queue/job/outbox dashboards by job type and safe outcome.
2. Inspect the PostgreSQL job, attempt, and dead-letter records using organization-scoped operator access.
3. Correlate by job/trace/correlation ID. Never inspect or log the underlying document/proposal body.
4. Confirm Redis messages remain reference-only.

## Recovery

- Restore the dependency or worker before retrying.
- Use the authorized retry endpoint with a reason; recovery is audited.
- Reconstruct queued Redis work from PostgreSQL/outbox after Redis loss.
- If eviction occurred, stop dispatch, correct memory/eviction policy, reconcile, then resume controlled work.
- Disable durable-job creation/dispatch if safe processing cannot be guaranteed.

## Verification

Job reaches the expected terminal state once, outbox/queue reconcile, attempts are bounded, no duplicate side effect occurs, and the alert resolves.
