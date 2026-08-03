# Backend Operations Documentation

> Developer operations portal for the RFPilot backend on AWS. Last verified
> against the live infrastructure: 2026-08-03. Everything documented here was
> reverse-engineered from the actual deployed system — resource names, log
> groups, and commands are real.

**New here?** Read this page, then [Architecture](architecture.md), then
[Environments](environments.md). That answers "what runs where." When you need
to ship, read [Deployment](deployment.md). When something breaks, go straight
to [Troubleshooting](troubleshooting.md) or [Incident Response](incident-response.md).

## Navigation

| | Page | Answers |
|---|---|---|
| 🏗 | [Architecture](architecture.md) | What is our production architecture? |
| ☁️ | [AWS Infrastructure](aws-infrastructure.md) | What AWS services do we use, and what are they named? |
| 🌎 | [Environments](environments.md) | What is staging vs production? |
| 🚀 | [Deployment](deployment.md) | How does a change reach production? |
| 🔄 | [CI/CD](cicd.md) | What exactly does the pipeline do, and where do I look when it fails? |
| ⚙️ | [Services](services.md) | What processes run, on what ports, with what dependencies? |
| 📊 | [Monitoring](monitoring.md) | Where are the logs, metrics, and alarms? |
| 🐛 | [Troubleshooting](troubleshooting.md) | How do I debug a 500 / 502 / connection failure? |
| ↩️ | [Rollback](rollback.md) | How do I undo a bad deployment? |
| 🗄 | [Database Migrations](database-migrations.md) | How do schema changes ship safely? |
| 🔐 | [Secrets & Configuration](secrets.md) | Where do secrets live and how do apps get them? |
| 👨‍💻 | [Developer Access](developer-access.md) | How do I get access to AWS, logs, and databases? |
| 🚨 | [Incident Response](incident-response.md) | What do I do *right now* during an outage? |

## The one-paragraph version

The backend is a Node.js 20 / Express monolith compiled to one Docker image
with multiple entrypoints (API, durable worker, outbox dispatcher, AI
gateway). It runs on **ECS Fargate** in **us-east-2** (AWS account
`295229565954`) behind an **ALB** with a **WAF**, in two fully separate
environments — `staging` and `production` — each with its own VPC, RDS
PostgreSQL 16, ElastiCache Redis, S3 buckets, CloudFront asset CDN, and
Secrets Manager secret. MongoDB is external (Atlas, one shared cluster, one
database per environment). Everything is **CDK TypeScript**
(`deploy/aws/lib/`), and deployment is **GitHub Actions via OIDC**: push to
`main` deploys staging, fast-forward `production` deploys production. Public
entry points: `https://api.dxg-agency.com` (production) and
`https://api-staging.dxg-agency.com` (staging).

## Browsing these docs as a website

A MkDocs (Material) site is configured over the whole `docs/` tree — sidebar
navigation, full-text search, and rendered Mermaid diagrams:

```bash
pip3 install -r requirements-docs.txt   # once
python3 -m mkdocs serve -a 127.0.0.1:8001
# open http://127.0.0.1:8001
```

`python3 -m mkdocs build` produces a static `site/` folder (gitignored) you
can host anywhere. Reading the Markdown directly on GitHub works equally
well — all links resolve in both renderers.

## Companion documents elsewhere in the repo

- [`deploy/aws/README.md`](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/blob/main/deploy/aws/README.md) — the CDK operator
  runbook (bootstrap, secret rotation, backups, cost levers).
- [`deploy/aws/STATE.md`](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/blob/main/deploy/aws/STATE.md) — the running handoff
  log: what is live, decisions made, and gotchas learned (read before any
  infra work).
- [`docs/runbooks/`](../runbooks/) — AI-feature runbooks (assistant rollout,
  durable jobs, knowledge retrieval, retention).
- [`docs/README.md`](../README.md) — the wider documentation map (product,
  AI layer, architecture decisions).
