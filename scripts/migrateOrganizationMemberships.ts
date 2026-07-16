import "dotenv/config";
import mongoose from "mongoose";
import { DATABASE_NAME } from "../config/db";
import OrganizationMembership from "../modal/organizationMembershipModel";
import User from "../modal/userModel";
import { buildLegacyMembershipCandidate } from "../src/modules/identity/application/membershipMigration";

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split("=");
  return [key, rest.length ? rest.join("=") : "true"];
}));
const apply = args.get("--apply") === "true";
const rollbackRunId = args.get("--rollback-run");
const runId = args.get("--run-id") || `organization-memberships-${new Date().toISOString()}`;
const mongoUri = process.env.MONGODB_URL || process.env.MONGO_URL;

const help = () => process.stdout.write(`Usage:
  npm run migrate:organization-memberships -- [--run-id=<id>]
  npm run migrate:organization-memberships -- --apply [--run-id=<id>]
  npm run migrate:organization-memberships -- --rollback-run=<id> [--apply]

Default mode is dry-run. Existing memberships are never overwritten.
`);

const main = async () => {
  if (args.has("--help")) return help();
  if (!mongoUri) throw new Error("MONGODB_URL or MONGO_URL is required");
  await mongoose.connect(mongoUri, { dbName: DATABASE_NAME });
  try {
    if (rollbackRunId) {
      const matched = await OrganizationMembership.countDocuments({ migrationRunId: rollbackRunId });
      const deleted = apply
        ? (await OrganizationMembership.deleteMany({ migrationRunId: rollbackRunId })).deletedCount
        : 0;
      process.stdout.write(`${JSON.stringify({ mode: apply ? "apply" : "dry_run", rollbackRunId, matched, deleted }, null, 2)}\n`);
      return;
    }

    const users = await User.find({}).select("_id organizationId role createdAt").lean();
    const candidates = users.filter((user) => user.organizationId).map((user) =>
      buildLegacyMembershipCandidate({
        organizationId: String(user.organizationId),
        userId: String(user._id),
        legacyRole: user.role,
        migrationRunId: runId,
        activatedAt: user.createdAt,
      }),
    );
    const existing = await OrganizationMembership.countDocuments({
      $or: candidates.map((candidate) => ({
        organizationId: candidate.organizationId,
        userId: candidate.userId,
      })),
    });
    if (apply && candidates.length) {
      await OrganizationMembership.bulkWrite(candidates.map((candidate) => ({
        updateOne: {
          filter: {
            organizationId: new mongoose.Types.ObjectId(candidate.organizationId),
            userId: new mongoose.Types.ObjectId(candidate.userId),
          },
          update: { $setOnInsert: {
            ...candidate,
            organizationId: new mongoose.Types.ObjectId(candidate.organizationId),
            userId: new mongoose.Types.ObjectId(candidate.userId),
          } },
          upsert: true,
        },
      })));
    }
    process.stdout.write(`${JSON.stringify({
      mode: apply ? "apply" : "dry_run",
      database: DATABASE_NAME,
      runId,
      users: users.length,
      eligible: candidates.length,
      missingOrganization: users.length - candidates.length,
      existing,
      wouldInsert: candidates.length - existing,
    }, null, 2)}\n`);
  } finally {
    await mongoose.disconnect();
  }
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Membership migration failed"}\n`);
  process.exitCode = 1;
});
