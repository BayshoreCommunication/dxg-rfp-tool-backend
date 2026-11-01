import "../config/env";
import mongoose from "mongoose";
import { Pool } from "pg";
import { DATABASE_NAME } from "../config/db";
import { migrateCustomerOrganizations, rollbackCustomerOrganizations } from "../src/modules/tenancy/customerOrganizationMigration";

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split("=");
  return [key, rest.length ? rest.join("=") : "true"];
}));
const apply = args.get("--apply") === "true";
const rollbackRunId = args.get("--rollback-run");
const runId = args.get("--run-id") || `customer-organizations-${new Date().toISOString()}`;
const fromSlug = args.get("--from-slug") || process.env.DEFAULT_ORGANIZATION_SLUG || "dxg";
const userId = args.get("--user");
const mongoUri = process.env.MONGODB_URL || process.env.MONGO_URL;

const help = () => process.stdout.write(`Usage:
  npm run migrate:customer-organizations -- [--run-id=<id>] [--from-slug=dxg] [--user=<userId>]
  npm run migrate:customer-organizations -- --apply [--run-id=<id>] [--from-slug=dxg] [--user=<userId>]
  npm run migrate:customer-organizations -- --rollback-run=<id> [--apply]

Moves every customer out of the shared organization into a legacy holding tenant of their own,
with their MongoDB documents and Postgres rows. Default mode is dry-run: Postgres moves run in a
transaction that is rolled back, so the counts are exact and missing privileges show up early.
Postgres moves need the migration role (POSTGRES_MIGRATION_URL), which owns the tables.
Re-running an applied run id skips customers already moved. Run in a maintenance window with the
worker and dispatcher paused and the outbox drained.
`);

const main = async () => {
  if (args.has("--help")) return help();
  if (!mongoUri) throw new Error("MONGODB_URL or MONGO_URL is required");
  const connectionString = process.env.POSTGRES_MIGRATION_URL || process.env.POSTGRES_URL;
  await mongoose.connect(mongoUri, { dbName: DATABASE_NAME });
  const pool = connectionString
    ? new Pool({ connectionString, max: 2, ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: true } : undefined })
    : null;
  try {
    const report = rollbackRunId
      ? await rollbackCustomerOrganizations({ runId: rollbackRunId, apply, pool })
      : await migrateCustomerOrganizations({ fromSlug, runId, apply, pool, userId });
    process.stdout.write(`${JSON.stringify({ database: DATABASE_NAME, postgres: pool ? "enabled" : "skipped", ...report }, null, 2)}\n`);
    if (report.failed > 0) process.exitCode = 1;
  } finally {
    await pool?.end();
    await mongoose.disconnect();
  }
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Customer organization migration failed"}\n`);
  process.exitCode = 1;
});
