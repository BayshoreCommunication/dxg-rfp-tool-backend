// Builds a legacy-shaped fixture for rehearsing the tenancy migration (ORG-501): one shared
// organization holding many customers the way production did before Organization Accounts, each
// with RFPs and the MongoDB documents and Postgres rows that ORG-107 moves. Every name, email
// and RFP is generated; nothing comes from a real customer.
//
//   npm run rehearsal:up                                  # stack, owner role, migrations
//   npm run rehearsal:seed -- --users=50 [--heavy-proposals=150]
//   npm run rehearsal:seed -- --reset --users=500         # wipe the rehearsal data first
//
// It refuses to run unless RFPILOT_ENV_FILE is deploy/rehearsal/rehearsal.env and every
// connection string targets the rehearsal stack's loopback ports, so it can never write to
// another database. `--bootstrap` only creates the table-owner role the migration connects as.
import "../config/env";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { Pool, type PoolClient } from "pg";
import Organization from "../modal/organizationModel";
import Proposal from "../modal/proposalsModel";
import { MOVABLE_COLLECTIONS } from "../src/modules/tenancy/mongoTenantMove";

const ENV_FILE = "deploy/rehearsal/rehearsal.env";
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1)$/;
const MONGO_PORT = "37017";
const POSTGRES_PORT = "35432";
const OWNER_ROLE = "rfpilot_migrator";
const SHARED_SLUG = process.env.DEFAULT_ORGANIZATION_SLUG || "dxg";
// RFPs per customer cycle through this list (average about 4.4); customer 1 is the heavy one.
const PROPOSAL_COUNTS = [0, 1, 2, 3, 5, 8, 12];

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split("=");
  return [key, rest.length ? rest.join("=") : "true"];
}));
const wholeNumber = (name: string, fallback: number, max: number): number => {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > max) throw new Error(`${name} must be a whole number up to ${max}`);
  return Number(raw);
};

const assertRehearsalStack = () => {
  const fail = (reason: string): never => {
    throw new Error(`seedTenancyRehearsalFixture refused: ${reason}. Run it through \`npm run rehearsal:seed\`.`);
  };
  if (process.env.RFPILOT_ENV_FILE?.trim() !== ENV_FILE) fail(`RFPILOT_ENV_FILE is not ${ENV_FILE}`);
  const mongoUrl = process.env.MONGODB_URL ?? fail("MONGODB_URL is not set");
  const mongo = new URL(mongoUrl);
  if (!LOCAL_HOSTS.test(mongo.hostname) || mongo.port !== MONGO_PORT) fail(`MONGODB_URL is not the rehearsal stack (${mongo.host})`);
  const urls = ["POSTGRES_URL", "POSTGRES_MIGRATION_URL", "REHEARSAL_POSTGRES_SUPERUSER_URL"].map((name) => {
    const url = new URL(process.env[name] ?? fail(`${name} is not set`));
    if (!LOCAL_HOSTS.test(url.hostname) || url.port !== POSTGRES_PORT) fail(`${name} is not the rehearsal stack (${url.host})`);
    return url;
  });
  if (urls[1].username !== OWNER_ROLE) fail(`POSTGRES_MIGRATION_URL must log in as ${OWNER_ROLE}`);
  return {
    mongoUrl,
    superuserUrl: String(urls[2]),
    ownerPassword: decodeURIComponent(urls[1].password),
    database: urls[2].pathname.slice(1),
    targets: { mongo: `${mongo.host}${mongo.pathname}`, postgres: `${urls[2].host}${urls[2].pathname}` },
  };
};

// Production's migration role owns the tables and is neither superuser nor BYPASSRLS. Creating
// the same kind of role here means a rehearsal can fail on a missing privilege, as production would.
const bootstrap = async (pool: Pool, database: string, ownerPassword: string) => {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  const exists = (await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [OWNER_ROLE])).rowCount;
  if (!exists) await pool.query(`CREATE ROLE ${OWNER_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS`);
  await pool.query(`ALTER ROLE ${OWNER_ROLE} PASSWORD '${ownerPassword.replace(/'/g, "''")}'`);
  await pool.query(`GRANT CREATE ON DATABASE "${database.replace(/"/g, '""')}" TO ${OWNER_ROLE}`);
  await pool.query(`GRANT CREATE ON SCHEMA public TO ${OWNER_ROLE}`);
};

const oid = () => new mongoose.Types.ObjectId();
const hex = (bytes: number) => crypto.randomBytes(bytes).toString("hex");
const pad = (n: number) => String(n).padStart(5, "0");
type Doc = Record<string, unknown>;
type Batches = Record<string, Doc[]>;
type Row = unknown[];

