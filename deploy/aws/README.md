# RFPilot backend on AWS

CDK (TypeScript) infrastructure for the RFPilot backend: ECS Fargate services
for the API, durable worker, outbox dispatcher, and ClamAV; ALB + WAF; RDS
PostgreSQL 16 (pgvector); ElastiCache Redis (TLS + AUTH, cluster mode
disabled); private SSE-KMS S3 buckets; CloudFront for app assets; Secrets
Manager; CloudWatch alarms; GitHub OIDC deploy roles. Region: `us-east-2`.

The DigitalOcean assets under `deploy/` are unrelated and remain usable during
the migration window (`deploy/DIGITALOCEAN.md`, manual `Deploy to
DigitalOcean (legacy)` workflow).

## Stack layout

| Stack | Contents | Deploy cadence |
|---|---|---|
| `Rfpilot-Cicd` | ECR, GitHub OIDC provider + per-env deploy roles | Rarely, by an operator |
| `Rfpilot-<env>-Network` | VPC, subnets, NAT, endpoints, security groups | Rarely, by an operator |
| `Rfpilot-<env>-Data` | KMS, S3 buckets, RDS, Redis, secrets, assets CDN | Rarely, by an operator; termination-protected in production |
| `Rfpilot-<env>-App` | ECS services, ALB, WAF, migration task definition | Every release, by CI |
| `Rfpilot-<env>-Observability` | Alarms + SNS alert topic | With App |

`<env>` is `production` (deployed from the `production` branch) — the only
environment. A separate `staging` environment existed until 2026-08-18 and was
removed; recreating one means adding an entry back to `ENVIRONMENTS` and
running the bootstrap below with its name. Sizing lives in
[`lib/config.ts`](lib/config.ts).

## One-time bootstrap (operator, admin credentials)

1. `cd deploy/aws && npm ci`
2. `npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-2`
3. `npx cdk deploy Rfpilot-Cicd` — note the `DeployRoleArn-*` and
   `RepositoryUri` outputs.
4. In GitHub repo settings, set the repository variable `AWS_ACCOUNT_ID`.
   (The deploy workflow is inert until this exists.)
5. `npx cdk deploy Rfpilot-<env>-Network Rfpilot-<env>-Data`
6. **Fill secrets**: open `rfpilot/<env>/app` in Secrets Manager and replace
   every `REPLACE_ME`:
   - `POSTGRES_URL` / `POSTGRES_MIGRATION_URL`:
     `postgresql://rfpilot_admin:<password>@<DatabaseEndpoint>/rfpilot`
     (password from the RDS-generated secret; endpoint from the Data stack
     `DatabaseEndpoint` output).
   - `REDIS_URL`: `rediss://:<auth-token>@<RedisPrimaryEndpoint>` (token from
     `rfpilot/<env>/redis-auth`; note the scheme **must** be `rediss://`).
   - `MONGODB_URL`: the Atlas connection string (rotate the existing
     credential as part of cutover).
   - Remaining keys: JWT/OTP/BFF/admin secrets (fresh long random values),
     `OPENAI_API_KEY`, `GOOGLE_CLIENT_ID`, SMTP settings.
7. Push a commit to `main` (or re-run the workflow): CI builds the image,
   scans it, pushes `sha-<commit>`, runs migrations, deploys the App and
   Observability stacks, and smoke-checks `GET /` and `GET /health`.
   The first App deploy requires an image in ECR — if deploying manually
   before CI ever ran, build and push one first and pass
   `-c imageTag=sha-<commit>`.
8. Atlas network access: create a PrivateLink endpoint to the VPC (preferred)
   or allowlist the NAT gateway's EIP.
9. HTTPS: create an ACM certificate for the API hostname in `us-east-2`,
   validate via DNS, then redeploy the App stack with
   `-c certificateArn=<arn> -c apiDomain=<host> -c frontendUrl=<url> -c adminUrl=<url>`
   and point DNS (CNAME/alias) at the `AlbDnsName` output.
10. Post-first-deploy hardening: scope the assets-bucket KMS key policy's
    CloudFront condition to the real distribution ARN (see the cdk warning
    `wildcardKeyPolicyForOac`), and subscribe an email via
    `-c alertEmail=<address>` on the Observability stack.

Repeat 5–9 with that environment's names when standing up a new environment.

## Everyday deployment

