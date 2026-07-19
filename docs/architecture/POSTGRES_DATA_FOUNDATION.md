# PostgreSQL data foundation

MongoDB remains authoritative for proposal content. PostgreSQL stores AI-domain records, stable MongoDB references, provenance, audit state, job/run state, and transactional outbox events.

## Configuration

```env
POSTGRES_FOUNDATION_ENABLED=false
PROPOSAL_REFERENCE_DUAL_WRITE_ENABLED=false
POSTGRES_URL=postgresql://application-role:secret@host:5432/rfpilot
POSTGRES_MIGRATION_URL=postgresql://migration-role:secret@host:5432/rfpilot
POSTGRES_SSL=true
POSTGRES_POOL_MAX=10
POSTGRES_CONNECT_TIMEOUT_MS=5000
POSTGRES_IDLE_TIMEOUT_MS=10000
POSTGRES_STATEMENT_TIMEOUT_MS=15000
```

Use separate secrets for the application and migration roles. The application role is non-superuser and receives only schema usage plus required table/sequence operations. The migration role owns schema changes. Never commit either URL.

## Local PostgreSQL 16

```bash
docker run --name rfpilot-postgres-test \
  -e POSTGRES_USER=rfpilot \
  -e POSTGRES_PASSWORD=rfpilot_local_only \
  -e POSTGRES_DB=rfpilot_test \
  -p 127.0.0.1:54329:5432 \
  -d postgres:16-alpine
```

The password above is local-only and must never be used in a shared environment.

## Migrations

```bash
npm run migrate:postgres -- status
npm run migrate:postgres -- up
npm run migrate:postgres -- rollback
```

Migrations use a PostgreSQL advisory lock, per-migration transactions, and SHA-256 checksums. Editing an applied migration fails closed. Add a new migration instead.

## Proposal-reference backfill

Dry run:

```bash
npm run backfill:postgres-proposals -- \
  --organization-id=<mongo-organization-id> \
  --run-id=<unique-run-id>
```

Apply and rollback:

```bash
npm run backfill:postgres-proposals -- --organization-id=<id> --run-id=<run> --apply
npm run backfill:postgres-proposals -- --rollback-run=<run>
npm run backfill:postgres-proposals -- --rollback-run=<run> --apply
```

The migration is idempotent. Its journal records newly created reference and outbox IDs plus per-reference checksums. Rollback deletes only records that still match the applied evidence; later modifications become explicit conflicts.

## Tenant isolation

Tenant-owned tables use forced PostgreSQL Row-Level Security. Each transaction sets both `app.organization_mongo_id` and the resolved `app.organization_id`. The application must use a non-superuser role because PostgreSQL superusers always bypass RLS.

## Dual-write behavior

Enable only after backfill and reconciliation:

```env
POSTGRES_FOUNDATION_ENABLED=true
PROPOSAL_REFERENCE_DUAL_WRITE_ENABLED=true
```

Proposal create, update, and copy operations then synchronize the PostgreSQL reference and outbox record. MongoDB remains authoritative. A PostgreSQL outage is logged as a deferred secondary synchronization and repaired by reconciliation; it does not roll back or corrupt the successful MongoDB proposal write.

## Backup and recovery

- Shared environments require automated backups and point-in-time recovery.
- Exercise `pg_dump`/`pg_restore` in test and record counts and migration versions.
- Restore into a separate database before declaring recovery successful.
- Do not drop populated production tables as an incident rollback strategy.
