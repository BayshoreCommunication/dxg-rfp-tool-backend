import "dotenv/config";
import mongoose from "mongoose";
import { DATABASE_NAME } from "../config/db";
import {
  migrateLegacyProposalBatch,
  rollbackCanonicalMigrationRun,
} from "../src/modules/proposals/infrastructure/mongo/canonicalMigrationRepository";

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.split("=");
    return [key, rest.length ? rest.join("=") : "true"];
  }),
);

const organizationId = args.get("--organization-id") ?? "";
const sourceOwnerUserId = args.get("--owner-user-id") ?? "";
const apply = args.get("--apply") === "true";
const runId = args.get("--run-id") ?? `proposal-v1-${new Date().toISOString()}`;
const rollbackRunId = args.get("--rollback-run");
const limitValue = args.get("--limit");
const limit = limitValue ? Number.parseInt(limitValue, 10) : undefined;
const afterId = args.get("--after-id");
const mongoUri =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.MONGODB_URL ||
  process.env.MONGO_URL;

const printHelp = () => {
  process.stdout.write(`Usage:
  npm run migrate:proposal-v1 -- --organization-id=<id> --owner-user-id=<mongo-id> [--run-id=<id>] [--limit=100] [--after-id=<mongo-id>]
  npm run migrate:proposal-v1 -- --organization-id=<id> --owner-user-id=<mongo-id> --apply [--run-id=<id>]
  npm run migrate:proposal-v1 -- --organization-id=<id> --rollback-run=<run-id> [--apply]

The default mode is dry-run. --apply is required for snapshot writes or rollback deletion.
`);
};

const main = async () => {
  if (args.has("--help")) {
    printHelp();
    return;
  }
  if (!mongoUri) {
    throw new Error(
      "MONGODB_URI, MONGO_URI, MONGODB_URL, or MONGO_URL is required",
    );
  }
  if (!organizationId) throw new Error("--organization-id=<id> is required");

  await mongoose.connect(mongoUri, { dbName: DATABASE_NAME });

  try {
    if (rollbackRunId) {
      const result = await rollbackCanonicalMigrationRun({
        organizationId,
        runId: rollbackRunId,
        apply,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      if (!sourceOwnerUserId) {
        throw new Error("--owner-user-id=<mongo-id> is required");
      }
      const result = await migrateLegacyProposalBatch({
        organizationId,
        sourceOwnerUserId,
        runId,
        apply,
        limit,
        afterId,
      });
      const safeOutput = {
        ...result,
        candidates: result.candidates.map((candidate) => ({
          legacyProposalId: candidate.legacyProposalId,
          legacyHash: candidate.legacyHash,
          status: candidate.status,
          issueCount: candidate.issues.length,
        })),
      };
      process.stdout.write(`${JSON.stringify(safeOutput, null, 2)}\n`);
    }
  } finally {
    await mongoose.disconnect();
  }
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Migration command failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
