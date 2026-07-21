# Integration Test Suite (real infrastructure)

`tests-integration/` runs the backend's Postgres/Redis/Mongo modules against a
dedicated Docker stack — no mocks for the datastores, the real migration chain,
the real repositories, and the real BullMQ queue. AI providers stay on the
approved mock/deterministic implementations (see limitations below).

## How to run

```bash
npm run integration:up      # start postgres (pgvector 16), redis 7, mongo 7 (requires Docker)
npm run test:integration    # migrations run inside the tests, then the suite executes serially
npm run integration:down    # stop the stack and delete its volumes
```

Notes:

- `integration:up` uses `docker compose -p rfpilotintg -f deploy/integration/docker-compose.yml up -d --wait`,
  so it returns only once all three healthchecks pass. The project name
  `rfpilotintg` isolates networks/volumes from dev and observability stacks.
- Ports are non-default and loopback-only on purpose:
  Postgres `127.0.0.1:55432` (db `rfpilot_test`, user `postgres`, password `rfpilot_test`),
  Redis `127.0.0.1:56379`, Mongo `127.0.0.1:57017` (db `rfpilot_test`).
- Port conflict gotcha: the ad-hoc `rfpilot-redis-test` container used by the
  `scripts/verify*E2E.ts` workflows also binds `127.0.0.1:56379`. If
  `integration:up` fails with "port is already allocated", stop it first
  (`docker stop rfpilot-redis-test`) and `docker start rfpilot-redis-test`
  afterwards — both stacks are disposable test Redis instances and cannot run
  at the same time.
- The suite refuses to start without `INTEGRATION=1` (set by the npm script),
  so `npm test` and editor test runners can never touch these services by
  accident. If the stack is not running, the first check fails fast with a
  message telling you to run `npm run integration:up`.
- Each test file sets its full environment in-process
  (`tests-integration/env.ts`) **before** importing any application module and
  never imports `config/env`, so `.env` / `.env.local` are not loaded. The
  migration child process runs with `cwd=tests-integration/` and a minimal
  environment for the same reason.
- Tests run serially (`--test-concurrency=1`). Every file is standalone: each
  calls `ensureMigrated()` (idempotent `migrate up`) and seeds its own fresh
  organization / user / proposal_reference with random 24-hex external ids, so
  reruns never collide and no cleanup between runs is required. Data
  accumulates in the Docker volumes until `integration:down -v`.

## What is covered

| File | Coverage |
| --- | --- |
| `migrations.test.ts` | `scripts/migratePostgres.ts up` via child process against the real database; second `up` is a no-op; `status` reports zero pending; the `rfpilot_schema_migrations` journal matches the files on disk. |
| `tenant-isolation.test.ts` | RLS through a dedicated non-superuser role `rfpilot_app` (created by the suite): with org A's `app.organization_id` GUC set, SELECTs on `rfpilot.conversations` / `pricing_records` / `guidance_reports` return only A's rows; no GUC returns nothing; INSERT with a mismatched `organization_id` fails with `42501`; matching INSERT passes the WITH CHECK. Also documents that the default `postgres` login is a superuser and therefore bypasses RLS (even `FORCE ROW LEVEL SECURITY` — that clause only reins in non-superuser table owners), which is what lets the outbox dispatcher scan cross-tenant. |
| `durable-jobs.test.ts` | Durable job lifecycle with real Postgres + Redis: `proposalContextRepository.create` writes the `ai_jobs` row and a pending `outbox_events` row; duplicate create with the same idempotency key returns `created:false`; `dispatcher.dispatch()` marks the event published and lands the message on the BullMQ `rfpilot-source-security` queue; the message is then claimed / heartbeated / completed through `durableJobRepository` (what `worker.ts` does) and ends `succeeded`; re-create after completion still returns the existing job. |
| `candidate-application.test.ts` | Full CAS path across Postgres **and** Mongo: mock deterministic context run (create + execute), review save with revision conflict handling, application creation, `candidateApplicationRepository.execute` mutating the real Mongo proposal (accepted value applied, `version` 1 → 2, `candidateApplicationIds` recorded), idempotent re-create/re-execute (no second version bump), and a stale `expectedProposalVersion` ending in status `conflict` with `PROPOSAL_VERSION_CONFLICT`. |
| `conversations.test.ts` | `conversationRepository.read` auto-creates the conversation; `appendExchange` idempotency (same key twice → `created:false`, no extra message); question sync from a succeeded context run with issues (medium fixture → `MISSING_SHOW_END_TIME` appears as an open clarification question); answering appends a `question_answer` message, closes the question, and re-answering is rejected. |
| `pricing.test.ts` | Pricing record lifecycle: create draft → update bumps revision → stale revision → `REVISION_CONFLICT` (409) → approve (edits blocked, illegal transitions rejected) → retire (terminal). Expert rules: create draft, duplicate `rule_key` → `RULE_KEY_EXISTS`, activate, active rules not editable. |

