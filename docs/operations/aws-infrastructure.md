# AWS Services Inventory

> Account `295229565954`, region `us-east-2` for everything. Local CLI
> profile: `rfpilot`. All infrastructure is CDK TypeScript in
> [`deploy/aws/`](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/tree/main/deploy/aws/) — five stacks per the table in
> [`deploy/aws/README.md`](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/blob/main/deploy/aws/README.md). Verified 2026-08-03.

| AWS Service | Purpose | Environment | Important resources | How to access | Monitoring |
|---|---|---|---|---|---|
| **ECS (Fargate)** | Runs every backend process | production | Cluster `rfpilot-production`; services `api`, `worker`, `dispatcher`, `clamav`, `ai-gateway`; task family `rfpilot-production-migrate` | Console → ECS → Clusters, or `aws ecs describe-services --cluster rfpilot-production --services api ...` | RunningTaskCount/CPU/memory alarms; Container Insights |
| **ECR** | Docker image registry | shared | Repo `rfpilot-backend` (`295229565954.dkr.ecr.us-east-2.amazonaws.com/rfpilot-backend`), **immutable** `sha-<git-sha>` tags, lifecycle: untagged expire 14d, keep last 50 | Console → ECR, or `aws ecr describe-images --repository-name rfpilot-backend` | Scan-on-push enabled |
| **ALB** | HTTPS entry, health checks | production | `Rfpilo-Alb16-pj5OOUBQqRrt-519967115...` (get current: App stack output `AlbDnsName`) | Console → EC2 → Load Balancers | `rfpilot-production-api-5xx` alarm; ALB metrics |
| **WAF** | Managed common rule set on the ALB | production | Web ACL `rfpilot-production-waf` (REGIONAL) | Console → WAF & Shield → us-east-2 | Sampled requests + CloudWatch metrics enabled |
| **RDS (PostgreSQL 16)** | AI domain: runs, evidence, knowledge, outbox, audit (pgvector, RLS) | production | t4g.medium **Multi-AZ, deletion-protected**; db name `rfpilot`, user `rfpilot_admin` | Endpoint in Data stack output `DatabaseEndpoint`; no public access — connect from a task or bastion-less via one-off task | CPU / free-storage / connection alarms; automated backups 30d |
| **ElastiCache (Redis)** | BullMQ queues, rate limits — transport-only, **no snapshots by design** | production | cache.t4g.small, 1 replica. TLS + AUTH required (`rediss://`) | Endpoint in Data stack output `RedisPrimaryEndpoint` | EngineCPU / memory alarms |
| **S3** | Private file storage | production | `rfpilot-production-assets-295229565954` (app assets; CORS PUT for localhost:3000/3001), `rfpilot-production-documents-295229565954` (knowledge/vendor docs, quarantine prefix). SSE-KMS, Block Public Access, versioned (noncurrent expire 30d) | Console → S3, or `aws s3 ls s3://rfpilot-production-assets-295229565954` | — |
| **CloudFront** | Public URLs for assets (buckets are private; OAC) | production | `d1hn23mh1h53mx.cloudfront.net` (= `ASSET_STORAGE_PUBLIC_URL_BASE`) | Console → CloudFront | — |
| **Secrets Manager** | All application secrets | production | `rfpilot/production/app` (17 keys), `rfpilot/production/redis-auth`, RDS-generated master secret | See [Secrets](secrets.md) | — |
| **ACM** | TLS certificate | shared | Wildcard `*.dxg-agency.com` + apex, arn `...certificate/f6976da6-0174-40b4-86bc-9525267a8b08`. DNS-validated — the validation CNAME in Namecheap is **permanent** (renewal depends on it) | Console → Certificate Manager (us-east-2) | Expires Feb 2027; auto-renews via DNS |
| **CloudWatch** | Logs, metrics, alarms | production | Log groups `/rfpilot/production/{api,worker,dispatcher,clamav,migrate,aigateway}`; ~19 alarms; Container Insights | See [Monitoring](monitoring.md) | SNS topic `rfpilot-production-alerts` (⚠️ no email subscription yet — pass `-c alertEmail=` on an Observability deploy) |
| **SNS** | Alarm fan-out | production | Topic `rfpilot-production-alerts` | Console → SNS | — |
| **IAM** | OIDC deploy roles, task roles, SES SMTP users | shared | `rfpilot-production-github-deploy` (OIDC, branch-locked), `rfpilot-production-ses-smtp` (ses:Send* only), user `aidev` (operator) | Console → IAM | — |
| **SES** | Transactional email (SMTP) | shared | Domain identity `dxg-agency.com` (Easy DKIM), endpoint `email-smtp.us-east-2.amazonaws.com:587`. ⚠️ **Still in sandbox** — delivers only to verified identities until production access is granted (on hold pending real domain purchase) | Console → SES (us-east-2) | Suppression list on (bounce+complaint); send quota 200/day in sandbox |
| **VPC** | Network isolation | production | `10.41.0.0/16`; NAT EIP `13.58.171.171` (Atlas allowlist); endpoints for S3/ECR/Logs/Secrets | Console → VPC | Flow logs (REJECT) to CloudWatch |
| **KMS** | Bucket encryption keys | production | Data-stack key (note open item: assets-key policy still uses the acknowledged OAC wildcard) | Console → KMS | — |
| **CloudFormation/CDK** | All of the above as code | production | Stacks `Rfpilot-Cicd`, `Rfpilot-production-{Network,Data,App,Observability}` | `cd deploy/aws && npx cdk list -c env=production` | Stack events during deploys |

## External (non-AWS) services

| Service | Purpose | Notes |
|---|---|---|
| **MongoDB Atlas** | Authoritative product data (proposals, users, orgs, emails) | Database `dxg_rfp_tool_prod` (`MONGODB_DB_NAME`). Network access = NAT EIP allowlist. Consider M10+ before heavy load. |
| **OpenAI** | Live AI (extraction, drafts, conversations, assistant) | Model pinned: `gpt-5.4-mini-2026-03-17` (`LIVE_AI_MODEL`). Changing it requires the gold evaluation (`docs/testing/GOLD_EVALUATION.md`). Same API key both envs (splitting is a known improvement). |
| **Namecheap** | DNS for dxg-agency.com | `api` → prod ALB, ACM validation CNAME (permanent), 3 SES DKIM CNAMEs. The `api-staging` record was retired with the staging environment on 2026-08-18. ⚠️ dxg-agency.com is an interim domain — a future product-domain swap is expected. |
| **GitHub** | Repo + Actions CI/CD | `BayshoreCommunication/dxg-rfp-tool-backend`; environment-scoped variables carry domain/cert config. |

## Not used (so you don't go looking)

EC2 instances, EKS, Lambda, SQS/SNS-as-bus (the outbox+Redis pattern covers
it), API Gateway, Route 53 (DNS is Namecheap), Parameter Store (Secrets
Manager only), Elastic Beanstalk, DocumentDB (evaluated and disqualified —
see `docs/DECISIONS.md`).
