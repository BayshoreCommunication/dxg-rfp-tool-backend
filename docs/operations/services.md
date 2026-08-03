# Services

> Every backend process, how it runs, and how to poke it. All services run
> the **same Docker image** (Node 20 bookworm-slim, tini as PID 1, non-root
> `node` user, prod deps only) and differ only by command. Fargate, private
> subnets, secrets injected from `rfpilot/<env>/app` at task start.
> Restart policy: ECS service scheduler replaces dead tasks automatically.
> Logs: CloudWatch, one group per service (`/rfpilot/<env>/<service>`).

```
api
 ├── Purpose: HTTP API, Socket-based notifications, cron jobs
 ├── Command: node dist/server.js
 ├── Port: 8000 (only the ALB can reach it)
 ├── Size: 0.5 vCPU/1GB staging · 1 vCPU/2GB production
 ├── Count: exactly 1 — DO NOT SCALE (unlocked crons, process-local fan-out)
 ├── Deploys: stop-then-start (~30–60s downtime per deploy)
 ├── Env of note: CRON_ENABLED=true (only here), keepAliveTimeout 65s
 ├── Health: GET /health → {status, database, postgres{migrationVersion}, queue, environment}
 │           ALB target health 15s interval · Docker HEALTHCHECK 30s, 45s start period
 ├── Depends on: Mongo (fatal at boot if unreachable), Postgres (graceful),
 │               Redis (graceful), ClamAV (fail-closed uploads), SES, OpenAI
 └── Logs: /rfpilot/<env>/api

worker
 ├── Purpose: BullMQ durable-job consumer — security_scan (ClamAV),
 │            knowledge_parse, knowledge_index_release, proposal_context_extract,
 │            candidate_application, proposal_draft_generate, vendor_response_analyze
 ├── Command: node dist/scripts/startDurableWorker.js
 ├── Size: 1 vCPU/2GB · autoscales 1→2 (staging) / 1→4 (prod) at 70% CPU
 ├── Shutdown: SIGTERM drains active jobs (120s stop timeout, 90s job leases)
 ├── Health: no port — watch RunningTaskCount alarm + job heartbeats
 │           (SELECT max(heartbeat_at) FROM rfpilot.job_attempts WHERE status='running')
 └── Logs: /rfpilot/<env>/worker

dispatcher
 ├── Purpose: Postgres outbox → Redis queues (FOR UPDATE SKIP LOCKED;
 │            reclaims rows stranded in 'publishing'; republishes after Redis loss)
 ├── Command: node dist/scripts/startDurableDispatcher.js
 ├── Size: 0.25 vCPU/0.5GB · 1 task (overlap-safe during deploys)
 ├── Health: no port — RunningTaskCount alarm + oldest pending outbox row age
 └── Logs: /rfpilot/<env>/dispatcher

ai-gateway
 ├── Purpose: platform assistant's job worker
 ├── Command: node dist/scripts/startAiGatewayWorker.js
 ├── Exists only when: the env's AI release sets AI_GATEWAY_ENABLED
 │   (currently both envs). Uses the dispatcher's SG and sizing.
 └── Logs: /rfpilot/<env>/aigateway   ← note: no hyphen in the log group

clamav
 ├── Purpose: malware scanning for every uploaded file (fail-closed:
 │            scanner down ⇒ vendor uploads 503, sources → scan_failed; intended)
 ├── Image: clamav/clamav:1.4 (public), NOT the app image
 ├── Port: 3310, reachable only from api and worker via ECS Service Connect
 │         (CLAMAV_HOST=clamav, CLAMAV_PORT=3310)
 ├── Size: 1 vCPU/3GB (signature DB is RAM-hungry) · first boot downloads
 │         ~300MB signatures — health check allows 5 minutes
 └── Logs: /rfpilot/<env>/clamav

migrate (not a service — a task definition)
 ├── Purpose: Postgres schema migrations, run once per deploy by CI
 ├── Command: node dist/scripts/migratePostgres.js up
 ├── Secrets: POSTGRES_URL/POSTGRES_MIGRATION_URL ONLY — no MONGODB_URL,
 │            so Mongo-touching scripts must run on the api task definition
 └── Logs: /rfpilot/<env>/migrate
```

## Handy commands

```bash
export AWS_PROFILE=rfpilot AWS_REGION=us-east-2
ENV=production   # or staging

# Service status at a glance
aws ecs describe-services --cluster rfpilot-$ENV \
  --services api worker dispatcher clamav ai-gateway \
  --query 'services[].{name:serviceName,desired:desiredCount,running:runningCount,rollout:deployments[0].rolloutState}'

# Recent service events (scheduler decisions, health-check kills)
aws ecs describe-services --cluster rfpilot-$ENV --services api \
  --query 'services[0].events[:10].[createdAt,message]' --output text

# Why did a task stop?
aws ecs list-tasks --cluster rfpilot-$ENV --desired-status STOPPED --query 'taskArns' --output json
aws ecs describe-tasks --cluster rfpilot-$ENV --tasks <arn> \
  --query 'tasks[0].{stopped:stoppedReason,exit:containers[0].exitCode}'

# Restart a service (e.g. after a secret rotation)
aws ecs update-service --cluster rfpilot-$ENV --service api --force-new-deployment
```

## One-off tasks

Operational scripts run as one-off Fargate tasks with a command override on
the **api task definition** (it has the full secret set). Get the network
parameters from the api service itself, then:

```bash
SUBNETS=$(aws ecs describe-services --cluster rfpilot-$ENV --services api \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.subnets' --output text | tr '\t' ',')
SG=$(aws ecs describe-services --cluster rfpilot-$ENV --services api \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.securityGroups[0]' --output text)

TASK=$(aws ecs run-task --cluster rfpilot-$ENV --task-definition rfpilot-$ENV-api \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"api","command":["node","dist/scripts/<SCRIPT>.js","--apply"]}]}' \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster rfpilot-$ENV --tasks "$TASK"
aws ecs describe-tasks --cluster rfpilot-$ENV --tasks "$TASK" \
  --query 'tasks[0].containers[0].exitCode'
```

Available scripts (all dry-run by default, `--apply` to write, JSON report
to stdout — **always read the report in `/rfpilot/<env>/api` logs, not just
the exit code**):

| Script | Purpose |
|---|---|
| `migrateDxgOrganization.js` | Seed/backfill the default `dxg` organization |
| `backfillPostgresProposalReferences.js --organization-id=<id>` | Mirror org/users/proposals into the Postgres AI foundation |
| `migrateAssetUrls.js --from=<url> --to=<url>` | Rewrite stored absolute asset URLs |
| `migratePostgres.js up\|rollback` | Schema migrations (also fine on the migrate task def) |
