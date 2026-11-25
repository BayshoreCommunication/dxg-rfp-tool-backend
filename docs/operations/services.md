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
 ├── Size: 0.5 vCPU/2GB
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
│            candidate_application, proposal_draft_generate,
│            vendor_response_analyze, conversation_chat
 ├── Command: node dist/scripts/startDurableWorker.js
 ├── Size: 0.5 vCPU/2GB · autoscales 1→4 at 70% CPU
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
 │   (production does). Uses the dispatcher's SG and sizing (0.25 vCPU/0.5GB).
 │   No tasks-low alarm covers it — check it in the ECS console.
 └── Logs: /rfpilot/<env>/aigateway   ← note: no hyphen in the log group

clamav
 ├── Purpose: malware scanning for every uploaded file (fail-closed:
 │            scanner down ⇒ vendor uploads 503, sources → scan_failed; intended)
 ├── Image: clamav/clamav:1.4 (public), NOT the app image
 ├── Port: 3310, reachable only from api and worker via ECS Service Connect
 │         (CLAMAV_HOST=clamav, CLAMAV_PORT=3310)
 ├── Size: 0.5 vCPU/3GB (signature DB is RAM-hungry) · first boot downloads
 │         ~300MB signatures — health check allows 5 minutes
 └── Logs: /rfpilot/<env>/clamav

cron
 ├── Purpose: scheduled jobs as their own service
 ├── Count: 0 before launch (crons currently run inside api)
 └── Logs: /rfpilot/<env>/cron (empty while at 0)

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
ENV=production   # the only environment

# Service status at a glance
aws ecs describe-services --cluster rfpilot-$ENV \
  --services api worker dispatcher clamav ai-gateway cron \
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
| `purgeTestAccounts.js --domain=<domain>` / `--emails=<a>,<b>` | List accounts on a domain / remove test sign-ups (accounts, and organizations whose every member is removed) so they can sign up fresh. Refuses organizations with RFPs or whose Owner leaves others behind. Leaves audit events and Postgres rows |
| `purgeTestAccounts.js --emails=<a>,<b> --with-content` | The same, and everything those accounts own: see "Purging test accounts with their content" below. **Irreversible** |

### Purging test accounts with their content

`purgeTestAccounts.js --emails=<a>,<b> --with-content` removes the accounts **and
what they own**. Without the flag the script is unchanged: accounts only, and
proposals are left where they are.

It is **irreversible**. Production MongoDB has **no backup** other than a
`mongodump` an operator runs: take one first and check that it can be read.
PostgreSQL has its 7-day automated backups, but this tool deletes no row there.

Do **not** run `scripts/purgeOldProposals.ts` instead. It is a different script
with a known defect, and it removes none of what hangs off a proposal.

Procedure, always in this order:

1. Take the MongoDB backup (`mongodump`).
2. Dry run (no `--apply`). It reads MongoDB, and the proposals' source
   documents in PostgreSQL inside a read-only transaction. It writes nothing
   and makes no storage call.
   `node dist/scripts/purgeTestAccounts.js --emails=<a>,<b> --with-content`
3. Read the report in the task log. Per account it lists the email, its
   organizations, the ids of its proposals and a count per collection. Check
   the proposal count against what you expect and that `refused` is empty.
   The dry run never sets the product's purge marker on a proposal.
4. Apply with the same emails:
   `node dist/scripts/purgeTestAccounts.js --emails=<a>,<b> --with-content --apply`
5. Read the report: `mode` must be `applied` and
   `ownerCheck.newlyWithoutActiveOwner` empty. The exit code is 1 for
   `refused` and `failed`.

It runs on the API task definition like the other scripts (application
PostgreSQL role, the task's storage permissions). It does not need the
migration role.

What it does, per account:

- **Proposals** the account owns, in every organization: archived, then
  permanently deleted through the same functions as the product's own routes,
  as the owner. The product marks the proposal as being deleted, deletes its
  private source documents from storage, tombstones `document_sources`
  (through `deletion_pending`), archives the conversation, writes a
  `proposal_artifacts_purged` audit event and deletes the proposal.
- **What the product leaves behind** when it deletes a proposal, removed here:
  vendor responses, submissions, submission versions, drafts, confirmation
  deliveries, questionnaire versions, public access grants, canonical
  snapshots, status transitions, shares and email campaigns of that proposal.
- **The account's own content**: email campaigns it sent, its personal
  templates, the support tickets it opened with every message and attachment,
  and the attachments' stored files.
- **The account**, as without the flag.

What stays, and why:

| Stays | Why |
|---|---|
| PostgreSQL `rfpilot.users`, `rfpilot.proposal_references`, AI runs, evidence, `audit_events` | Immutable by design and keyed by MongoDB ids, never by email. The product's own delete leaves the same rows |
| MongoDB security audit events, support access grants | Append-only history |
| Files in the public asset bucket (proposal uploads, vendor documents) | The product does not delete them either |
| Invitations the account sent, vendor-list entries, teams and organization templates it created | They belong to the organization; other members use them |
| Another member's notification about a deleted proposal | It is theirs |
| A staff account with the same email | The `admins` collection is never read or written |

Safety rules:

- Only proposals **owned** by a listed account are deleted. A proposal a listed
  account can merely see or edit (shared, team, organization role) stays.
- The whole run is refused, with nothing deleted, when: an account is in a
  legacy holding organization, an Owner would leave members behind, a proposal
  has no organization, PostgreSQL is off or the organization is not active
  there (the private source documents could not be purged), or a proposal has
  a private source document the product does not delete: one under legal hold
  or unexpired retention, or one whose upload `expired`. The report names the
  proposals.
- If anything fails for one proposal or one stored file, the run stops there,
  removes no account and reports the proposal. Run the same command again:
  what is already gone is skipped.
- The product deletes a proposal even when storage refused one of its source
  documents. The run then stops with `failed`, step `artifact purge`, the
  proposal id, the purge's error code and its source counts. Those documents
  stay `deletion_pending` and the product's daily reconciler finishes them;
  this tool does not, because the proposal is no longer in MongoDB.
- An account is removed only when it owns no proposal.
- A second apply with the same emails reports `nothing-found`.

Retained PostgreSQL rows of an account purged from the shared `dxg`
organization are counted by `verify:customer-organizations`
(`noCustomerRecordsInSharedOrganization`) as customer leftovers, because the
migration finds customers through their MongoDB user and these no longer have
one. Expect that check to name them after a purge.