## Environment the tests run under

Set in `tests-integration/env.ts` (per process, before any app import):
`NODE_ENV=test`, `AI_ENVIRONMENT=test`, `POSTGRES_FOUNDATION_ENABLED=true`,
`POSTGRES_URL`/`POSTGRES_MIGRATION_URL` → `localhost:55432/rfpilot_test`,
`REDIS_URL` → `localhost:56379`, `MONGODB_URL` → `localhost:57017/rfpilot_test`,
`DURABLE_JOBS_ENABLED=true`, and the feature flags
`PROPOSAL_CONTEXT_ENABLED` / `CANDIDATE_APPLICATION_ENABLED` /
`CONVERSATIONS_ENABLED` / `PRICING_CORPUS_ENABLED` / `PROPOSAL_DRAFT_ENABLED`
with mock providers (`PROPOSAL_CONTEXT_PROVIDER=mock`, `deterministic-v1`).
`LIVE_AI_PILOT_ENABLED=false` and `LIVE_AI_KILL_SWITCH=true` guarantee no live
provider call can happen.

## Known limitations

- **Bug found by this suite (workaround in place):**
  `src/modules/conversations/postgresConversationRepository.ts` selects
  `s.safe_filename` from `rfpilot.document_sources` in `read`'s attachments
  query, but no migration puts `safe_filename` on that table (it lives on
  `rfpilot.document_objects`). Against a migrations-only schema, every
  `conversationRepository.read` on a conversation with at least one message
  fails with 42703. `conversations.test.ts` works around this by calling
  `read` only on empty conversations and asserting post-message state via
  `snapshot` + direct SQL; once the join is fixed, revert to `read`.

- **No ClamAV container.** The `source_security_scan` handler (upload → scan →
  block) is not exercised here; it needs S3-compatible storage and a ClamAV
  daemon and stays covered by unit stubs and the existing
  `scripts/verifyDurableJobsE2E.ts` environment. The durable-jobs test uses the
  `proposal_context_extract` job type instead, which exercises the same
  repository/outbox/dispatcher/queue/claim machinery.
- **No live OpenAI.** All AI runs use the approved mock deterministic provider;
  live extraction/drafting paths are out of scope for this suite.
- **RLS is asserted through `rfpilot_app`,** a role the suite creates, because
  the container's default `postgres` login is a superuser and superusers always
  bypass RLS. If production ever connects with a non-superuser role lacking
  BYPASSRLS, the outbox dispatcher (`claimOutbox`/`reconcile`, which query
  without a tenant GUC) would need its own policy or role attribute.
- **BullMQ messages published by the dispatcher are consumed in-line** (claimed
  via the repository) rather than by a long-running `createSourceSecurityWorker`
  process; worker retry/backoff/dead-letter behaviour is covered by
  `scripts/verifyDurableJobsE2E.ts`.
- Mongo runs as a single node (no replica set); everything the suite touches
  (single-document `findOneAndUpdate` pipelines) works without one.
