# Production Runbook — RFPilot AI Backend

## Processes (PM2, `ecosystem.config.js`)

| App | Script | Purpose |
|---|---|---|
| dxg-rfp-tool | dist/server.js | API + WebSocket + crons |
| dxg-rfp-worker | npm run worker:source-security (ts-node) | Durable job execution (scans, parsing, extraction, drafting, vendor analysis) |
| dxg-rfp-dispatcher | npm run worker:dispatcher (ts-node) | Outbox → Redis publisher + reconciler |

Worker/dispatcher run via ts-node npm scripts (`scripts/` is excluded from the TS build). The Vercel serverless
config (`vercel.json`) serves the stateless REST surface only — WebSockets,
crons, workers and the dispatcher REQUIRE the PM2 deployment. Do not enable AI
flags on a serverless-only deployment.

## Required infrastructure

MongoDB (authoritative proposals) · PostgreSQL 16 + pgvector (AI domain, RLS)
· Redis (BullMQ, reference-only payloads, shared rate limits) · Private
S3-compatible bucket (quarantine prefix; no public ACLs) · ClamAV daemon
(`CLAMAV_HOST:3310`) — scanning fails CLOSED when unreachable, so sources will
sit in `scan_failed` if ClamAV is down.

## Environment (key names)

- Authorization: `AI_ENVIRONMENT=production` (deny-by-default when unset),
  feature flags per capability (`CONVERSATIONS_ENABLED`, `PROPOSAL_CONTEXT_ENABLED`,
  `PROPOSAL_DRAFT_ENABLED`, `CANDIDATE_APPLICATION_ENABLED`, `PROPOSAL_WORKFLOW_ENABLED`,
  `KNOWLEDGE_*`, `GUIDANCE_ENABLED`, `INVESTMENT_GUIDANCE_ENABLED`,
  `PRICING_CORPUS_ENABLED`, `VENDOR_ANALYSIS_ENABLED`, `LIVE_AI_*`).
- Kill switches: `LIVE_AI_KILL_SWITCH` (+ per-operation variants),
  `KNOWLEDGE_EMBEDDING_KILL_SWITCH`. Flipping any to `true` stops provider
  calls immediately; queued jobs fail safe and are retryable.
- Secrets (worker env only where possible): `OPENAI_API_KEY`, `JWT_SECRET`,
  `OTP_PEPPER`, `TELEMETRY_PSEUDONYM_KEY` (required when observability is on),
  `DOCUMENT_STORAGE_*`, `POSTGRES_URL`, `MONGODB_URL`, `REDIS_URL`.
- Model pin: `LIVE_AI_MODEL=gpt-5.4-mini-2026-03-17`. Changing it is a release:
  run the gold evaluation (`docs/testing/GOLD_EVALUATION.md`) and record the run.

## Deploy

1. `npm run ci` (contracts, lint, types, migration check, 289+ unit tests, build).
2. `npm run integration:up && npm run test:integration && npm run integration:down`.
3. `npx ts-node scripts/migratePostgres.ts up` against production Postgres.
4. `pm2 reload ecosystem.config.js` (API, worker, dispatcher).
5. Smoke: `GET /api/v1/ai/pilot/status` (security admin) — verify environment,
   model, kill-switch state; upload → scan → extract on a synthetic fixture.

## Cost & usage

`GET /api/v1/ai/usage-report?days=30` (`organization:manage`) — daily attempt
counts and token sums from the provider attempt ledger for invoice
reconciliation. Vendor-analysis calls are not yet ledgered (see deferred list).

## Data retention

- Archived proposals hard-delete from Mongo after 30 days (daily cron); the
  purge now propagates: private source objects are deleted from storage,
  Postgres `document_sources` rows are tombstoned, conversations archived
  (`purgeProposalArtifacts`). Immutable AI evidence/audit rows persist until
  their own retention windows (they contain checksums and validated outputs,
  not raw documents).
- Run tables carry `retention_until`; a scheduled cleanup job for expired rows
  remains a deferred item.

## Incident quick reference

| Symptom | First moves |
|---|---|
| AI runs stuck `queued` | Is the dispatcher running? `pm2 logs dxg-rfp-dispatcher`; check Redis connectivity; jobs self-reconcile every 30s once restored |
| Provider errors / cost spike | Flip `LIVE_AI_KILL_SWITCH=true` + reload; inspect `/api/v1/ai/usage-report`; check `ai_provider_attempts` for `orphaned` rows |
| Uploads stuck `scan_failed` | ClamAV reachable on 3310? Fail-closed is intentional; rescan via the scan endpoint after restoring the daemon |
| 503 on all AI endpoints | `AI_ENVIRONMENT` unset/typo — deny-by-default is working as designed |
