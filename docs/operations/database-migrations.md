# Database Migrations & Deployment Safety

## Postgres (the migrated database)

- **Tool:** in-repo runner [`scripts/migratePostgres.ts`](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/blob/main/scripts/migratePostgres.ts)
  (compiled to `dist/scripts/migratePostgres.js`). Commands: `up`,
  `rollback` (exactly one step), `help`.
- **Migration files:** [`migrations/postgres/`](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/tree/main/migrations/postgres/) —
  numbered `NNN_name.up.sql` / `.down.sql` pairs (the `.down.sql` powers the
  one-step rollback), copied into `dist` at build time so the runner
  resolves them via `__dirname` inside the container. Current head: `043`
  (visible live in `GET /health → postgres.migrationVersion`).
- **CI check:** `npm run migration:check` (part of the quality gates) runs
  each migration script's `--help` to catch broken wiring before deploy.

### How they execute

Automatically, on **every deploy**, before services roll: the pipeline
registers a new revision of the `rfpilot-<env>-migrate` task definition
pointing at the **new** image and runs it as a one-off Fargate task
(command `node dist/scripts/migratePostgres.js up`, secrets:
`POSTGRES_URL`, `POSTGRES_MIGRATION_URL` only). The pipeline hard-fails on
a non-zero exit, so broken migrations never reach running services. Output:
CloudWatch `/rfpilot/<env>/migrate`.

Staging gets every migration first by construction (push to `main` →
staging; production only ever fast-forwards `main`).

### Writing a safe migration

1. **Backward-compatible only.** The previous app version must run against
   the new schema, because (a) services roll *after* the migration and
   (b) rollback redeploys old code against the migrated schema. Practically:
   add columns nullable/defaulted; never drop or rename in the same release
   that stops using something — drop in a later release ("expand, migrate,
   contract").
2. Mind RLS: tables in the `rfpilot` schema use forced row-level security
   with session GUCs (`app.organization_id`) — copy the pattern from an
   existing migration.
3. Big/risky change? Take a manual snapshot first:
   `aws rds create-db-snapshot --db-instance-identifier <id> --db-snapshot-identifier pre-<sha>`
   (automated backups exist regardless: 7d staging / 30d production).
4. Zero-downtime notes: the API is stop-then-start anyway (~30–60s window
   per deploy), so you get a brief natural quiesce — but the worker and
   dispatcher keep running on old code against the new schema during the
   roll. Rule 1 covers them; long-running `ALTER`s that take heavy locks
   should still be avoided or batched.

### Rollback

One step: one-off task on the migrate task definition with command
`["node","dist/scripts/migratePostgres.js","rollback"]`. Beyond one step:
restore the snapshot (procedure in [Rollback](rollback.md#3-database-considerations)).

## MongoDB (not migration-managed)

Mongoose schemas evolve in code; there is no Mongo migration runner.
Structural/tenancy changes ship as **journaled one-off scripts** run via ECS
task override on the **api** task definition (which has `MONGODB_URL` — the
migrate task definition does not):

| Script | Purpose |
|---|---|
| `migrateDxgOrganization.js` | Create/backfill the default organization tenancy (writes an exact per-document rollback journal; supports `--rollback-run=<id>`) |
| `migrateOrganizationMemberships.js` | Membership backfill |
| `migrateProposalV1.js` | Proposal shape migration |
| `migrateAssetUrls.js` | Rewrite stored absolute asset URLs |
| `backfillPostgresProposalReferences.js` | Mirror Mongo entities into the Postgres AI foundation (org/users/proposal references) |

Conventions all of these follow — keep them for new scripts:

- **Dry-run by default**, `--apply` to write.
- JSON report to stdout — **the report is the success signal; read it in
  the task logs. Do not trust exit code 0 alone** (hard-won lesson: a
  backfill once exited 0 having written nothing because it ran before the
  Postgres schema existed).
- Idempotent under re-runs.
- `--help` exits fast (it's wired into `npm run migration:check`).

Atlas-side backups are Atlas-managed (continuous, M10+).
