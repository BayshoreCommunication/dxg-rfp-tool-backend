import "../config/env";
import mongoose from "mongoose";
import { Pool } from "pg";
import { DATABASE_NAME } from "../config/db";
import Organization from "../modal/organizationModel";

// Marks DXG's organization as the platform organization whose pricing corpus, expert rules and
// knowledge base every customer organization reads (migration 064). Run once per environment
// after migration 064; until then nothing is shared.

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split("=");
  return [key, rest.length ? rest.join("=") : "true"];
}));
const apply = args.get("--apply") === "true";
const slug = args.get("--slug") || process.env.DEFAULT_ORGANIZATION_SLUG || "dxg";
const mongoUri = process.env.MONGODB_URL || process.env.MONGO_URL;

const CORPUS_TABLES = [
  "pricing_records", "pricing_modifiers", "pricing_regional_factors", "pricing_confidence_rules",
  "expert_rules", "knowledge_releases",
] as const;

const help = () => process.stdout.write(`Usage:
  npm run platform:mark-organization -- [--slug=dxg]
  npm run platform:mark-organization -- --apply [--slug=dxg]

Default mode is dry-run. Refuses when a different organization is already the platform.
`);

const main = async () => {
  if (args.has("--help")) return help();
  if (!mongoUri) throw new Error("MONGODB_URL or MONGO_URL is required");
  const connectionString = process.env.POSTGRES_MIGRATION_URL || process.env.POSTGRES_URL;
  if (!connectionString) throw new Error("POSTGRES_MIGRATION_URL or POSTGRES_URL is required");

  await mongoose.connect(mongoUri, { dbName: DATABASE_NAME });
  const pool = new Pool({ connectionString, max: 1, ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: true } : undefined });
  const client = await pool.connect();
  try {
    const organization = await Organization.findOne({ slug, status: "active" }).select("_id name").lean();
    if (!organization) throw new Error(`Active organization '${slug}' was not found in MongoDB`);
    const mongoId = String(organization._id);

    await client.query("BEGIN");
    // organizations and the corpus tables force row-level security, so act as that tenant.
    await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [mongoId]);
    const target = await client.query<{ id: string; is_platform: boolean }>(
      "SELECT id, is_platform FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
      [mongoId],
    );
    if (!target.rows[0]) throw new Error(`Organization '${slug}' has no active Postgres projection yet; sign in once first`);
    const organizationId = target.rows[0].id;
    await client.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);

    const current = await client.query<{ id: string; external_mongo_id: string }>(
      "SELECT id, external_mongo_id FROM rfpilot.organizations WHERE is_platform",
    );
    const other = current.rows.find((row) => row.id !== organizationId);
    if (other) throw new Error(`Organization ${other.external_mongo_id} is already the platform; unmark it first`);

    const corpus: Record<string, number> = {};
    for (const table of CORPUS_TABLES) {
      const result = await client.query<{ count: string }>(`SELECT count(*) FROM rfpilot.${table} WHERE organization_id=$1`, [organizationId]);
      corpus[table] = Number(result.rows[0].count);
    }

    const alreadyPlatform = target.rows[0].is_platform;
    if (apply && !alreadyPlatform) {
      await client.query("UPDATE rfpilot.organizations SET is_platform=true, updated_at=now() WHERE id=$1", [organizationId]);
    }
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    process.stdout.write(`${JSON.stringify({
      mode: apply ? "apply" : "dry_run",
      organization: { slug, name: organization.name, mongoId, postgresId: organizationId },
      alreadyPlatform,
      marked: apply && !alreadyPlatform,
      corpus,
    }, null, 2)}\n`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
    await mongoose.disconnect();
  }
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Marking the platform organization failed"}\n`);
  process.exitCode = 1;
});
