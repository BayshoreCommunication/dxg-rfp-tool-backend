# AWS deployment — current state and handoff

> Status as of 2026-08-02. Owner: Travis (Bayshore). This file is the
> single place to read before continuing AWS work in a new session.
> Operating docs: [README.md](README.md) (bootstrap/deploy/rollback runbook).
> No secrets in this file — all secret values live in AWS Secrets Manager.

## What is live

**Staging is deployed, healthy, and continuously delivered.**

| Fact | Value |
|---|---|
| AWS account | `295229565954` (IAM user `aidev`, local CLI profile `rfpilot`) |
| Region | `us-east-2` |
| Staging API | `https://api-staging.dxg-agency.com` (HTTPS, 80→443 redirect; CNAME in Namecheap → ALB `Rfpilo-Alb16-0eZHo0YAZQnj-2062746735.us-east-2.elb.amazonaws.com`) |
| TLS cert | ACM wildcard `*.dxg-agency.com` + apex, us-east-2, `.../f6976da6-0174-40b4-86bc-9525267a8b08` (DNS-validated; validation CNAME lives in Namecheap — do not delete it, ACM renews through it) |
| Health | `GET /health` → 200 OK; Mongo connected, Postgres migrated to `043`, Redis queue ready |
| ECS cluster | `rfpilot-staging` — services `api`(1), `worker`(1), `dispatcher`(1), `clamav`(1) |
| Assets CDN | `d3bje2jgtaou7s.cloudfront.net` (fronts `rfpilot-staging-assets-*` bucket) |
| NAT egress IP | `18.223.236.137` (allowlisted in Atlas Network Access) |
| MongoDB | New Atlas account/cluster (connection string in the app secret) |
| ECR | `295229565954.dkr.ecr.us-east-2.amazonaws.com/rfpilot-backend`, immutable `sha-<commit>` tags |
| Secrets | `rfpilot/staging/app` (all keys filled), `rfpilot/staging/redis-auth` (rotated, alphanumeric) |

**CI/CD**: push to `main` → `.github/workflows/deploy-aws.yml` runs quality
gates → image build → Trivy scan (currently ZERO findings) → ECR push →
one-off Postgres migration task (new image, before services roll) → CDK
deploy of App+Observability → smoke checks. Auth is GitHub OIDC only
(branch/environment-locked roles, no stored AWS keys). Domain/cert/URL CDK
contexts flow from environment-scoped GitHub variables (`CERTIFICATE_ARN`,
`API_DOMAIN` set on `staging`; `FRONTEND_URL`/`ADMIN_URL` reserved, empty =
unset). Last fully green run: `30733670506`, deployed image `sha-f846726...`.
Doc-only pushes do not deploy (`paths-ignore`).

**Stacks deployed**: `Rfpilot-Cicd`, `Rfpilot-staging-Network`,
`Rfpilot-staging-Data`, `Rfpilot-staging-App`,
`Rfpilot-staging-Observability`. Production stacks exist in code but are
NOT deployed.

## Branch model

- `ai-agent` — development (local dev unchanged: `npm run dev*` etc.)
- `main` — deploys **staging** on push
- `production` — deploys **production** on push; currently at `f66f60a`
  (pre-AWS), promotion = fast-forward to `main` when ready
- DigitalOcean deploy retired to manual `workflow_dispatch`
  ("Deploy to DigitalOcean (legacy)"); DO assets under `deploy/` untouched.
  The old droplet is still running and serves the current production domain.

## Platform posture (do not change casually)

- **AI on staging is ON as of 2026-08-02** (operator-approved release):
  `config.aiEnvironment` in `deploy/aws/lib/config.ts` carries the full
  local-dev-parity flag set (workspace, workflow, assistant, knowledge
  with deterministic embeddings, live OpenAI replies), and a conditional
  `ai-gateway` Fargate service runs the assistant's job worker.
  **Production's `aiEnvironment` is `{}` — every AI flag absent,
  deny-by-default** — and enabling it there is a separate release per
  `docs/runbooks/PRODUCTION.md`, never part of an infra deploy.
  NOTE: a fresh environment ALSO needs the Postgres data foundation
  seeded or all AI endpoints 503 `ORGANIZATION_NOT_READY`: run
  `node dist/scripts/backfillPostgresProposalReferences.js --apply
  --organization-id=<mongo org id>` as a one-off ECS task using the
  **api** task definition (the migrate taskdef lacks MONGODB_URL).
  Staging org: `6a6ef9d1a85e65f5a53ca10c` (slug `dxg`).
  All AI surfaces VERIFIED on staging 2026-08-02: workspace conversation +
  live extraction/draft (real OpenAI, pinned model), candidate
  review/apply, five-step workflow, platform assistant, knowledge
  pipeline end-to-end (upload → scan → parse → review → approved
  release). Knowledge browser uploads need documents-bucket CORS
  (applied out-of-band + codified in data-stack.ts; add real admin
  origins before prod). Admin account exists (dxgrfptool+admin@gmail.com).
- **API runs exactly 1 task** (stop-then-start deploys, ~30–60s window):
  its cron jobs are unlocked-destructive and WebSocket fan-out is
  process-local. Before scaling: set `CRON_ENABLED=false` on extra
  replicas and add Redis pub/sub notification fan-out.
- ClamAV fail-closed is intended behavior (vendor uploads 503 / sources
  `scan_failed` when the scanner is down).
- Redis is transport-only (no snapshots on purpose; outbox reconciles).

## Next steps, in order

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
5. **DO → S3 data migration** (separate task): copy existing Spaces objects
   into the assets bucket and deal with absolute Spaces URLs persisted in
   Mongo documents; then set `ASSET_STORAGE_PUBLIC_URL_BASE` to the CDN and
   decommission the droplet + DO assets.

## Deferred/known items

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
