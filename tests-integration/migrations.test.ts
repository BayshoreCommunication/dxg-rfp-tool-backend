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

test("platform assistant migration rolls back cleanly and reapplies", async () => {
  const rollback = runMigrationCommand("rollback");
  assert.equal(
    rollback.status,
    0,
    `platform assistant rollback failed:\n${rollback.stderr}${rollback.stdout}`,
  );
  assert.match(rollback.stdout, /Rolled back 026_platform_assistant/);

  try {
    const rolledBack = await postgresPool().query<{
      threads: string | null;
      messages: string | null;
      attempt_constraint: string;
    }>(
      `
        SELECT
          to_regclass('rfpilot.assistant_threads')::text AS threads,
          to_regclass('rfpilot.assistant_messages')::text AS messages,
          pg_get_constraintdef(oid) AS attempt_constraint
        FROM pg_constraint
        WHERE conname='ai_provider_attempts_run_type_check'
      `,
    );
    assert.equal(rolledBack.rows[0]?.threads, null);
    assert.equal(rolledBack.rows[0]?.messages, null);
    assert.doesNotMatch(
      rolledBack.rows[0]?.attempt_constraint ?? "",
      /platform_assistant/,
    );
  } finally {
    const reapply = runMigrationCommand("up");
    assert.equal(
      reapply.status,
      0,
      `platform assistant reapply failed:\n${reapply.stderr}${reapply.stdout}`,
    );
    assert.match(reapply.stdout, /Applied 026_platform_assistant/);
  }

  const reapplied = await postgresPool().query<{
    threads: string | null;
    messages: string | null;
    attempt_constraint: string;
  }>(
    `
      SELECT
        to_regclass('rfpilot.assistant_threads')::text AS threads,
        to_regclass('rfpilot.assistant_messages')::text AS messages,
        pg_get_constraintdef(oid) AS attempt_constraint
      FROM pg_constraint
      WHERE conname='ai_provider_attempts_run_type_check'
    `,
  );
  assert.equal(reapplied.rows[0]?.threads, "rfpilot.assistant_threads");
  assert.equal(reapplied.rows[0]?.messages, "rfpilot.assistant_messages");
  assert.match(reapplied.rows[0]?.attempt_constraint ?? "", /platform_assistant/);
});
