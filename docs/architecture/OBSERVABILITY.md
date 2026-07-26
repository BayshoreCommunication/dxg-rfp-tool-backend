# Slice 1G Observability

Slice 1G emits only allowlisted operational metadata to a local/private OpenTelemetry collector. It is disabled unless `OBSERVABILITY_ENABLED=true`. `OTEL_EXPORTER_OTLP_ENDPOINT` must resolve to `localhost`, `127.0.0.1`, `::1`, or the test Compose service `otel-collector`; other destinations fail startup.

## Local test stack

```bash
npm run observability:up
```

Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`, `OTEL_SERVICE_NAME=rfpilot-backend`, and a test-only `TELEMETRY_PSEUDONYM_KEY`. Grafana is bound to `127.0.0.1:3001`; Prometheus, Tempo, Loki, and collector ports are also loopback-bound. Configure a non-default Grafana administrator password before shared use.

Operational logs retain 14 days in the local Loki configuration, traces retain 7 days in Tempo, and Prometheus starts with 30-day retention. These are test defaults only. No external exporter or alert receiver is configured.

## Privacy contract

`src/shared/observability/safeTelemetry.ts` is the sole structured event serializer. Unknown fields are discarded. Request bodies, response bodies, query strings, headers, database statements, file names/content, prompts, outputs, personal data, tokens, credentials, connection strings, and signed URLs are never accepted. Metrics use a stricter bounded-label allowlist and exclude every tenant/user/resource/trace identifier.

Manual spans are used instead of generic automatic instrumentation so URLs and database statements cannot be captured implicitly. Correlation IDs are validated or regenerated and returned as `X-Correlation-ID`. Trace baggage never supplies tenant identity or authorization.

## Failure behavior

Exporter failure is non-authoritative and must not alter proposal, document, job, or AI-run state. PostgreSQL remains authoritative for audit/job/run data. Disable export with `OBSERVABILITY_ENABLED=false`; restart services and verify normal manual proposal behavior. See the runbooks under `docs/runbooks/`.
