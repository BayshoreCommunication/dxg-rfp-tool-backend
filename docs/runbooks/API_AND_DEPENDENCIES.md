# Runbook — API and Dependency Health

## Symptoms

Elevated 5xx rate, p95 latency, failed readiness, PostgreSQL pool pressure, Redis unavailability, or scanner/storage dependency errors.

## Safe diagnostics

1. Use the correlation ID from the response or alert to search traces and allowlisted logs.
2. Check `/health` and the Platform Foundation dashboard. Do not enable body/header/query logging.
3. Identify the safe dependency category and error code; do not copy connection strings or provider messages into tickets.
4. Confirm whether manual proposal view/edit remains available.

## Containment and recovery

- Disable the affected optional feature flag when its dependency is unhealthy.
- For PostgreSQL authoritative durable work, fail closed and preserve queued state.
- For telemetry-export failure, set `OBSERVABILITY_ENABLED=false` and restart; business state must remain unchanged.
- Escalate authentication/public-access signals to the security owner. Rotate secrets only through the approved security procedure.

## Verification

Health returns ready, controlled requests succeed, error rate returns to baseline, and no queued/audit state is lost. Record correlation IDs, safe error codes, timeline, mitigation, and follow-up—never business content.
