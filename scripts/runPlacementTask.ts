import "../config/env";
import mongoose from "mongoose";
import { Pool } from "pg";
import { DATABASE_NAME } from "../config/db";
import { PLACEMENT_RUN_ID } from "../src/modules/tenancy/placementTaskLauncher";
import { runPlacementTask } from "../src/modules/tenancy/placementTaskRunner";

// The entry point of the placement task definition (ORG-110; owner's decision 2026-11-17). The
// admin API queues a placement or rollback in the placement journal and starts an execution of
// the placement state machine; the state machine runs this file with one argument.
//
// It accepts exactly `--task-run=<runId>` and nothing else: no email, organization, role, list,
// rollback or apply flags. What to do is read from the journal entry and checked again against
// the database (src/modules/tenancy/placementTaskRunner.ts). The operator's CLI with those flags
// is scripts/placeLegacyCustomer.ts, run by hand on the migrate task definition.

const EXIT_USAGE = 64;
const EXIT_LEASE_LOST = 70;

const runIdFrom = (argv: string[]): string | null => {
  if (argv.length !== 1) return null;
  const match = /^--task-run=(.+)$/.exec(argv[0]);
  return match && PLACEMENT_RUN_ID.test(match[1]) ? match[1] : null;
};

const main = async () => {
  const runId = runIdFrom(process.argv.slice(2));
  if (!runId) {
    process.stderr.write("Usage: node dist/scripts/runPlacementTask.js --task-run=<runId>\nStarted by the placement state machine; takes no other argument.\n");
    process.exitCode = EXIT_USAGE;
    return;
  }
  const mongoUri = process.env.MONGODB_URL || process.env.MONGO_URL;
  if (!mongoUri) throw new Error("MONGODB_URL is required");
  const foundation = process.env.POSTGRES_FOUNDATION_ENABLED === "true";
  const connectionString = process.env.POSTGRES_MIGRATION_URL?.trim();
  if (foundation && !connectionString) throw new Error("POSTGRES_MIGRATION_URL is required");
  await mongoose.connect(mongoUri, { dbName: DATABASE_NAME });
  const pool = foundation
    ? new Pool({ connectionString, max: 2, ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: true } : undefined })
    : null;
  try {
    const outcome = await runPlacementTask({
      runId, pool,
      onLeaseLost: (reason) => {
        // Exiting drops both connections: Postgres rolls back and the MongoDB transaction aborts.
        process.stderr.write(`PLACEMENT_TASK_STOPPED: ${reason}; exiting without committing.\n`);
        process.exit(EXIT_LEASE_LOST);
      },
    });
    // The result carries ids and counts, never customer content.
    process.stdout.write(`${JSON.stringify({ mode: "task", runId, ...outcome })}\n`);
    if (!outcome.ran || !outcome.ok) process.exitCode = 1;
  } finally {
    await pool?.end();
  }
};

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
