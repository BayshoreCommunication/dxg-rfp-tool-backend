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

test("latest checked-in migration rolls back cleanly and reapplies", () => {
  const before = runMigrationCommand("status");
  assert.equal(before.status, 0, `status before rollback failed:\n${before.stderr}${before.stdout}`);
  const migrations = JSON.parse(before.stdout) as StatusRow[];
  const latest = migrations.at(-1);
  assert.ok(latest, "expected at least one checked-in migration");
  assert.equal(latest.status, "applied");

  const rollback = runMigrationCommand("rollback");
  assert.equal(
    rollback.status,
    0,
    `latest migration rollback failed:\n${rollback.stderr}${rollback.stdout}`,
  );
  assert.equal(rollback.stdout.trim(), `Rolled back ${latest.version}_${latest.name}`);

  try {
    const rolledBack = runMigrationCommand("status");
    assert.equal(rolledBack.status, 0, `status after rollback failed:\n${rolledBack.stderr}${rolledBack.stdout}`);
    const rolledBackRows = JSON.parse(rolledBack.stdout) as StatusRow[];
    assert.equal(rolledBackRows.at(-1)?.version, latest.version);
    assert.equal(rolledBackRows.at(-1)?.status, "pending");
  } finally {
    const reapply = runMigrationCommand("up");
    assert.equal(
      reapply.status,
      0,
      `latest migration reapply failed:\n${reapply.stderr}${reapply.stdout}`,
    );
    assert.equal(reapply.stdout.trim(), `Applied ${latest.version}_${latest.name}`);
  }

  const reapplied = runMigrationCommand("status");
  assert.equal(reapplied.status, 0, `status after reapply failed:\n${reapplied.stderr}${reapplied.stdout}`);
  const reappliedRows = JSON.parse(reapplied.stdout) as StatusRow[];
  assert.equal(reappliedRows.at(-1)?.version, latest.version);
  assert.equal(reappliedRows.at(-1)?.status, "applied");
});
