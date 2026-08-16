import "../config/env";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";

type Migration = { version: string; name: string; up: string; down: string; checksum: string };
type AppliedMigration = { version: string; name: string; checksum: string };
const migrationDir = path.resolve(__dirname, "../migrations/postgres");
const command = process.argv[2] || "status";
const allowed = new Set(["up", "status", "rollback", "help"]);

const migrations = (): Migration[] => fs.readdirSync(migrationDir)
  .filter((file) => /^\d+_.+\.up\.sql$/.test(file))
  .sort()
  .map((file) => {
    const match = /^(\d+)_(.+)\.up\.sql$/.exec(file);
    if (!match) throw new Error(`Invalid migration filename: ${file}`);
    const up = fs.readFileSync(path.join(migrationDir, file), "utf8");
    const downFile = file.replace(".up.sql", ".down.sql");
    if (!fs.existsSync(path.join(migrationDir, downFile))) throw new Error(`Missing ${downFile}`);
    return {
      version: match[1], name: match[2], up,
      down: fs.readFileSync(path.join(migrationDir, downFile), "utf8"),
      checksum: crypto.createHash("sha256").update(up).digest("hex"),
    };
  });

const database = () => {
  const connectionString = process.env.POSTGRES_MIGRATION_URL || process.env.POSTGRES_URL;
  if (!connectionString) throw new Error("POSTGRES_MIGRATION_URL or POSTGRES_URL is required");
  return new Pool({ connectionString, max: 2, ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: true } : undefined });
};

const bootstrap = (client: PoolClient) => client.query(`
  CREATE TABLE IF NOT EXISTS public.rfpilot_schema_migrations (
    version text PRIMARY KEY,
    name text NOT NULL,
    checksum char(64) NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

// A branch merge briefly created two independent migration sequences starting
// at 026. The merged tree moved one sequence forward, but databases that had
// already applied that sequence still carry its original version numbers.
// Reconcile those ledger keys by immutable name + checksum before deciding
// what is pending. This changes migration metadata only; migration SQL is
// never replayed for a schema change that is already present.
const reconcileShiftedVersions = async (
  client: PoolClient,
  available: Migration[],
  appliedRows: AppliedMigration[],
) => {
  const availableByName = new Map(available.map((item) => [item.name, item]));
  const moves = appliedRows.flatMap((row) => {
    const target = availableByName.get(row.name);
    if (!target || target.version === row.version) return [];
    if (row.checksum.trim() !== target.checksum) {
      throw new Error(
        `Cannot reconcile migration ${row.version}_${row.name}: checksum does not match ${target.version}_${target.name}`,
      );
    }
    return [{ from: row.version, to: target.version, name: row.name }];
  });
  if (!moves.length) return;

  const movingVersions = new Set(moves.map((move) => move.from));
  const occupiedVersions = new Set(appliedRows.map((row) => row.version));
  for (const move of moves) {
    if (occupiedVersions.has(move.to) && !movingVersions.has(move.to)) {
      throw new Error(
        `Cannot reconcile migration ${move.from}_${move.name}: target version ${move.to} is occupied`,
      );
    }
  }

  await client.query("BEGIN");
  try {
    for (const move of moves) {
      await client.query(
        "UPDATE public.rfpilot_schema_migrations SET version=$2 WHERE version=$1",
        [move.from, `__reconcile__${move.from}`],
      );
    }
    for (const move of moves) {
      await client.query(
        "UPDATE public.rfpilot_schema_migrations SET version=$2 WHERE version=$1",
        [`__reconcile__${move.from}`, move.to],
      );
      console.log(`Reconciled ${move.from}_${move.name} -> ${move.to}_${move.name}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
};

const main = async () => {
  if (!allowed.has(command)) throw new Error(`Unknown command: ${command}`);
  if (command === "help") {
    console.log("Usage: npm run migrate:postgres -- <up|status|rollback|help>");
    return;
  }
  const pool = database();
  const client = await pool.connect();
  try {
    await bootstrap(client);
    await client.query("SELECT pg_advisory_lock(hashtext('rfpilot-postgres-migrations'))");
    const available = migrations();
    let appliedResult = await client.query<AppliedMigration>(
      "SELECT version, name, checksum FROM public.rfpilot_schema_migrations ORDER BY version",
    );
    await reconcileShiftedVersions(client, available, appliedResult.rows);
    appliedResult = await client.query<AppliedMigration>(
      "SELECT version, name, checksum FROM public.rfpilot_schema_migrations ORDER BY version",
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.version, row.checksum.trim()]));
    for (const migration of available) {
      const checksum = applied.get(migration.version);
      if (checksum && checksum !== migration.checksum) throw new Error(`Checksum mismatch for migration ${migration.version}`);
    }
    if (command === "status") {
      console.log(JSON.stringify(available.map((migration) => ({ version: migration.version, name: migration.name, status: applied.has(migration.version) ? "applied" : "pending" })), null, 2));
      return;
    }
    if (command === "up") {
      for (const migration of available.filter((item) => !applied.has(item.version))) {
        await client.query("BEGIN");
        try {
          await client.query(migration.up);
          await client.query(
            "INSERT INTO public.rfpilot_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)",
            [migration.version, migration.name, migration.checksum],
          );
          await client.query("COMMIT");
          console.log(`Applied ${migration.version}_${migration.name}`);
        } catch (error) { await client.query("ROLLBACK"); throw error; }
      }
      return;
    }
    const latest = [...available].reverse().find((item) => applied.has(item.version));
    if (!latest) { console.log("No applied migration to roll back"); return; }
    await client.query("BEGIN");
    try {
      await client.query(latest.down);
      await client.query("DELETE FROM public.rfpilot_schema_migrations WHERE version = $1", [latest.version]);
      await client.query("COMMIT");
      console.log(`Rolled back ${latest.version}_${latest.name}`);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(hashtext('rfpilot-postgres-migrations'))"); } catch { /* connection cleanup */ }
    client.release();
    await pool.end();
  }
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
