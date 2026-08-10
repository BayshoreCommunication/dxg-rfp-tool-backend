/* Projects every active MongoDB organization membership into the PostgreSQL
   data foundation (rfpilot.organizations + rfpilot.users).

   Sign-in provisions each account on its own (see beginAuthenticatedSession),
   so this exists for one job: repairing the population that signed up before
   that projection existed, without waiting for each person to sign in again.
   It shares the exact same application function as the sign-in path, so there
   is no second definition of "projected" to drift.

   Dry-run by default; --apply performs the writes. Safe to re-run — every
   projection is an idempotent upsert. */
import "../config/env";
import mongoose from "mongoose";
import connectDB from "../config/db";
import { closePostgres } from "../config/postgres";
import Organization from "../modal/organizationModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import User from "../modal/userModel";
import { ensureIdentityProjection } from "../src/modules/dataFoundation/composition";

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split("=");
  return [key, rest.length ? rest.join("=") : "true"];
}));
const apply = args.get("--apply") === "true";
const runId = args.get("--run-id") || `identity-projection-${new Date().toISOString()}`;
const organizationFilter = args.get("--organization-id");

const help = () => process.stdout.write(`Usage:
  npm run backfill:identity-projections -- [--organization-id=<mongo-id>] [--run-id=<id>]
  npm run backfill:identity-projections -- --apply [--organization-id=<mongo-id>] [--run-id=<id>]

Default mode is dry-run. Projections are idempotent upserts, so re-running is safe.
Requires POSTGRES_FOUNDATION_ENABLED and POSTGRES_URL.
`);

const main = async () => {
  if (args.has("--help")) return help();
  await connectDB();

  const organizationQuery = organizationFilter ? { _id: organizationFilter } : {};
  const organizations = await Organization.find({ ...organizationQuery, status: "active" })
    .select("_id name")
    .lean();
  const names = new Map(organizations.map((organization) => [String(organization._id), organization.name]));
  if (!organizations.length) throw new Error("No active organization matched the filter");

  const memberships = await OrganizationMembership.find({
    status: "active",
    organizationId: { $in: organizations.map((organization) => organization._id) },
  }).select("organizationId userId").lean();

  /* A blocked account cannot open a session, so projecting it would create a
     row that nothing is allowed to use. */
  const blocked = new Set(
    (await User.find({
      _id: { $in: memberships.map((membership) => membership.userId) },
      isBlocked: true,
    }).select("_id").lean()).map((user) => String(user._id)),
  );
  const candidates = memberships.filter((membership) => !blocked.has(String(membership.userId)));

  const tally = { created: 0, alreadyPresent: 0, failed: 0, invalid: 0, skipped: 0 };
  const failures: Array<{ userMongoId: string; code: string }> = [];

  if (apply) {
    for (const membership of candidates) {
      const organizationMongoId = String(membership.organizationId);
      const userMongoId = String(membership.userId);
      const outcome = await ensureIdentityProjection({
        organizationMongoId,
        userMongoId,
        correlationId: runId,
        organizationName: names.get(organizationMongoId),
      });
      if (outcome.kind === "ensured") {
        if (outcome.userCreated) tally.created += 1;
        else tally.alreadyPresent += 1;
      } else if (outcome.kind === "failed") {
        tally.failed += 1;
        failures.push({ userMongoId, code: outcome.code });
      } else if (outcome.kind === "invalid_external_id") {
        tally.invalid += 1;
      } else {
        tally.skipped += 1;
      }
    }
  }

  process.stdout.write(`${JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    runId,
    organizations: organizations.length,
    activeMemberships: memberships.length,
    blockedSkipped: blocked.size,
    candidates: candidates.length,
    ...(apply ? { ...tally, failures: failures.slice(0, 20) } : {}),
  }, null, 2)}\n`);

  if (tally.skipped) {
    process.stdout.write(
      "PostgreSQL is not enabled in this environment, so nothing was projected.\n",
    );
  }
  if (tally.failed) process.exitCode = 1;
};

void main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
    await closePostgres();
  });
