// Shared helpers for the real-infrastructure integration suite.
// The "./env" import must stay first: it asserts INTEGRATION=1 and pins every
// service URL to the deploy/integration Docker stack before any app module loads.
import { TEST_POSTGRES_URL } from "./env";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import mongoose from "mongoose";
import type { PoolClient } from "pg";
import { closePostgres, postgresPool } from "../config/postgres";
import Proposal from "../modal/proposalsModel";

const repoRoot = path.resolve(__dirname, "..");

export const randomMongoId = (): string => crypto.randomBytes(12).toString("hex");

export type MigrationResult = { status: number | null; stdout: string; stderr: string };

// Runs scripts/migratePostgres.ts in a child process. cwd is this directory on
// purpose: scripts/migratePostgres.ts imports config/env, which loads .env and
// .env.local relative to cwd (the .env.local load uses override:true), so
// running from the repo root would let developer env files clobber the test
// database URLs. The migration file directory itself is resolved from
// __dirname inside the script, so cwd does not affect which SQL runs.
export const runMigrationCommand = (command: "up" | "status" | "rollback" | "help"): MigrationResult => {
  const result = spawnSync(
    process.execPath,
    ["--require", "ts-node/register", path.join(repoRoot, "scripts", "migratePostgres.ts"), command],
    {
      cwd: __dirname,
      encoding: "utf8",
      timeout: 180_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "test",
        TS_NODE_TRANSPILE_ONLY: "1",
        POSTGRES_URL: TEST_POSTGRES_URL,
        POSTGRES_MIGRATION_URL: TEST_POSTGRES_URL,
      },
    },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

let migrated = false;

// Every test file calls this in before() so each file can also run standalone.
export const ensureMigrated = (): void => {
  if (migrated) return;
  const result = runMigrationCommand("up");
  if (result.status !== 0) {
    throw new Error(
      `Postgres migrations failed against ${TEST_POSTGRES_URL}. ` +
        "Is the integration stack running? Start it with `npm run integration:up`.\n" +
        `${result.stderr}${result.stdout}`,
    );
  }
  migrated = true;
};

// Fast preflight so a missing Docker stack fails with an actionable message
// instead of twenty connection-timeout stack traces.
export const ensureServices = async (): Promise<void> => {
  try {
    await postgresPool().query("SELECT 1");
  } catch (error) {
    throw new Error(
      "SKIPPING: integration services are not reachable (postgres on localhost:55432). " +
        "Start them with `npm run integration:up` (requires Docker), then re-run `npm run test:integration`. " +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export type Tenant = {
  organizationId: string;
  organizationMongoId: string;
  userId: string;
  actorUserMongoId: string;
  proposalReferenceId: string;
  proposalMongoId: string;
};

// Creates a fresh organization + owner user + proposal_reference with random
// 24-hex external ids. Inserts run on the default (superuser) connection, which
// bypasses RLS — exactly what the backfill/migration tooling does in production.
export const seedTenant = async (label = "Integration Org"): Promise<Tenant> => {
  const organizationMongoId = randomMongoId();
  const actorUserMongoId = randomMongoId();
  const proposalMongoId = randomMongoId();
  const pool = postgresPool();
  const organization = await pool.query<{ id: string }>(
    "INSERT INTO rfpilot.organizations(external_mongo_id,name) VALUES($1,$2) RETURNING id",
    [organizationMongoId, `${label} ${organizationMongoId.slice(0, 8)}`],
  );
  const organizationId = organization.rows[0].id;
  const user = await pool.query<{ id: string }>(
    "INSERT INTO rfpilot.users(organization_id,external_mongo_id) VALUES($1,$2) RETURNING id",
    [organizationId, actorUserMongoId],
  );
  const proposal = await pool.query<{ id: string }>(
    "INSERT INTO rfpilot.proposal_references(organization_id,owner_user_id,external_mongo_id) VALUES($1,$2,$3) RETURNING id",
    [organizationId, user.rows[0].id, proposalMongoId],
  );
  return {
    organizationId,
    organizationMongoId,
    userId: user.rows[0].id,
    actorUserMongoId,
    proposalReferenceId: proposal.rows[0].id,
    proposalMongoId,
  };
};

// Sets the tenant GUCs the RLS policies read (transaction-local; call inside an
// open transaction, mirroring what every repository's tenant() helper does).
export const setTenantGuc = async (
  client: PoolClient,
  organizationId: string,
  organizationMongoId?: string,
): Promise<void> => {
  await client.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
  if (organizationMongoId) {
    await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [organizationMongoId]);
  }
};

// The default Docker superuser bypasses RLS entirely (superusers ignore even
// FORCE ROW LEVEL SECURITY), so RLS assertions need a plain login role.
export const ensureAppRole = async (): Promise<void> => {
  const pool = postgresPool();
  await pool.query(
    "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname='rfpilot_app') THEN CREATE ROLE rfpilot_app LOGIN PASSWORD 'rfpilot_test'; END IF; END $$;",
  );
  await pool.query("GRANT USAGE ON SCHEMA rfpilot TO rfpilot_app");
  await pool.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA rfpilot TO rfpilot_app");
};

let mongoConnected = false;

export const connectMongo = async (): Promise<void> => {
  if (mongoConnected) return;
  await mongoose.connect(process.env.MONGODB_URL as string, {
    dbName: process.env.MONGODB_DB_NAME,
    serverSelectionTimeoutMS: 5_000,
  });
  mongoConnected = true;
};

export const disconnectMongo = async (): Promise<void> => {
  if (!mongoConnected) return;
  await mongoose.disconnect();
  mongoConnected = false;
};

// Creates the Mongo proposal document matching a seeded proposal_reference,
// with the ownership triple (organizationId, userId, _id) the candidate
// application mutation filters on.
export const createMongoProposal = async (tenant: Tenant): Promise<void> => {
  await connectMongo();
  await Proposal.create({
    _id: new mongoose.Types.ObjectId(tenant.proposalMongoId),
    organizationId: new mongoose.Types.ObjectId(tenant.organizationMongoId),
    userId: new mongoose.Types.ObjectId(tenant.actorUserMongoId),
    status: "unsubmitted",
    isDraft: true,
    isArchived: false,
    version: 1,
    event: { eventName: "Integration Fixture Event" },
    contact: {
      contactFirstName: "Integration",
      contactLastName: "Tester",
      contactEmail: "integration@example.com",
      contactPhone: "+1 555 0100",
    },
  });
};

export const closeIntegrationConnections = async (): Promise<void> => {
  await disconnectMongo();
  await closePostgres();
};