const insertRows = async (client: PoolClient, table: string, columns: string[], rows: Row[]) => {
  const size = Math.max(1, Math.floor(20000 / columns.length));
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const values = chunk.map((_, r) => `(${columns.map((__, c) => `$${r * columns.length + c + 1}`).join(",")})`).join(",");
    await client.query(`INSERT INTO rfpilot."${table}"(${columns.join(",")}) VALUES ${values}`, chunk.flat());
  }
};

const PG_COLUMNS: Record<string, string[]> = {
  users: ["id", "organization_id", "external_mongo_id"],
  proposal_references: ["id", "organization_id", "owner_user_id", "external_mongo_id"],
  conversations: ["id", "organization_id", "proposal_reference_id", "owner_external_user_id"],
  conversation_messages: ["id", "organization_id", "conversation_id", "ordinal", "role", "kind", "content"],
  guidance_reports: ["id", "organization_id", "proposal_reference_id", "actor_external_user_id", "proposal_version", "overall_completeness", "correlation_id"],
  source_extraction_runs: ["id", "organization_id", "proposal_reference_id", "vendor_submission_mongo_id", "vendor_submission_version_mongo_id",
    "source_kind", "source_label", "mime_type", "source_checksum", "policy_version", "idempotency_key"],
  outbox_events: ["organization_id", "aggregate_type", "aggregate_id", "event_type", "idempotency_key", "payload", "status"],
  audit_events: ["id", "organization_id", "actor_external_user_id", "action", "target_type", "decision", "correlation_id"],
  expert_rules: ["id", "organization_id", "rule_key", "title", "updated_by_external_user_id"],
  pricing_regional_factors: ["id", "organization_id", "market", "factor", "created_by_external_user_id"],
};

