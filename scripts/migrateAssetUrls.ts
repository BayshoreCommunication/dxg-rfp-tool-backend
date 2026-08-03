import "dotenv/config";
import mongoose from "mongoose";
import { DATABASE_NAME } from "../config/db";

/* Rewrites absolute asset URLs persisted in Mongo documents (DigitalOcean
 * Spaces bases from the droplet era) to the environment's CDN base
 * (ASSET_STORAGE_PUBLIC_URL_BASE / CloudFront). Deep-walks every document in
 * every collection; a string field is rewritten when it starts with one of
 * the --from prefixes. Dry-run by default; idempotent under re-runs (a
 * rewritten URL no longer matches any --from prefix). */

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split("=");
  return [key, rest.length ? rest.join("=") : "true"];
}));
const apply = args.get("--apply") === "true";
const fromPrefixes = (args.get("--from") || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
const toBase = (args.get("--to") || "").trim().replace(/\/+$/, "");
const onlyCollections = (args.get("--collections") || "").split(",").map((s) => s.trim()).filter(Boolean);
const mongoUri = process.env.MONGODB_URL || process.env.MONGO_URL;

const help = () => process.stdout.write(`Usage:
  ts-node scripts/migrateAssetUrls.ts --from=https://old-base[,https://other-base] --to=https://cdn-base [--collections=a,b] [--apply]

Dry-run by default: reports what would change without writing. --apply
performs the rewrite. Prefixes are matched at the start of string fields.
`);

type Change = { path: string; value: string };

const rewrite = (value: string): string | null => {
  for (const prefix of fromPrefixes) {
    if (value.startsWith(`${prefix}/`) || value === prefix) {
      return `${toBase}${value.slice(prefix.length)}`;
    }
  }
  return null;
};

const walk = (node: unknown, path: string, changes: Change[]): void => {
  if (typeof node === "string") {
    const next = rewrite(node);
    if (next !== null) changes.push({ path, value: next });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, path ? `${path}.${index}` : String(index), changes));
    return;
  }
  if (node && typeof node === "object" && !(node instanceof Date) && !(node instanceof mongoose.Types.ObjectId)) {
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if (key === "_id") continue;
      walk(item, path ? `${path}.${key}` : key, changes);
    }
  }
};

const main = async () => {
  if (args.has("--help")) return help();
  if (!mongoUri) throw new Error("MONGODB_URL or MONGO_URL is required");
  if (!fromPrefixes.length || !toBase) throw new Error("--from and --to are required");
  await mongoose.connect(mongoUri, { dbName: DATABASE_NAME });
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB connection is unavailable");
  try {
    const report: Record<string, { scanned: number; docsChanged: number; fieldsChanged: number }> = {};
    const collections = (await db.collections()).filter((collection) =>
      !collection.collectionName.startsWith("system.") &&
      (onlyCollections.length === 0 || onlyCollections.includes(collection.collectionName)));
    for (const collection of collections) {
      const stats = { scanned: 0, docsChanged: 0, fieldsChanged: 0 };
      let batch: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }> = [];
      const flush = async () => {
        if (batch.length && apply) await collection.bulkWrite(batch, { ordered: false });
        batch = [];
      };
      for await (const doc of collection.find({}, { batchSize: 200 })) {
        stats.scanned += 1;
        const changes: Change[] = [];
        walk(doc, "", changes);
        if (!changes.length) continue;
        stats.docsChanged += 1;
        stats.fieldsChanged += changes.length;
        batch.push({
          updateOne: {
            filter: { _id: doc._id },
            update: { $set: Object.fromEntries(changes.map((change) => [change.path, change.value])) },
          },
        });
        if (batch.length >= 100) await flush();
      }
      await flush();
      if (stats.docsChanged > 0 || stats.scanned > 0) report[collection.collectionName] = stats;
    }
    process.stdout.write(`${JSON.stringify({
      mode: apply ? "apply" : "dry_run",
      database: DATABASE_NAME,
      from: fromPrefixes,
      to: toBase,
      collections: report,
      totals: Object.values(report).reduce(
        (sum, stats) => ({
          scanned: sum.scanned + stats.scanned,
          docsChanged: sum.docsChanged + stats.docsChanged,
          fieldsChanged: sum.fieldsChanged + stats.fieldsChanged,
        }),
        { scanned: 0, docsChanged: 0, fieldsChanged: 0 },
      ),
    }, null, 2)}\n`);
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
