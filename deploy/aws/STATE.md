# AWS deployment — current state and handoff

> Status as of 2026-09-01. Owner: Travis (Bayshore). This file is the
> single place to read before continuing AWS work in a new session.
> Operating docs: [README.md](README.md) (bootstrap/deploy/rollback runbook).
> No secrets in this file — all secret values live in AWS Secrets Manager.

## What is live

**Production is the only environment.** The staging environment was removed
from AWS on 2026-08-18 (see "Staging removal" below).

| Fact | Value |
|---|---|
| AWS account | `295229565954` (IAM user `aidev`, local CLI profile `rfpilot`) |
| Region | `us-east-2` |
| Production API | `https://api.dxg-agency.com` (HTTPS, 80→443 redirect; CNAME in Namecheap → ALB `Rfpilo-Alb16-pj5OOUBQqRrt-519967115.us-east-2.elb.amazonaws.com`) |
| TLS cert | ACM wildcard `*.dxg-agency.com` + apex, us-east-2, `.../f6976da6-0174-40b4-86bc-9525267a8b08` (DNS-validated; validation CNAME lives in Namecheap — do not delete it, ACM renews through it) |
| Health | `GET /health` → 200 OK; Mongo connected, Postgres migrated to `059`, Redis queue ready, observability enabled (verified 2026-09-01) |
| ECS cluster | `rfpilot-production` — services `api`(1), `worker`(1), `dispatcher`(1), `cron`(0, scaled to zero pre-launch), `clamav`(1), `ai-gateway`(1) |
| Assets CDN | `d1hn23mh1h53mx.cloudfront.net` |
| NAT egress IP | `13.58.171.171` (allowlisted in Atlas Network Access) |
| MongoDB | Atlas, database `dxg_rfp_tool_prod` |
| ECR | `295229565954.dkr.ecr.us-east-2.amazonaws.com/rfpilot-backend`, immutable `sha-<commit>` tags (shared, in `Rfpilot-Cicd`) |
| Secrets | `rfpilot/production/app`, `rfpilot/production/redis-auth` |
| Deployed image | `sha-7246b6bb` (2026-09-01) |

**CI/CD**: push to `production` → `.github/workflows/deploy-aws.yml` runs quality
gates → image build → Trivy scan → ECR push → one-off Postgres migration task
(new image, before services roll) → CDK deploy of App+Observability → smoke
checks. Auth is GitHub OIDC only (branch/environment-locked role, no stored AWS
keys). Domain/cert/URL CDK contexts flow from the `production` GitHub
environment's variables. Doc-only pushes do not deploy (`paths-ignore`).
`main` carries CI only and no longer deploys anything.

**CD is GREEN.** The 2026-08-12 red — two failing quality-gate tests
(`proposal field guidance covers the canonical form contract`, `schema field
inventory digest detects unreviewed additions, removals, and renames`) — was
cleared, and deploys have run clean since 2026-08-23. Production is on
migration `059`; the 044–058 backlog that had accumulated behind the red gate
is applied.

**Last deploy**: 2026-09-01, run
[33506322481](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/actions/runs/33506322481),
image `sha-7246b6bb`. Third of three runs that day:

1. Run
   [33501517217](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/actions/runs/33501517217)
   (`e6cec2c`) **failed harmlessly** — `Rfpilot-production-App` rolled back
   in ~2s with "Cannot delete export …CronService…Name… as it is in use by
   Rfpilot-production-Observability". Cause: the rightsizing commit
   (`b965d24`, cron `desiredCount: 0`) makes Observability skip the cron
   alarms and drop its import of the App stack's CronService name export,
   but CI deploys App before Observability, so CloudFormation refused to
   delete the still-imported export. API stayed 200 throughout; no
   resources changed.
2. Run
   [33503797929](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/actions/runs/33503797929)
   (`6a51f2d`, ~18m) **succeeded** with the two-phase fix: a temporary
   `this.exportValue(cronService.serviceName)` kept the export alive while
   Observability dropped its import. Shipped: vendor fact-mapping
   output-limit fix (clamp 4000→16000 + `LIVE_AI_OUTPUT_TOKEN_LIMIT=16000`,
   PR #16 — fixes deterministic `LIVE_AI_MALFORMED_OUTPUT` on partially
   OCR'd vendor PDFs), evaluation-controller error logging (unknown errors
   were previously swallowed silently), and the pre-launch rightsizing
   (`b965d24`: RDS `t4g.micro`, 7-day backups, cron scaled to 0).
3. Run
   [33506322481](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/actions/runs/33506322481)
   (`7246b6b`) **succeeded** — removed the temporary export now that the
   deployed Observability stack no longer imports it.

