# Developer Access Guide

> What you need, per task. Never share or commit credentials; access is
> granted per person by the account owner (Travis / Bayshore).

## AWS

- Account `295229565954`, region `us-east-2`.
- Today's model: a single operator IAM user (`aidev`) whose credentials are
  configured locally as the CLI profile **`rfpilot`**
  (`aws configure --profile rfpilot`). New developers: ask the account
  owner to create you an IAM user (console + programmatic) — least
  privilege for most work is read-only ECS/CloudWatch/RDS/ElastiCache plus
  Secrets Manager read on `rfpilot/*` if you operate secrets.
  *Needs verification: a per-developer role/SSO model is a sensible future
  hardening; nothing like that exists yet.*
- Verify access: `AWS_PROFILE=rfpilot aws sts get-caller-identity`.

## What you can and can't shell into

- **There is no SSH anywhere** — no EC2 instances exist.
- **ECS Exec is not enabled** on the services (deliberate). To run code
  "inside" the environment, use the one-off task pattern
  ([Services → one-off tasks](services.md#one-off-tasks)); to inspect a
  running container's behavior, use its CloudWatch logs.

## Logs

CloudWatch Logs, groups `/rfpilot/<env>/*` — console or
`aws logs tail /rfpilot/<env>/api --follow --profile rfpilot`.
Read access to CloudWatch is the single most useful permission for
debugging; ask for it first.

## Databases

- **Postgres (RDS):** not publicly reachable; no bastion exists. Options:
  (a) read replicas of truth via the app's health/report endpoints,
  (b) SQL through a one-off ECS task override (script or `psql` isn't in
  the image — write a small script), or (c) ask the operator to run the
  query. *Needs verification: if regular SQL access becomes necessary,
  add a bastion/SSM tunnel deliberately rather than opening the SG.*
- **MongoDB (Atlas):** access via the Atlas console (org owner invites
  you). Programmatic access from your laptop requires your IP added to the
  Atlas Network Access allowlist — remember to remove it after. Databases:
  `dxg_rfp_tool_staging`, `dxg_rfp_tool_prod` on the shared cluster.
- **Redis:** in-VPC only, AUTH + TLS. There is essentially never a reason
  to connect manually (transport-only queues); use the Postgres job tables
  instead.

## CI/CD

- GitHub repo `BayshoreCommunication/dxg-rfp-tool-backend` — org membership
  with write access lets you push `main` (= deploy staging). Pushing
  `production` deploys production; treat that as an operator action.
- GitHub *environments* (`staging`, `production`) hold the deploy variables;
  repo admins can edit them (Settings → Environments).
- `gh` CLI is the fastest way to watch runs: `gh run list`, `gh run watch`.

## Frontends / email accounts (context)

- Vercel account (dashboard hosting): owned by Travis.
- Test/service inboxes: `dxgrfptool@gmail.com` (+`+admin`, `+prodadmin`
  variants) — SES-verified sandbox recipients.

## Access checklist for a new backend developer

1. GitHub org membership + repo write.
2. AWS IAM user (or shared operator profile, per team policy) → configure
   as `AWS_PROFILE=rfpilot`.
3. CloudWatch Logs read (minimum) — verify:
   `aws logs tail /rfpilot/staging/api --profile rfpilot`.
4. Atlas console invite (read-only to start).
5. Local dev: clone, `npm ci`, copy `.env.example` → `.env`, run per
   [`docs/DEVELOPMENT.md`](../DEVELOPMENT.md).
