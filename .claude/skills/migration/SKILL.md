---
name: migration
description: Add a PostgreSQL migration to the RFPilot backend (numbered up/down SQL under migrations/postgres) with tenant RLS, and prove it applies, is idempotent and rolls back against the integration database. Use when a table, column, index, policy or function in the rfpilot schema must change.
argument-hint: <snake_case_name, e.g. org_dashboard_indexes>
---

# /migration $ARGUMENTS

## 1. Number and files

- Next number = highest `NNN` in `migrations/postgres/` + 1, zero-padded to three digits.
  Check `git log origin/main -- migrations/postgres` too, so a parallel branch has not taken it.
- Create `NNN_$ARGUMENTS.up.sql` and `NNN_$ARGUMENTS.down.sql`. The runner refuses an up file without a down.
- **Never edit a migration already committed** (a hook blocks it). The runner checksums applied
  files; changing one breaks every database that ran it. Write a new migration instead.

## 2. Write the up file

- Start with a comment saying why the change exists and naming the ticket.
- Everything lives in the `rfpilot` schema.
- A new tenant table has `organization_id`, `UNIQUE (organization_id, id)`, composite foreign keys
  `(organization_id, <parent>_id)`, and forced RLS. Copy the loop from
  `051_proposal_intelligence_operations.up.sql`:
  `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and
  `CREATE POLICY tenant_<table> ... USING (organization_id = rfpilot.current_organization_id()) WITH CHECK (...)`.
- A shared (global) row written by a migration runs as the owner, which forced RLS also binds:
  wrap that statement in `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` / `FORCE ROW LEVEL SECURITY`
  (see `065_ai_policy_tenant_writes.up.sql`).
- Add CHECK constraints for shape (`jsonb_typeof`, length bounds, id patterns) like the existing tables.
- Add indexes for the queries that will use the table; name them `<table>_<cols>_idx`.
- Grants are not done per migration. Do not add GRANT statements unless the latest migrations do.
- Immutable event tables get a `BEFORE UPDATE OR DELETE` guard trigger, as in 051.

## 3. Write the down file

Exactly reverse the up file, in reverse order (policies and triggers before tables). The down
must leave the schema as it was before the up, so a rollback then re-apply is clean.

## 4. Prove it (needs Docker)

```bash
npm run integration:up
INTEGRATION=1 node --test --require ts-node/register tests-integration/migrations.test.ts
npm run test:integration      # full suite if application code uses the new schema
npm run integration:down
```

`migrations.test.ts` applies the whole chain, checks a second `up` is a no-op, and rolls the
latest migration back and re-applies it, so a broken down file fails here.
Never run `migrate:postgres` against a database from `.env` / `.env.local` and never run
`migrate:postgres:prod`; deploys apply migrations.

## 5. Finish

- Update `docs/DATABASE.md` if the table or policy model changed, and `docs/PROJECT_STATE.md`
  if this changes what is shipped.
- `npm run ci`.
- Report the migration number, what it changes, RLS state of any new table, and the integration
  test result (or that Docker was unavailable and it was not run).
