# Environments: Staging vs Production

> Two fully separate environments in the same AWS account and region. Same
> code, same stacks, different sizing, data, and secrets. Verified 2026-08-03.

## Comparison

| Area | Staging | Production |
|---|---|---|
| API URL | `https://api-staging.dxg-agency.com` | `https://api.dxg-agency.com` |
| Deployed from branch | `main` (every push) | `production` (fast-forward promotion) |
| AWS region | us-east-2 | us-east-2 |
| VPC | 10.40.0.0/16 | 10.41.0.0/16 |
| ECS cluster | `rfpilot-staging` | `rfpilot-production` |
| API task size | 0.5 vCPU / 1 GB | 1 vCPU / 2 GB |
| Worker autoscale max | 2 | 4 |
| RDS | t4g.small, single-AZ, 20 GB, 7d backups, **no** deletion protection | t4g.medium, **Multi-AZ**, 50 GB, 30d backups, **deletion-protected**, stack termination-protected |
| Redis | cache.t4g.micro, no replica | cache.t4g.small, **1 replica** |
| MongoDB | Atlas shared cluster, db `dxg_rfp_tool_staging` | same cluster, db `dxg_rfp_tool_prod` |
| NAT egress IP (Atlas allowlist) | 18.223.236.137 | 13.58.171.171 |
| Asset CDN | d3bje2jgtaou7s.cloudfront.net | d1hn23mh1h53mx.cloudfront.net |
| Secrets | `rfpilot/staging/app` | `rfpilot/production/app` — **every value independent** (JWT, BFF, SMTP creds, etc.) |
| AI surface | Full (all flags, `AI_ENVIRONMENT=staging`) | Full parity (`AI_ENVIRONMENT=production`) since 2026-08-03 |
| Log groups | `/rfpilot/staging/*` | `/rfpilot/production/*` |
| Alarms | `rfpilot-staging-*` | `rfpilot-production-*` |
| GitHub environment (vars) | `staging` | `production` |
| Deploy role (OIDC) | `rfpilot-staging-github-deploy`, only from `main` | `rfpilot-production-github-deploy`, only from `production` |
| CDK config block | `ENVIRONMENTS.staging` in [`lib/config.ts`](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/blob/main/deploy/aws/lib/config.ts) | `ENVIRONMENTS.production` |

Both environments currently run the same AI flag set (live OpenAI replies,
mock/deterministic providers for extraction and knowledge embeddings,
retention purge off). The flag maps live in `config.ts` under
`aiEnvironment` — **changing them is a governed release, not a config
tweak**; see `docs/runbooks/PRODUCTION.md`.

## What staging is for

Staging is the place to break things. Safe there:

- Every code change (every push to `main` deploys it automatically).
- Infra experiments (Network/Data changes — deploy manually, never via CI).
- AI flag changes, provider experiments, load tests (mind the shared Atlas
  cluster and the shared OpenAI key — heavy tests cost real money and real
  rate-limit headroom).
- Destructive data operations: the staging Mongo db and Postgres contain
  only test data and can be re-seeded (see below).

## What must never happen in production

- **Never redeploy `Rfpilot-production-Data` casually.** Its secret template
  (`secretObjectValue`) resets every operator-filled secret to `REPLACE_ME`
  if that resource's properties changed. If you must deploy it: verify the
  diff touches only what you intend, and re-validate the secret after.
  (This wiped the staging secret once — recovery is
  `aws secretsmanager update-secret-version-stage ... --move-to-version-id <previous>`.)
- **Never remove `--exclusively` from the CI `cdk deploy`.** It is the guard
  that prevents CI from implicitly deploying Data/Network stacks.
- **Never scale the API above 1 task** without first setting
  `CRON_ENABLED=false` on the extra replicas and adding Redis pub/sub
  notification fan-out (crons are unlocked-destructive; WebSocket fan-out is
  process-local).
- **Never run ad-hoc writes against the prod Mongo/Postgres** outside the
  established one-off task scripts (which are journaled/idempotent).
- **Never disable the ClamAV fail-closed behavior** — uploads 503ing while
  the scanner is down is intended.
- Don't "clean up" Namecheap DNS records: the ACM validation CNAME and DKIM
  records are permanent infrastructure.

## Bootstrapping and re-seeding environment data

A fresh (or wiped) environment needs, in order — all as one-off ECS tasks
using the **api** task definition (the `migrate` task definition has only
Postgres secrets, no `MONGODB_URL`):

1. Postgres migrations — normally CI's migrate step; manual equivalent in
   [`deploy/aws/README.md`](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/blob/main/deploy/aws/README.md).
2. Default organization seed:
   `node dist/scripts/migrateDxgOrganization.js --apply`
3. Postgres data-foundation backfill:
   `node dist/scripts/backfillPostgresProposalReferences.js --apply --organization-id=<mongo org id>`
   ⚠️ **Read the JSON report in the task's log — exit code 0 alone is not
   proof it wrote rows** (a pre-migration run once "succeeded" while writing
   nothing, and all AI endpoints returned 503 `ORGANIZATION_NOT_READY`).

Current org ids: staging `6a702a3bddeeb64bbe9fcce4`, production
`6a703ea649ac55f3c2327b6e`. Run-task command templates are in
[Services → one-off tasks](services.md#one-off-tasks).
