# Environment: Production

> Production is the **only** environment. A separate staging environment ran
> in the same AWS account until 2026-08-18, when it was removed; see
> [`deploy/aws/STATE.md`](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/blob/main/deploy/aws/STATE.md)
> for what was deleted and how to recreate one. Verified 2026-08-18.

## Facts

| Area | Production |
|---|---|
| API URL | `https://api.dxg-agency.com` |
| Deployed from branch | `production` (fast-forward promotion from `main`) |
| AWS account / region | 295229565954 / us-east-2 |
| VPC | 10.41.0.0/16 |
| ECS cluster | `rfpilot-production` — `api`, `worker`, `dispatcher`, `cron`, `clamav`, `ai-gateway` |
| API task size | 1 vCPU / 2 GB |
| Worker autoscale max | 4 |
| RDS | t4g.medium, **Multi-AZ**, 50 GB, 30d backups, **deletion-protected**, stack termination-protected |
| Redis | cache.t4g.small, **1 replica** |
| MongoDB | Atlas, db `dxg_rfp_tool_prod` |
| NAT egress IP (Atlas allowlist) | 13.58.171.171 |
| Asset CDN | d1hn23mh1h53mx.cloudfront.net |
| Secrets | `rfpilot/production/app`, `rfpilot/production/redis-auth` |
| AI surface | Full (`AI_ENVIRONMENT=production`) since 2026-08-03 |
| Log groups | `/rfpilot/production/*` |
| Alarms | `rfpilot-production-*` |
| GitHub environment (vars) | `production` |
| Deploy role (OIDC) | `rfpilot-production-github-deploy`, only from `production` |
| CDK config block | `ENVIRONMENTS.production` in [`lib/config.ts`](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/blob/main/deploy/aws/lib/config.ts) |

The AI flag set (live OpenAI replies, mock/deterministic providers for
extraction and knowledge embeddings, retention purge off) lives in `config.ts`
under `aiEnvironment` — **changing it is a governed release, not a config
tweak**; see `docs/runbooks/PRODUCTION.md`.

## No staging safety net

With staging gone, there is no environment where breaking things is free.
Consequences worth planning around:

- `main` runs CI only and deploys nothing. Nothing exercises a change against
  real AWS infrastructure before it reaches production.
- Infra experiments (Network/Data changes) now rehearse only through
  `cdk diff` / `cdk synth`. Read the diff carefully — it is the whole review.
- Load tests, AI provider experiments and destructive data operations have no
  safe target. Stand a temporary environment back up rather than trying them
  in production.
- The pre-deploy gate is the quality suite plus the pipeline's own health
  probing during rollout; keep both green rather than relying on a soak.

## What must never happen in production

- **Never redeploy `Rfpilot-production-Data` casually.** Its secret template
  (`secretObjectValue`) resets every operator-filled secret to `REPLACE_ME`
  if that resource's properties changed. If you must deploy it: verify the
  diff touches only what you intend, and re-validate the secret after.
  (This wiped the old staging secret once — recovery is
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

Production org id: `6a703ea649ac55f3c2327b6e`. Run-task command templates are
in [Services → one-off tasks](services.md#one-off-tasks).
