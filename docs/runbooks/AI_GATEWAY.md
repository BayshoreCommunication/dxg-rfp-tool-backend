# Runbook — Mock AI Gateway and Telemetry Privacy

## Gateway symptoms

Unexpected policy/budget denial, validation regression, worker failure, idempotency conflict, or mock-AI latency/error increase.

1. Confirm environment is non-production, provider/model is `mock/deterministic-v1`, classification is `synthetic`, and the fixture is allowlisted.
2. Inspect safe run, attempt, validation, policy, schema, prompt-version, and budget metadata.
3. Do not enable a live provider, credentials, fallback, arbitrary fixture content, or proposal application.
4. Disable `AI_GATEWAY_ENABLED` if policy or validation integrity is uncertain.

## Suspected telemetry leakage

Treat any prohibited canary or business content in a log, span, metric, dashboard, or alert as critical.

1. Disable `OBSERVABILITY_ENABLED` and stop the local collector export pipeline.
2. Restrict access to the affected local telemetry stores; do not copy the exposed value.
3. Identify the event/schema version and affected retention window using IDs only.
4. Correct the allowlist/serializer and add a regression canary test.
5. Purge affected local test telemetry according to the approved retention procedure.
6. Re-enable only after leakage tests and security review pass.

Verification requires clean canary scans across stdout JSON, OTLP logs/traces/metrics, dashboards, and alerts, plus confirmation that authoritative business state was unaffected.