// One organization's worth of people and records, in the shape the shared organization had.
const buildOrganization = (input: {
  organizationId: mongoose.Types.ObjectId; pgOrganizationId: string; label: string;
  customers: number; heavyProposals: number; legacy: boolean;
}) => {
  const mongo: Batches = {};
  const pg: Record<string, Row[]> = {};
  const push = (name: string, doc: Doc) => (mongo[name] ??= []).push(doc);
  const row = (name: string, values: Row) => (pg[name] ??= []).push(values);
  const { organizationId, pgOrganizationId } = input;
  const now = new Date();

  for (let i = 0; i < input.customers; i++) {
    const userId = oid();
    const n = `${input.label}-${pad(i)}`;
    push("users", {
      _id: userId, organizationId, name: `Rehearsal Customer ${n}`, email: `customer-${n}@rehearsal.example.test`,
      password: "not-a-real-hash", role: "customer", company: i % 3 === 0 ? `Rehearsal Events ${n}` : undefined,
      isBlocked: false, createdAt: now, updatedAt: now,
    });
    // Legacy memberships: some carry DXG roles (raw insert; today's validator refuses them), a
    // few are suspended, and a few accounts predate memberships and have none.
    if (!input.legacy) {
      push("organizationmemberships", { organizationId, userId, roles: [i === 0 ? "owner" : "planner"], status: "active", version: 1, createdAt: now, updatedAt: now });
    } else if (i % 25 !== 7) {
      push("organizationmemberships", {
        organizationId, userId, roles: i % 10 === 3 ? ["planner", "dxg_producer"] : ["planner"],
        status: i % 40 === 11 ? "suspended" : "active", version: i % 10 === 3 ? 3 : 1, createdAt: now, updatedAt: now,
      });
    }
    push("settings", { organizationId, userId, createdAt: now, updatedAt: now });
    push("refreshsessions", {
      organizationId, userId, sessionId: hex(8), familyId: hex(8), tokenId: hex(16), tokenHash: hex(32), status: "active",
      expiresAt: new Date(now.getTime() + 30 * 86400000), createdAt: now, updatedAt: now,
    });
    for (let k = 0; k < 3; k++) push("notifications", { organizationId, userId, type: "rehearsal", title: "Rehearsal", message: "Generated", isRead: false, createdAt: now, updatedAt: now });
    if (i % 6 === 0) {
      const ticketId = oid();
      push("supporttickets", { _id: ticketId, organizationId, requesterUserId: userId, ticketNumber: i + 1, subject: "Rehearsal ticket", status: "open", createdAt: now, updatedAt: now });
      for (let k = 0; k < 2; k++) push("supportmessages", { organizationId, ticketId, authorUserId: userId, body: "Generated message", createdAt: now, updatedAt: now });
    }

    // One in five customers never used an AI feature, so nothing of theirs was projected to Postgres.
    const projected = i % 5 !== 4;
    const pgUserId = crypto.randomUUID();
    if (projected) {
      row("users", [pgUserId, pgOrganizationId, String(userId)]);
      for (let k = 0; k < 3; k++) row("audit_events", [crypto.randomUUID(), pgOrganizationId, String(userId), "rehearsal_action", "proposal", "allowed", crypto.randomUUID()]);
    }

    const proposals = input.legacy && i === 1 ? input.heavyProposals : PROPOSAL_COUNTS[i % PROPOSAL_COUNTS.length];
    for (let j = 0; j < proposals; j++) {
      const proposalId = oid();
      // The model fills in the defaults a real RFP carries; the insert itself stays raw and fast.
      push("proposals", new Proposal({ _id: proposalId, organizationId, userId, event: { eventName: `Rehearsal event ${n}-${j}` } }).toObject({ depopulate: true }) as unknown as Doc);
      if (j % 2 === 0) {
        push("publicaccessgrants", { organizationId, resourceType: "proposal", resourceId: proposalId, purpose: "proposal:view", tokenHash: hex(32), createdAt: now, updatedAt: now });
        for (let k = 0; k < 2; k++) {
          const responseId = oid();
          push("vendorresponses", {
            _id: responseId, organizationId, proposalId, proposalOwnerId: userId, vendorName: `Rehearsal AV ${k}`, submittedBy: "Vendor",
            email: `vendor-${k}@rehearsal.example.test`, emailTrackingId: hex(12), isRead: false, createdAt: now, updatedAt: now,
          });
          if (k === 0 && j % 3 === 0) {
            const submissionId = oid();
            push("vendorsubmissions", {
              _id: submissionId, organizationId, proposalId, proposalOwnerId: userId, legacyVendorResponseId: responseId,
              vendorIdentityKey: hex(8), primaryEmail: `vendor-${k}@rehearsal.example.test`, createdAt: now, updatedAt: now,
            });
            push("vendorsubmissionversions", { organizationId, proposalId, submissionId, versionNumber: 1, idempotencyKey: hex(12), receivedAt: now, createdAt: now, updatedAt: now });
          }
        }
      }
      if (j % 4 === 0) push("proposalcanonicalsnapshots", { organizationId, legacyProposalId: proposalId, legacyHash: hex(16), migrationRelease: "rehearsal", runId: "rehearsal", status: "valid", createdAt: now });
      if (j === 0) push("emailcampaigns", { organizationId, userId, proposalId, recipients: [{ email: "vendor-0@rehearsal.example.test", trackingId: hex(12) }], createdAt: now, updatedAt: now });

      if (!projected) continue;
      const referenceId = crypto.randomUUID();
      row("proposal_references", [referenceId, pgOrganizationId, pgUserId, String(proposalId)]);
      if (j % 2 === 0) {
        const conversationId = crypto.randomUUID();
        row("conversations", [conversationId, pgOrganizationId, referenceId, String(userId)]);
        for (let k = 1; k <= 4; k++) row("conversation_messages", [crypto.randomUUID(), pgOrganizationId, conversationId, k, k % 2 ? "user" : "assistant", "note", "Generated message"]);
        // Published history, as the outbox holds after it has drained. It names its aggregate by id only.
        row("outbox_events", [pgOrganizationId, "conversation", conversationId, "rehearsal.generated", hex(12), "{}", "published"]);
      } else {
        row("guidance_reports", [crypto.randomUUID(), pgOrganizationId, referenceId, String(userId), 1, 0.5, crypto.randomUUID()]);
      }
      if (j % 3 === 0) {
        row("source_extraction_runs", [crypto.randomUUID(), pgOrganizationId, referenceId, String(oid()), String(oid()),
          "cover_message", "cover", "text/plain", hex(32), "v1", hex(12)]);
      }
    }
  }
  return { mongo, pg };
};