Verified after the final roll: `/health` 200 with Mongo connected, Postgres
`059`, queue ready, observability enabled.

**New lesson (2026-09-01)**: removing a cross-stack export (e.g. by scaling a
service to zero so its alarms — and their imports — disappear) needs a
two-phase deploy because CI deploys App before Observability: first deploy
with a temporary `this.exportValue(...)` in the App stack keeping the old
export alive, then a second deploy that removes it.

**Stacks deployed**: `Rfpilot-Cicd` + the four `Rfpilot-production-*` stacks.
`api.dxg-agency.com` has pointed at the AWS prod ALB since 2026-08-03.
**SES production access is GRANTED** (verified 2026-08-18:
`ProductionAccessEnabled: true`, 50k/day, 14/sec) — the old sandbox
restriction is lifted and real-user signups receive OTPs.
ON HOLD by decision 2026-08-03: **dxg-agency.com is NOT the final product
domain**; the API keeps `api.dxg-agency.com` by decision (2026-08-04), while
the product domain is av-rfpilot.com.
Bootstrap lessons now fixed in code: promotion reuses the immutable
image (+ race tolerance + `ecr:DescribeImages` on deploy roles); FIRST
App deploy of a new env must be manual (CI's migrate step needs the
App stack's task definition); listener SG rules land in the NETWORK
stack template at synth time — after enabling HTTPS, redeploy Network
with the cert context or port 443 stays closed (bit us on prod).

## Staging removal (2026-08-18)

Staging was deleted at Travis's request — production is now the only
environment. What was done:

- All four `Rfpilot-staging-*` stacks deleted (Observability → App → Data →
  Network). No production resource depended on them: all 26 staging
  CloudFormation exports were imported only by other staging stacks.
- The `RemovalPolicy.RETAIN` leftovers were deleted explicitly afterwards —
  RDS instance (no final snapshot, by decision), KMS key (scheduled), the
  three S3 buckets and their contents, and the three Secrets Manager secrets.
  Skipping this pass would have left RDS and storage billing indefinitely.
- Code: `staging` removed from `ENVIRONMENTS` in `lib/config.ts`, the
  staging-only cdk-nag suppressions removed from `bin/rfpilot.ts`,
  `deploy-aws.yml` restricted to the `production` branch (the `STAGING_PAUSED`
  guard and the env-name ternaries are gone), `compose-app-secrets.sh` now
  defaults to `production`.
- IAM: user `rfpilot-staging-ses-smtp` deleted along with its access key and
  its `ses-send-only` inline policy (last used 2026-08-02; production sends
  through its own `rfpilot-production-ses-smtp`, key last used 2026-08-11 —
  verified unaffected). The `rfpilot-staging-github-deploy` role is the last
  staging artifact: remove it with
  `npx cdk deploy Rfpilot-Cicd --exclusively` (diff confirmed it destroys
  only that role, its policy and its output).
- GitHub: repository variable `STAGING_PAUSED` and the staging environment's
  variables deleted. The empty `staging` *environment* itself still exists —
  deleting it needs repo admin rights.
- External, still outstanding: the Namecheap `api-staging` CNAME, the Atlas
  `dxg_rfp_tool_staging` database, and the stale NAT allowlist entry
  `18.223.236.137`. Leave the ACM validation CNAME and DKIM records alone.
- Shared and therefore untouched: the ECR repository and GitHub OIDC provider
  (both in `Rfpilot-Cicd`), and the ACM wildcard certificate.

To recreate a staging environment, add its entry back to `ENVIRONMENTS` and
follow the bootstrap sequence in README.md — note the first App deploy of a
new environment must be manual.

## Production AI release (2026-08-03)

Production runs the FULL AI surface at staging parity (Travis-approved):
workspace, workflow, assistant + ai-gateway service, guidance, knowledge
(deterministic embeddings), live OpenAI (pinned model). Verified in the
production browser pass: live contextual replies, 8-question intake,
platform assistant with sources. NOTE the Postgres foundation backfill
had to be re-run after the first attempt silently produced no rows
(likely ran pre-migration); always READ the task's JSON report, exit 0
alone is not proof. Deny-by-default now applies to NO environment —
re-establish it deliberately if the posture should return.

## Product domain (2026-08-04)

The real product domain is **av-rfpilot.com** (registered at GoDaddy):
apex/www → Vercel dashboard, `admin.` reserved for the admin app.
**The API keeps `api.dxg-agency.com`** by decision — no backend hostname
change. SES: `av-rfpilot.com` identity verified (DKIM + DMARC in GoDaddy),
`SMTP_MAIL=noreply@av-rfpilot.com` in both env secrets and verified
sending. Production `FRONTEND_URL`/`ADMIN_URL` GitHub vars point at the
new domain. SES production-access case: reply sent 2026-08-04 referencing
av-rfpilot.com. **APPROVED** — verified 2026-08-18,
`ProductionAccessEnabled: true` (50k/day, 14/sec).

## Cost posture (2026-08-18)

August 1–18 billing showed gross usage $337.54 against a net of $212.49 —
**credits absorbed $125.05, covering 100% of Fargate compute and part of
VPC**. That subsidy is invisible in the cost console's default view: when it
lapses the bill roughly doubles with no change in usage. The balance and
expiry are only in Billing → Credits (no API). Budget for the gross number.

Reductions applied (all deployed and verified):

| Change | Saving |
|---|---|
| Staging environment deleted | ~$115/mo |
| 4 VPC interface endpoints removed | ~$58/mo |
| Container Insights disabled | ~$47/mo |
| Fargate CPU 1024→512 on api/worker/clamav | ~$44/mo |
| | **~$264/mo** |

- The interface endpoints (ECR/Logs/Secrets) cost ~$58/month to divert about
  1.3 GB/month of traffic — roughly $0.06 through the NAT gateway that
  already exists. The free S3 *gateway* endpoint is kept. Reversible via
  `privateAwsEndpoints: true` in `lib/config.ts` if private-only egress ever
  becomes a compliance requirement rather than an optimisation.
- Container Insights was the ONLY source of `ECS/ContainerInsights`
  `RunningTaskCount`, which the `*-tasks-low` alarms used — and worker and
  dispatcher have no health port. Turning it off therefore REQUIRED the
  alarm rewrite in `observability-stack.ts`: `AWS/ECS CPUUtilization` with an
  impossible threshold (`< 0`) and `treatMissingData: BREACHING`, so the
  alarm can only be driven by missing datapoints, which ECS stops publishing
  when no task runs. **It detects zero tasks, not below-desired** — turn
  Insights back on before running any service at a steady-state count above
  one. cdk-nag `AwsSolutions-ECS4` is suppressed in `bin/rfpilot.ts` for this.
- Fargate was grossly oversized: seven-day utilisation was api 2.3% avg /
  8.8% peak CPU using 158 MB of 2048, worker 1.1%, clamav 1.1% using 990 MB
  of 3072. Memory was deliberately NOT cut — it is the headroom that absorbs
  load, and autoscaling is the intended answer to traffic.

**Not done, deliberately:** RDS Multi-AZ → single-AZ would save ~$42/mo but
trades away automatic failover on the system of record.

**Still open:** no AWS Budgets exist; the `env` and `project` cost-allocation
tags exist on resources but are INACTIVE, so per-environment splits have to
be inferred from usage types. Optional further cut: the ElastiCache replica
(~$19/mo) — defensible since Redis is transport-only with no snapshots and
the outbox reconciles, but it is a real availability trade.

## Branch model

- `ai-agent` — development (local dev unchanged: `npm run dev*` etc.)
- `main` — integration; **CI only, deploys nothing** since staging was removed
  on 2026-08-18
- `production` — deploys **production** on push; promotion = fast-forward
  from `main`
- DigitalOcean deploy retired to manual `workflow_dispatch`
  ("Deploy to DigitalOcean (legacy)"); DO assets under `deploy/` untouched.
  The old droplet is still running but no longer serves the production
  domain — decommission is outstanding.

## Platform posture (do not change casually)

- **AI is ON in production** (operator-approved release 2026-08-03; see
  "Production AI release" above). `config.aiEnvironment` in
  `deploy/aws/lib/config.ts` carries the full local-dev-parity flag set
  (workspace, workflow, assistant, knowledge with deterministic embeddings,
  live OpenAI replies), and a conditional `ai-gateway` Fargate service runs
  the assistant's job worker. Deny-by-default is the platform's safe state —
  an environment with `aiEnvironment: {}` has every AI flag absent — but no
  environment is currently in it. Changing the flag set is a release per
  `docs/runbooks/PRODUCTION.md`, never part of an infra deploy.
  NOTE: a fresh environment ALSO needs the Postgres data foundation
  seeded or all AI endpoints 503 `ORGANIZATION_NOT_READY`: run
  `node dist/scripts/backfillPostgresProposalReferences.js --apply
  --organization-id=<mongo org id>` as a one-off ECS task using the
  **api** task definition (the migrate taskdef lacks MONGODB_URL).
  Production org: `6a703ea649ac55f3c2327b6e`.
  All AI surfaces were VERIFIED on the (now removed) staging env 2026-08-02: workspace conversation +
  live extraction/draft (real OpenAI, pinned model), candidate
  review/apply, five-step workflow, platform assistant, knowledge
  pipeline end-to-end (upload → scan → parse → review → approved
  release). Knowledge browser uploads need documents-bucket CORS
  (applied out-of-band + codified in data-stack.ts; add real admin
  origins before prod). Admin account exists (dxgrfptool+admin@gmail.com).
- **API runs one steady-state task with rolling overlap** (`100/200`) and
  `CRON_ENABLED=false`, keeping one healthy target throughout a deploy.
  Unlocked destructive cron jobs run in a separate singleton `cron` service
  that replaces stop-then-start. WebSocket fan-out is still process-local;
  add Redis pub/sub before steady-state horizontal API scaling.
- ClamAV fail-closed is intended behavior (vendor uploads 503 / sources
  `scan_failed` when the scanner is down).
- Redis is transport-only (no snapshots on purpose; outbox reconciles).

## 🚩 LAUNCH BLOCKER — restore redundancy before real users

`PRE_LAUNCH_REDUCED_REDUNDANCY` in `deploy/aws/lib/config.ts` is **true**
(set 2026-08-18). While it is true, production runs a **single-AZ** RDS
instance and a **replica-less** Redis, saving ~$61/month on redundancy that
protects nobody while there are no users. Durability is unaffected — 30-day
automated backups and deletion protection both remain on; this trades
AUTOMATIC failover for MANUAL restore.

**Set it to false and redeploy the Data stack before onboarding real users.**

Deploy notes, both directions:
- The Redis change is CloudFormation `Replacement: False` — safe in place.
- The RDS `MultiAZ` change is `Replacement: Conditional`. For PostgreSQL it
  is a documented no-interruption in-place modify (SQL Server is the engine
  that forces replacement), but CloudFormation will not guarantee it. **Take
  a manual RDS snapshot before deploying in either direction** — with
  `RemovalPolicy.RETAIN` a replacement would retain the old instance and
  silently point production at a NEW EMPTY database.
- Each direction causes a brief failover interruption. Schedule it.

## Next steps, in order

1. **Fix the two failing quality-gate tests** — `proposal field guidance
   covers the canonical form contract` and `schema field inventory digest
   detects unreviewed additions, removals, and renames`. CD has been red
   since 2026-08-12; nothing ships until they pass.
2. **Ship the pending migrations** — production is on `043`; `044`–`052` are
   committed and `053`–`058` are still uncommitted on the feature branch.
3. **Subscribe an email to the alarm topic** — redeploy Observability with
   `-c alertEmail=<address>`. Alarms currently fire into nothing.
4. **Decommission the DigitalOcean droplet** (68.183.227.9) and the old Atlas
   cluster — the grace period after the 2026-08-03 cutover has long passed.
5. **Delete the empty `staging` GitHub environment** — needs repo admin
   rights; everything else about staging is gone.
6. Smaller carryovers: redact AUTH args from ioredis error logs, scope the
   assets-bucket KMS key policy to the real CloudFront distribution ARN, and
   add the queue-backlog / outbox-age metrics probe.

## Completed milestones (historical notes)

> Kept for the gotchas embedded in them, not as a backlog. Every item below
> is done.


1. ~~**DNS + HTTPS**~~ — **DONE 2026-08-02.** `dxg-agency.com` DNS is on
   Namecheap. Staging API is `https://api-staging.dxg-agency.com` (verified:
   valid cert, 200 health, 301 redirect on port 80). The wildcard cert also
   covers future production/app/admin hostnames — reuse its ARN. For a new
   hostname: add the CNAME in Namecheap, set the env's GitHub variables,
   deploy. Gotcha fixed in `f846726`: the port-80 listener must keep the
   `Http` construct id when switching to the redirect (create-before-delete
   collides on the port otherwise).
2. ~~**Email decision**~~ — **DONE 2026-08-02: SES.** Domain identity
   `dxg-agency.com` verified (DKIM CNAMEs in Namecheap), sending works
   end-to-end (`/api/auth/send-otp` → SES → inbox). SMTP creds are an
   IAM user `rfpilot-staging-ses-smtp` (ses:Send* only); `SMTP_USER` is the
   new env key carrying the IAM SMTP username (emailService falls back to
   SMTP_MAIL without it). **Sandbox exit requested 2026-08-02, pending AWS
   review** — until approved, SES only delivers to verified identities
   (currently `dxgrfptool@gmail.com`, the project service address).
   INCIDENT LEARNED: `cdk deploy` implicitly deploys changed dependency
   stacks; a data-stack edit from CI reset the filled app secret to
   placeholders (restored via `update-secret-version-stage`). CI now
   deploys with `--exclusively`; never remove that flag.
3. ~~**Frontends**~~ — **ACCEPTANCE PASS DONE 2026-08-02** (dashboard run
   locally with `.env.local` → staging `BACKEND_URL` + staging
   `BFF_SHARED_SECRET`): signup → SES OTP → register (needed one-time Mongo
   seed: `node dist/scripts/migrateDxgOrganization.js --apply` as a one-off
   ECS task using the **api** task definition — the migrate taskdef has no
   MONGODB_URL) → dashboard → proposal intake (auto-save) → file upload to
   S3 assets bucket via task-role creds → submit/publish → email campaign
   sent via SES (1 SENT, tracking live) → public RFP page renders. AI
   gates verified OFF (assisted workspace + five-step workflow correctly
   refuse). Admin app not yet exercised. Test account:
   dxgrfptool@gmail.com (staging).
4. **Production promotion** (when staging has been exercised):
   `git checkout production && git merge --ff-only main && git push` after
   first deploying `Rfpilot-production-Network/Data`, running
   `scripts/compose-app-secrets.sh production`, filling external keys in
   `rfpilot/production/app`, allowlisting the production NAT EIP in Atlas
   (ideally switch to PrivateLink, M10+), and setting the GitHub
   `production` environment (protection rules recommended). Prod sizing
   (Multi-AZ RDS, Redis replica, deletion protection) is already in
   `lib/config.ts`.
5. ~~**DO → S3 data migration**~~ — **NOT NEEDED (decision 2026-08-03):
   production starts FRESH.** Travis chose not to carry over the old user
   data or DO Spaces objects. Production's `dxg_rfp_tool_prod` database is
   seeded and empty of legacy data by design. `ASSET_STORAGE_PUBLIC_URL_BASE`
   is wired per env (CloudFront domains); `scripts/migrateAssetUrls.ts`
   exists as tooling but is unused. Cutover is now ONLY: (a) SES
   production-access approval (pending AWS review — the hard gate), then
   (b) Namecheap CNAME `api` → the prod ALB. Keep the droplet + old Atlas
   cluster untouched for a grace period as a data archive before
   decommissioning.

## Deferred/known items

- ~~**`OBSERVABILITY_ENABLED=true`**~~ — **SHIPPED.** Verified live
  2026-08-18: production `/health` reports `observability.enabled: true`, so
  `safeLog` no longer returns early and failures are traceable by correlation
  id. `OTEL_EXPORTER_OTLP_ENDPOINT`
  stays deliberately unset because no collector sidecar exists in these task
  definitions; `config/observability.ts` now skips the exporter entirely when
  no endpoint is configured (with the old localhost default it opened ~3
  doomed connections/second). `TELEMETRY_PSEUDONYM_KEY` was added to the
  migrate task's secrets: it shares `sharedEnvironment`, and `safeTelemetry`
  throws on import without that key in production. Set the endpoint if a
  collector is ever added.
- Queue-backlog + outbox-age CloudWatch metrics probe (scheduled task) —
  worker/dispatcher have no health port; today's signal is RunningTaskCount
  alarms + PG heartbeat queries (see README "Operational notes").
- ioredis error logs can include AUTH command args — redact (the exposed
  token from the first deploy was rotated and is dead).
- Scope the assets-bucket KMS key policy to the real CloudFront
  distribution ARN (acknowledged `wildcardKeyPolicyForOac`).
- Post-launch: alarms have no email subscription yet — redeploy
  Observability with `-c alertEmail=...`.
- `.env.example` documents the new `ASSET_STORAGE_*`, `CRON_ENABLED`, and
  RDS `NODE_EXTRA_CA_CERTS` conventions.

## Gotchas already learned (don't rediscover)

RDS API rejects non-ASCII in descriptions · new accounts on the Free plan
block RDS features (upgrade first) · RETAIN'd buckets orphan on stack
rollback and collide on retry (empty + delete, then redeploy) · first ECS
cluster in an account can race service-linked-role creation (retry) ·
GitHub environment-bound jobs present `environment:`-form OIDC sub claims ·
`ecs:*TaskDefinition` actions can't be cluster-scoped · trivy-action tags
are v-prefixed · the dispatcher and Redis-URL-encoding bugs are fixed in
code (commits `ae5a769`, `74edc90`).
