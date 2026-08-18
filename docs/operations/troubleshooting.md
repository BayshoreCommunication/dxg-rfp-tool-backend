# Production Debugging Runbook

> Follow top to bottom during an incident. Commands assume
> `export AWS_PROFILE=rfpilot AWS_REGION=us-east-2` and `ENV=production`.
> The 60-second triage version is [Incident Response](incident-response.md).

## API is down (timeouts / unreachable)

1. **DNS** — `dig +short api.dxg-agency.com` must resolve to a CNAME ending
   `.elb.amazonaws.com` plus two A records. If it shows `68.183.227.9`,
   someone reverted DNS to the old DigitalOcean droplet.
2. **TLS/ALB reachability** — `curl -sv https://api.dxg-agency.com/health`.
   *Connection timeout* → ALB security group problem: the ALB SG must allow
   80 **and 443** from 0.0.0.0/0. If 443 is missing, someone redeployed the
   Network stack without the cert context — redeploy
   `Rfpilot-$ENV-Network` **with** `-c certificateArn=... -c apiDomain=...`
   (see the trap in [Architecture](architecture.md)).
3. **Target health** — EC2 → Target Groups → `Rfpilo-ApiTa-*`: if the target
   is `unhealthy`/`draining`, the app is failing `GET /health`.
