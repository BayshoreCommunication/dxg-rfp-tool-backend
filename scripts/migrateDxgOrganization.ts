import "dotenv/config";
import mongoose from "mongoose";
import { DATABASE_NAME } from "../config/db";
import Organization from "../modal/organizationModel";

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split("=");
  return [key, rest.length ? rest.join("=") : "true"];
}));
const apply = args.get("--apply") === "true";
const rollbackRunId = args.get("--rollback-run");
const runId = args.get("--run-id") || `dxg-tenant-${new Date().toISOString()}`;
const name = args.get("--name") || "DXG";
const slug = args.get("--slug") || "dxg";
const mongoUri = process.env.MONGODB_URL || process.env.MONGO_URL;
const targets = ["users", "proposals", "settings", "emailcampaigns", "notifications", "vendorresponses"] as const;
const missingOrganization = { $or: [{ organizationId: { $exists: false } }, { organizationId: null }] };

const help = () => process.stdout.write(`Usage:
  npm run migrate:dxg-organization -- [--name=DXG] [--slug=dxg] [--run-id=<id>]
  npm run migrate:dxg-organization -- --apply [--name=DXG] [--slug=dxg] [--run-id=<id>]
  npm run migrate:dxg-organization -- --rollback-run=<id> [--apply]

Default mode is dry-run. Apply writes an exact per-document rollback journal.
`);

const main = async () => {
  if (args.has("--help")) return help();
  if (!mongoUri) throw new Error("MONGODB_URL or MONGO_URL is required");
  await mongoose.connect(mongoUri, { dbName: DATABASE_NAME });
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB connection is unavailable");
  try {
    const journals = db.collection("tenantmigrationjournals");
    if (rollbackRunId) {
      const entries = await journals.find({ runId: rollbackRunId }).toArray();
      const matched: Record<string, number> = {};
      for (const entry of entries) matched[String(entry.collectionName)] = (matched[String(entry.collectionName)] || 0) + 1;
      if (apply) {
        for (const collectionName of targets) {
          const ids = entries.filter((entry) => entry.collectionName === collectionName).map((entry) => entry.documentId);
          if (ids.length) await db.collection(collectionName).updateMany({ _id: { $in: ids } }, { $unset: { organizationId: "" } });
        }
        await journals.deleteMany({ runId: rollbackRunId });
      }
      process.stdout.write(`${JSON.stringify({ mode: apply ? "apply" : "dry_run", rollbackRunId, matched }, null, 2)}\n`);
      return;
    }

    const existing = await Organization.findOne({ slug }).lean();
    const organizationId = existing?._id ?? new mongoose.Types.ObjectId();
    const collections: Record<string, { total: number; missing: number; conflicting: number }> = {};
    for (const collectionName of targets) {
      const collection = db.collection(collectionName);
      collections[collectionName] = {
        total: await collection.countDocuments({}),
        missing: await collection.countDocuments(missingOrganization),
        conflicting: await collection.countDocuments({ organizationId: { $exists: true, $nin: [null, organizationId] } }),
      };
    }

    if (apply) {
      await Organization.updateOne({ slug }, { $setOnInsert: { _id: organizationId, name, slug, status: "active" } }, { upsert: true, runValidators: true });
      await journals.createIndex({ runId: 1, collectionName: 1, documentId: 1 }, { unique: true });
      for (const collectionName of targets) {
        const collection = db.collection(collectionName);
        const docs = await collection.find(missingOrganization, { projection: { _id: 1 } }).toArray();
        if (!docs.length) continue;
        await journals.bulkWrite(docs.map(({ _id }) => ({ updateOne: {
          filter: { runId, collectionName, documentId: _id },
          update: { $setOnInsert: { runId, collectionName, documentId: _id, organizationId, createdAt: new Date() } },
          upsert: true,
        } })));
        await collection.updateMany({ _id: { $in: docs.map(({ _id }) => _id) }, ...missingOrganization }, { $set: { organizationId } });
      }
    }
    process.stdout.write(`${JSON.stringify({ mode: apply ? "apply" : "dry_run", database: DATABASE_NAME, runId,
      organization: { id: organizationId.toString(), name, slug, exists: Boolean(existing) }, collections }, null, 2)}\n`);
  } finally {
    await mongoose.disconnect();
  }
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Migration failed"}\n`);
  process.exitCode = 1;
});