Push to `production` → production. That is the only automatic deploy; `main`
carries CI only.
`.github/workflows/deploy-aws.yml` is the pipeline: quality gates → image
build → Trivy scan (fails on fixable HIGH/CRITICAL) → ECR push (immutable
`sha-<commit>` tag) → **one-off migration task using the new image** (services
still on the old image) → `cdk deploy` of App + Observability → smoke checks.

Manual equivalent (operator):

```bash
aws ecs run-task --cluster rfpilot-<env> --launch-type FARGATE \
  --task-definition rfpilot-<env>-migrate \
  --network-configuration "awsvpcConfiguration={subnets=[<PrivateSubnetIds>],securityGroups=[<MigrateSecurityGroupId>],assignPublicIp=DISABLED}"
cd deploy/aws && npx cdk deploy Rfpilot-<env>-App -c imageTag=sha-<commit> --require-approval never
```

## Rollback

- **Application**: redeploy with the previous image tag —
  `npx cdk deploy Rfpilot-<env>-App -c imageTag=sha-<previous-commit>`.
  Failed deployments roll back automatically (ECS deployment circuit
  breaker).
- **Migrations**: `migratePostgres.ts` supports rolling back exactly one
  migration (`node dist/scripts/migratePostgres.js rollback` as a one-off
  task with the command overridden). Treat migrations as forward-only;
  for anything worse, restore the pre-deploy RDS snapshot. Take a manual
  snapshot before risky migrations:
  `aws rds create-db-snapshot --db-instance-identifier <id> --db-snapshot-identifier pre-<sha>`.

## Operational notes (from the discovery report — do not "fix" casually)

- **The API runs one steady-state task with rolling overlap** (`100/200`), so
  deployments keep one healthy ALB target. API tasks always set
  `CRON_ENABLED=false`; unlocked destructive cron jobs run in the separate
  singleton `cron` service, which deliberately replaces stop-then-start.
  WebSocket notification fan-out remains process-local, so horizontal
  steady-state API scaling still requires Redis pub/sub fan-out.
- **ClamAV is fail-closed by design.** If the `clamav` service is down,
  vendor uploads 503 and planner sources sit in `scan_failed` (retryable) —
  that is intended behavior, not an outage to work around. First start
  downloads ~300 MB of signatures; the health check allows 5 minutes.
- **Worker/dispatcher have no health port.** Their health signals are the
  `RunningTaskCount` alarms plus, when investigating:
  `SELECT max(heartbeat_at) FROM rfpilot.job_attempts WHERE status='running'`
  and the age of the oldest `pending` row in `rfpilot.outbox_events`.
  A queue-backlog/outbox-age metrics probe is a planned follow-up.
- **AI stays off at the infrastructure level**: no `AI_ENVIRONMENT` variable
  is set anywhere in these stacks, which is the platform's deny-by-default
  state. Enabling AI features is a separate release procedure
  (`docs/runbooks/PRODUCTION.md`) executed by changing task-definition
  environment — never a side effect of an infra deploy.
- **Redis is transport-only** (no snapshots on purpose); after a Redis loss
  the dispatcher's reconciler republishes from the Postgres outbox within
  ~30s.

## Secret rotation

All app secrets live in `rfpilot/<env>/app`. To rotate: update the value in
Secrets Manager, then force a new deployment
(`aws ecs update-service --cluster rfpilot-<env> --service <svc> --force-new-deployment`)
— ECS injects secrets at task start. Rotate `JWT_SECRET` with care (it
invalidates sessions); Redis AUTH and RDS password rotation require updating
both the source secret and the composed URL keys.

## Backups and restore

- **RDS**: automated backups (30d in production) + manual
  pre-migration snapshots. Restore creates a new instance: restore, then
  update `POSTGRES_URL`/`POSTGRES_MIGRATION_URL` in the app secret and force
  new deployments.
- **Atlas (Mongo)**: Atlas-managed continuous backups (M10+).
- **S3**: versioning is enabled on both buckets; noncurrent versions expire
  after 30 days.
- **Redis**: nothing to restore (transport-only, see above).

## Cost levers

Biggest knobs, in order: RDS Multi-AZ (production), NAT gateway count,
Fargate task sizes, Redis replica count, Atlas tier — all in
[`lib/config.ts`](lib/config.ts) except Atlas.