4. **Service state** —
   `aws ecs describe-services --cluster rfpilot-$ENV --services api` →
   `runningCount`. 0 = crash loop; check *Events* tab and stopped-task
   reasons ([Services](services.md#handy-commands)).
5. **App logs** — `/rfpilot/$ENV/api`, newest stream. The boot banner tells
   you exactly which dependency failed (Mongo parse error, Postgres SSL,
   Redis auth...). A crash-looping API is almost always a bad secret value
   or an unreachable dependency.
6. **Dependencies** — see the database/Redis sections below.
7. **Deploy in flight?** — `gh run list --workflow "Deploy to AWS"` — the
   API has a **normal 30–60s outage window during every deploy**
   (stop-then-start). Don't page anyone for that.

## 502 Bad Gateway

In this architecture a 502 means **the ALB couldn't get a response from the
api task** — there is no nginx or other reverse proxy.

1. Target group health (above) — an unhealthy/absent target while a deploy
   rolls is the common cause; wait out the stop-then-start window.
2. Crash loop: service events show "registered → deregistered → started"
   cycles ≈ the app dies after boot; read the newest api log stream.
3. Response-header timing: the app sets `keepAliveTimeout=65s` (above the
   ALB's 60s default idle) and the ALB idle timeout is 180s — these are
   already tuned; don't change them casually.
4. Port/SG misconfig only applies after infra edits: ALB→api is `:8000`
   (`ApiSg` ingress from `AlbSg`).

## 500 Internal Server Error

1. Get the **`Reference:` uuid** from the client/frontend error if present.
2. CloudWatch → `/rfpilot/$ENV/api` → newest stream → search the uuid or the
   timestamp. The morgan request line (`POST /api/... 500 ...ms`) sits next
   to the stack trace.
3. Read the stack trace; identify the module (`dist/...` paths map 1:1 to
   the TypeScript sources).
4. If it's a dependency error (Mongo/Postgres/Redis/OpenAI/SES), jump to
   that section below. AI endpoints returning 503 with codes like
   `ORGANIZATION_NOT_READY` mean the Postgres data foundation is missing
   rows — run the backfill ([Environments](environments.md#bootstrapping-and-re-seeding-environment-data)).
5. Reproduce locally against a copy of the failing input — there is no
   staging environment to reproduce on — then fix and ship via the normal
   pipeline.

## Database problems

### Postgres (RDS)

- Status: RDS console → instance → *Status* + Monitoring tab.
- Connectivity is only possible from inside the VPC (api/worker/dispatcher/
  migrate/ai-gateway SGs). A sudden "no pg_hba.conf entry"/auth failure
  after a secret change → `POSTGRES_URL` in `rfpilot/$ENV/app` doesn't match
  the RDS master secret; recompose with
  `deploy/aws/scripts/compose-app-secrets.sh $ENV`.
- Connection exhaustion: `rfpilot-$ENV-rds-connections-high` alarm; normal
  is 30–40 (pool max 10 × services). Sustained >80 = leak or task storm.
- TLS: tasks verify RDS certs via `NODE_EXTRA_CA_CERTS=/app/rds-global-bundle.pem`
  (baked into the image). `self-signed certificate` errors = someone removed
  that env or the bundle.
- `/health` reports `postgres.ready` and `migrationVersion` — a version
  behind expectations means the migration task didn't run; check
  `/rfpilot/$ENV/migrate`.

### MongoDB (Atlas)

- `/health` → `database: "connected"` is the app's view.
- `MongoParseError: Invalid scheme` at boot = the `MONGODB_URL` secret value
  is corrupt/placeholder — check the secret's version history
  ([Secrets](secrets.md#recovering-a-clobbered-secret)).
- Server-selection timeouts = network: the **NAT EIP must be in the Atlas
  Network Access allowlist** (production
  `13.58.171.171`). This breaks silently if the allowlist is edited or a
  NAT is recreated.
- Wrong-database confusion: the cluster is shared; the env's database is
  chosen by `MONGODB_DB_NAME` (`dxg_rfp_tool_prod`),
  not by the URL.

## Redis connection failure

- `/health` → `queue.ready:false`, or boot logs showing AUTH/TLS errors.
- Endpoint & status: ElastiCache console → replication group `rfpilot-$ENV`.
- The URL **must** be `rediss://` (TLS) with the AUTH token from
  `rfpilot/$ENV/redis-auth` URL-encoded into `REDIS_URL`. Token rotated?
  Recompose the secret, then force new deployments.
- Reachability is SG-scoped to the app task SGs (port 6379, no outbound
  from the Redis SG).
- Losing Redis data is **not** an incident for queued work: the dispatcher
  republishes pending jobs from the Postgres outbox within ~30s. The
  `volatile-lru` eviction-policy log warning at startup is known/cosmetic.

## Email not sending

- API logs show `[SMTP] Email sent: <id@dxg-agency.com>` on success.
- ⚠️ **SES is in sandbox**: delivery only works to verified identities
  (SES console → Identities). Real-user OTP delivery is blocked until
  production access is granted (pending the real-domain purchase — see
  `deploy/aws/STATE.md`). This is a known limitation, not a regression.
- Auth failures: SES SMTP uses IAM-derived credentials
  (`SMTP_USER`=access-key-id, `SMTP_PASSWORD`=derived) from IAM user
  `rfpilot-$ENV-ses-smtp` — the username is *not* the mail address.

## ClamAV / uploads failing

Vendor uploads returning 503 or sources stuck in `scan_failed` = the
`clamav` service is down, and **fail-closed is the intended design**. Fix
the service (it needs ~5 min after a cold start to download signatures),
then retry the scans; do not bypass scanning.

## Deployment failed

Work through [CI/CD → when a deployment fails](cicd.md#when-a-deployment-fails-look-here-in-this-order),
then [Rollback](rollback.md) if the bad version reached users.

## Background jobs stuck

1. Worker/dispatcher running? (`RunningTaskCount`, service events.)
2. Job table: `SELECT status, count(*) FROM rfpilot.durable_jobs GROUP BY 1;`
   and stuck attempts:
   `SELECT max(heartbeat_at) FROM rfpilot.job_attempts WHERE status='running';`
3. Outbox age: oldest `pending` row in `rfpilot.outbox_events` — old rows +
   healthy dispatcher = Redis publish problems; check dispatcher logs.
4. Failed jobs carry `errorCode` (e.g. `LIVE_AI_CLASSIFICATION_DENIED` =
   flag gating, `LIVE_AI_KILLED` = kill switch) — look the code up in
   `src/modules/liveAi/openAiProvider.ts`.