const seed = async (superuser: Pool, customers: number, heavyProposals: number) => {
  if (await Organization.exists({ slug: SHARED_SLUG })) {
    throw new Error(`The rehearsal database already holds '${SHARED_SLUG}'. Pass --reset to rebuild it.`);
  }
  const db = mongoose.connection.db!;
  // The indexes production has, so query plans and unique constraints behave the same.
  for (const model of Object.values(mongoose.models)) await model.createIndexes();

  const shared = { mongoId: oid(), pgId: crypto.randomUUID() };
  const bystander = { mongoId: oid(), pgId: crypto.randomUUID() };
  const now = new Date();
  await Organization.collection.insertMany([
    { _id: shared.mongoId, name: "Rehearsal Shared", slug: SHARED_SLUG, status: "active", kind: "customer", plan: "full_access", proposalsCreated: 0, createdAt: now, updatedAt: now },
    // An organization created after Organization Accounts shipped. The migration must not touch it.
    { _id: bystander.mongoId, name: "Rehearsal Bystander", slug: "rehearsal-bystander", status: "active", kind: "customer", plan: "free_trial", proposalsCreated: 1, createdAt: now, updatedAt: now },
  ]);

  const legacy = buildOrganization({ organizationId: shared.mongoId, pgOrganizationId: shared.pgId, label: "c", customers, heavyProposals, legacy: true });
  const other = buildOrganization({ organizationId: bystander.mongoId, pgOrganizationId: bystander.pgId, label: "b", customers: 3, heavyProposals: 0, legacy: false });

  // DXG staff stay in the shared organization with their records and DXG's corpus.
  const staff: Doc[] = [];
  const staffRows: Record<string, Row[]> = { users: [], audit_events: [], expert_rules: [], pricing_regional_factors: [] };
  for (let i = 0; i < 3; i++) {
    const userId = oid();
    staff.push({ _id: userId, organizationId: shared.mongoId, name: `Rehearsal Staff ${i}`, email: `staff-${i}@rehearsal.example.test`, password: "not-a-real-hash", role: i === 0 ? "super_admin" : "admin", isBlocked: false, createdAt: now, updatedAt: now });
    (legacy.mongo.organizationmemberships ??= []).push({ organizationId: shared.mongoId, userId, roles: ["dxg_admin"], status: "active", version: 1, createdAt: now, updatedAt: now });
    staffRows.users.push([crypto.randomUUID(), shared.pgId, String(userId)]);
    for (let k = 0; k < 2; k++) staffRows.audit_events.push([crypto.randomUUID(), shared.pgId, String(userId), "rehearsal_staff_action", "proposal", "allowed", crypto.randomUUID()]);
    staffRows.expert_rules.push([crypto.randomUUID(), shared.pgId, `rehearsal-rule-${i}`, `Rehearsal rule ${i}`, String(userId)]);
    staffRows.pricing_regional_factors.push([crypto.randomUUID(), shared.pgId, `Rehearsal market ${i}`, 1.1, String(userId)]);
  }
  (legacy.mongo.users ??= []).push(...staff);

  const mongoCounts: Record<string, number> = {};
  for (const batches of [legacy.mongo, other.mongo]) {
    for (const [name, docs] of Object.entries(batches)) {
      for (let i = 0; i < docs.length; i += 2000) await db.collection(name).insertMany(docs.slice(i, i + 2000), { ordered: false });
      mongoCounts[name] = (mongoCounts[name] ?? 0) + docs.length;
    }
  }

  const pgCounts: Record<string, number> = {};
  const client = await superuser.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO rfpilot.organizations(id, external_mongo_id, name) VALUES($1,$2,$3),($4,$5,$6)",
      [shared.pgId, String(shared.mongoId), "Rehearsal Shared", bystander.pgId, String(bystander.mongoId), "Rehearsal Bystander"]);
    for (const rows of [legacy.pg, other.pg, staffRows]) {
      // Parents first: PG_COLUMNS is declared in foreign-key order.
      for (const name of Object.keys(PG_COLUMNS)) {
        if (!rows[name]?.length) continue;
        await insertRows(client, name, PG_COLUMNS[name], rows[name]);
        pgCounts[name] = (pgCounts[name] ?? 0) + rows[name].length;
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return {
    sharedOrganization: { slug: SHARED_SLUG, customers, staff: staff.length, heavyCustomerProposals: heavyProposals },
    bystanderOrganization: { slug: "rehearsal-bystander", members: 3 },
    mongo: mongoCounts,
    postgres: pgCounts,
    movedCollections: MOVABLE_COLLECTIONS,
  };
};

const reset = async (superuser: Pool) => {
  await mongoose.connection.db!.dropDatabase();
  // Tenant tables are append-only by trigger for the roles the app uses; the superuser clears them.
  const exists = (await superuser.query("SELECT to_regclass('rfpilot.organizations') AS t")).rows[0].t;
  if (exists) await superuser.query("TRUNCATE rfpilot.organizations CASCADE");
};

const main = async () => {
  const stack = assertRehearsalStack();
  process.stdout.write(`Rehearsal targets: mongo ${stack.targets.mongo}, postgres ${stack.targets.postgres}\n`);
  const superuser = new Pool({ connectionString: stack.superuserUrl, max: 2 });
  try {
    if (args.has("--bootstrap")) {
      await bootstrap(superuser, stack.database, stack.ownerPassword);
      process.stdout.write(`Role ${OWNER_ROLE} is ready to own the schema (no superuser, no BYPASSRLS).\n`);
      return;
    }
    const customers = wholeNumber("--users", 50, 5000);
    const heavyProposals = wholeNumber("--heavy-proposals", 150, 2000);
    await mongoose.connect(stack.mongoUrl, { dbName: process.env.MONGODB_DB_NAME });
    if (args.has("--reset")) await reset(superuser);
    const report = await seed(superuser, customers, heavyProposals);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await superuser.end();
    await mongoose.disconnect();
  }
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Rehearsal fixture failed"}\n`);
  process.exitCode = 1;
});
