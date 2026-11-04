import "../config/env";
import fs from "node:fs";
import mongoose from "mongoose";
import { Pool } from "pg";
import { DATABASE_NAME } from "../config/db";
import Organization from "../modal/organizationModel";
import {
  compareVisibility,
  findCustomerLeftovers,
  findOrphanedProposals,
  snapshotVisibility,
  type VisibilitySnapshot,
} from "../src/modules/tenancy/migrationVerification";

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split("=");
  return [key, rest.length ? rest.join("=") : "true"];
}));
const snapshotPath = args.get("--snapshot");
const beforePath = args.get("--before");
const fromSlug = args.get("--from-slug") || process.env.DEFAULT_ORGANIZATION_SLUG || "dxg";
const mongoUri = process.env.MONGODB_URL || process.env.MONGO_URL;

const help = () => process.stdout.write(`Usage:
  npm run verify:customer-organizations -- --snapshot=<file>     before the migration
  npm run verify:customer-organizations -- --before=<file> [--from-slug=dxg]   after it

The snapshot records, per active member, the proposal and vendor-response ids they can see (ids
only, no content). Verification then proves: every member in the snapshot sees exactly the same
ids, nothing customer-owned is left in the shared organization, and every proposal's owner is an
active member of its organization. Exits 1 when any check fails.
`);

const main = async () => {
  if (args.has("--help")) return help();
  if (!mongoUri) throw new Error("MONGODB_URL or MONGO_URL is required");
  await mongoose.connect(mongoUri, { dbName: DATABASE_NAME });
  const connectionString = process.env.POSTGRES_MIGRATION_URL || process.env.POSTGRES_URL;
  const pool = connectionString
    ? new Pool({ connectionString, max: 1, ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: true } : undefined })
    : null;
  try {
    if (snapshotPath) {
      const snapshot = await snapshotVisibility();
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
      process.stdout.write(`${JSON.stringify({ mode: "snapshot", file: snapshotPath, members: snapshot.users.length,
        proposals: snapshot.users.reduce((n, u) => n + u.proposals.length, 0) }, null, 2)}\n`);
      return;
    }

    const from = await Organization.findOne({ slug: fromSlug }).select("_id").lean();
    if (!from) throw new Error(`Organization '${fromSlug}' was not found`);
    const visibility = beforePath
      ? compareVisibility(JSON.parse(fs.readFileSync(beforePath, "utf8")) as VisibilitySnapshot, await snapshotVisibility())
      : null;
    const leftovers = await findCustomerLeftovers({ organizationId: String(from._id), pool });
    const orphans = await findOrphanedProposals();
    const checks = {
      visibilityUnchanged: visibility === null ? "skipped: pass --before=<snapshot>" : visibility.length === 0,
      noCustomerRecordsInSharedOrganization: Object.keys(leftovers.mongo).length === 0 && Object.keys(leftovers.postgres).length === 0,
      everyProposalHasAnActiveOwner: orphans.total === 0,
    };
    process.stdout.write(`${JSON.stringify({
      database: DATABASE_NAME, postgres: pool ? "checked" : "skipped", from: fromSlug, checks,
      visibilityDifferences: visibility ?? [], leftovers, orphans,
    }, null, 2)}\n`);
    if (Object.values(checks).some((ok) => ok === false)) process.exitCode = 1;
  } finally {
    await pool?.end();
    await mongoose.disconnect();
  }
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Verification failed"}\n`);
  process.exitCode = 1;
});
