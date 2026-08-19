# Monitoring & Observability

> Everything is CloudWatch, region **us-east-2**. Replace `<env>` with
> `production` throughout (the only environment).

## Logs — where to look first

Console path: **CloudWatch → Log groups → `/rfpilot/<env>/<service>`**.
Each deployment/task creates a stream named `<service>/<service>/<task-id>`;
sort streams by *Last event time* and open the newest.

| Log group | Contains |
|---|---|
| `/rfpilot/<env>/api` | Every HTTP request line (morgan: method, path, status, latency), boot banner (Mongo/Postgres/Redis connection results), SMTP send confirmations, stack traces. **Also the output of one-off tasks run on the api task definition.** |
| `/rfpilot/<env>/worker` | Durable-job processing; mostly quiet — job failures are recorded in Postgres (`rfpilot.durable_jobs.errorCode`), not always in the log |
| `/rfpilot/<env>/dispatcher` | Outbox polling; startup and error states |
| `/rfpilot/<env>/aigateway` | Assistant job worker |
| `/rfpilot/<env>/clamav` | Signature updates, scan requests |
| `/rfpilot/<env>/migrate` | Each deploy's migration run |

CLI equivalents:

```bash
export AWS_PROFILE=rfpilot AWS_REGION=us-east-2
# Tail live
aws logs tail /rfpilot/production/api --follow
# Search a window for errors
aws logs filter-log-events --log-group-name /rfpilot/production/api \
  --start-time $(($(date +%s)*1000 - 3600000)) --filter-pattern "ERROR"
```

**To investigate a production 500:** open `/rfpilot/production/api`, newest
stream, and search around the timestamp. Request lines look like
`POST /api/v1/... 500 123.4 ms`; the stack trace is directly above or below.
Client-facing errors include a `Reference: <uuid>` correlation id — search
the log group for that uuid.

## Alarms

All alarms notify SNS topic `rfpilot-<env>-alerts` (**⚠️ no email
subscription is attached yet** — until an Observability deploy passes
`-c alertEmail=<addr>`, check the CloudWatch Alarms console during
incidents). Console: **CloudWatch → All alarms → filter `rfpilot-<env>`**.

| Alarm | Meaning / threshold |
|---|---|
| `rfpilot-<env>-api-5xx` | >10 target 5xx from the app in 5 min |
| `rfpilot-<env>-<svc>-tasks-low` (api, worker, dispatcher, clamav) | Running tasks below desired for 5 min — the only health signal for worker/dispatcher, which have no port |
| `rfpilot-<env>-<svc>-cpu-high` / `-memory-high` | >85% for 15 min |
| `rfpilot-<env>-rds-cpu-high` | >85% for 15 min |
| `rfpilot-<env>-rds-storage-low` | <5 GB free |
| `rfpilot-<env>-rds-connections-high` | >80 sustained (normal is 30–40: pools are `POSTGRES_POOL_MAX=10` per service — far above that means a pool leak or task storm) |
| `rfpilot-<env>-redis-cpu-high` / `-redis-memory-high` | >80% for 15 min |

## Application health

- `GET https://api.dxg-agency.com/health` returns
  `{status:"OK", database:"connected", postgres:{ready,migrationVersion},
  queue:{ready}, environment}` — one call tells you Mongo, Postgres, and
  Redis connectivity plus the schema version.
- ALB target health: **EC2 → Target groups → `Rfpilo-ApiTa-*`** — is the
  api target `healthy`?
- Response times / error rates: **CloudWatch → Metrics → ApplicationELB**
  (`TargetResponseTime`, `HTTPCode_Target_5XX_Count`,
  `RequestCount`) filtered to the environment's load balancer.

## Infrastructure

- **ECS**: Console → ECS → `rfpilot-<env>` → service → *Health and metrics*
  (Container Insights is on: per-task CPU/memory). Deployment events under
  the service's *Events* tab tell you when health checks kill tasks.
- **RDS**: Console → RDS → the `rfpilot-<env>-data-database*` instance →
  Monitoring (CPU, connections, IOPS, free storage). Slow-query analysis:
  not currently enabled (no Performance Insights) — *needs verification
  before relying on it; enable it in `data-stack.ts` if needed*.
- **ElastiCache**: Console → ElastiCache → replication group
  `rfpilot-<env>` (EngineCPUUtilization, DatabaseMemoryUsagePercentage,
  CurrConnections, Evictions). Known cosmetic issue: services log
  `Eviction policy is volatile-lru. It should be "noeviction"` at startup.
  Cache hit/miss is not meaningful here — Redis is a queue transport, not a
  cache.
- **WAF**: Console → WAF & Shield (us-east-2) → `rfpilot-<env>-waf` →
  sampled requests, if you suspect legitimate traffic is being blocked.
- **VPC flow logs** (rejected traffic only): CloudWatch log group created by
  the Network stack — useful for "is a security group eating my packets".

## External dependencies

- **MongoDB Atlas**: Atlas console (cluster shared by both envs) — metrics,
  slow queries, and the **Network Access allowlist** (NAT EIPs
  `13.58.171.171` must stay listed).
- **SES**: Console → SES (us-east-2) → Account dashboard: sending quota,
  bounce/complaint rates, suppression list. Sandbox status lives here too.
- **OpenAI**: usage dashboard on platform.openai.com (one shared key —
  spend spikes show both envs combined).
- **GitHub Actions**: deploy history — `gh run list --workflow "Deploy to AWS"`.

## Known gaps (deliberate, documented follow-ups)

- Queue-backlog / outbox-age custom metrics need a scheduled probe (until
  then: the SQL probes in [Services](services.md)).
- SNS alert topic has no subscribers.
- No APM/tracing product; the app's OTLP exporter is restricted to
  localhost sidecars and is disabled (`observability.enabled:false` in
  `/health`).
