// Verifies scripts/migratePostgres.ts against the real integration Postgres:
// `up` applies the full chain, a second `up` is a no-op (idempotent), and
// `status` afterwards reports zero pending migrations.
import { ensureServices, runMigrationCommand } from "./setup";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closePostgres, postgresPool } from "../config/postgres";

type StatusRow = { version: string; name: string; status: "applied" | "pending" };

before(async () => {
  await ensureServices();
});

after(async () => {
  await closePostgres();
});

test("migrate up applies cleanly and a second run is idempotent", () => {
  const first = runMigrationCommand("up");
  assert.equal(first.status, 0, `first up failed:\n${first.stderr}${first.stdout}`);

  const second = runMigrationCommand("up");
  assert.equal(second.status, 0, `second up failed:\n${second.stderr}${second.stdout}`);
  assert.doesNotMatch(
    second.stdout,
    /Applied /,
    `second up should apply nothing, but reported:\n${second.stdout}`,
  );
});

test("status reports every migration applied and zero pending", () => {
  const result = runMigrationCommand("status");
  assert.equal(result.status, 0, `status failed:\n${result.stderr}${result.stdout}`);
  const rows = JSON.parse(result.stdout) as StatusRow[];
  assert.ok(rows.length >= 20, `expected the full migration chain, got ${rows.length} entries`);
  const pending = rows.filter((row) => row.status !== "applied");
  assert.deepEqual(pending, [], `pending migrations remain: ${JSON.stringify(pending)}`);
});

test("schema migration journal matches the checked-in migration files", async () => {
  const result = runMigrationCommand("status");
  const rows = JSON.parse(result.stdout) as StatusRow[];
  const journal = await postgresPool().query<{ version: string }>(
    "SELECT version FROM public.rfpilot_schema_migrations ORDER BY version",
  );
  assert.deepEqual(
    journal.rows.map((row) => row.version),
    rows.map((row) => row.version),
    "rfpilot_schema_migrations should record exactly the versions on disk",
  );
});

test("latest assistant retention migration rolls back cleanly and reapplies", async () => {
  const rollback = runMigrationCommand("rollback");
  assert.equal(
    rollback.status,
    0,
    `assistant retention rollback failed:\n${rollback.stderr}${rollback.stdout}`,
  );
  assert.match(rollback.stdout, /Rolled back 043_assistant_retention_privacy/);

  try {
    const rolledBack = await postgresPool().query<{
      policies: string | null;
      deletion_requests: string | null;
      legal_holds: string | null;
    }>(
      `
        SELECT
          to_regclass('rfpilot.assistant_retention_policies')::text AS policies,
          to_regclass('rfpilot.assistant_deletion_requests')::text AS deletion_requests,
          to_regclass('rfpilot.assistant_legal_holds')::text AS legal_holds
      `,
    );
    assert.equal(rolledBack.rows[0]?.policies, null);
    assert.equal(rolledBack.rows[0]?.deletion_requests, null);
    assert.equal(rolledBack.rows[0]?.legal_holds, null);
  } finally {
    const reapply = runMigrationCommand("up");
    assert.equal(
      reapply.status,
      0,
      `assistant retention reapply failed:\n${reapply.stderr}${reapply.stdout}`,
    );
    assert.match(reapply.stdout, /Applied 043_assistant_retention_privacy/);
  }

  const reapplied = await postgresPool().query<{
    policies: string | null;
    deletion_requests: string | null;
    legal_holds: string | null;
  }>(
    `
      SELECT
        to_regclass('rfpilot.assistant_retention_policies')::text AS policies,
        to_regclass('rfpilot.assistant_deletion_requests')::text AS deletion_requests,
        to_regclass('rfpilot.assistant_legal_holds')::text AS legal_holds
    `,
  );
  assert.equal(reapplied.rows[0]?.policies, "rfpilot.assistant_retention_policies");
  assert.equal(reapplied.rows[0]?.deletion_requests, "rfpilot.assistant_deletion_requests");
  assert.equal(reapplied.rows[0]?.legal_holds, "rfpilot.assistant_legal_holds");
});
