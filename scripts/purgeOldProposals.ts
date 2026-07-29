/**
 * Permanently remove proposals and their cross-store artifacts.
 *
 * Dry run by default: it prints exactly what it would delete and changes
 * nothing. Applying requires two deliberate flags — `--apply` and
 * `--confirm <n>`, where n must equal the number matched — so a mis-scoped
 * filter cannot quietly delete more than expected.
 *
 * Ordering matters and is the reason to use this rather than a deleteMany:
 * artifacts are purged BEFORE the Mongo delete. Done the other way round, a
 * failure between the two steps strands private S3 objects with nothing left
 * to identify them. See utils/cronJobs.ts, which does the same for the 30-day
 * archive sweep.
 *
 *   npx ts-node scripts/purgeOldProposals.ts --dry-run
 *   npx ts-node scripts/purgeOldProposals.ts --owner someone@example.com
 *   npx ts-node scripts/purgeOldProposals.ts --status draft --apply --confirm 8
 */
import "../config/env";
import mongoose from "mongoose";
import Proposal from "../modal/proposalsModel";
import User from "../modal/userModel";
import { closePostgres, postgresEnabled } from "../config/postgres";
import { purgeProposalArtifacts } from "../src/modules/dataFoundation/purgeProposalArtifacts";

type Status = "draft" | "live" | "all";

type Options = {
  apply: boolean;
  confirm: number | null;
  owners: string[];
  status: Status;
  createdBefore: Date | null;
};

const usage = `
Usage: npx ts-node scripts/purgeOldProposals.ts [options]

  --dry-run                 Default. Report only; change nothing.
  --apply                   Perform the purge. Requires --confirm.
  --confirm <n>             Must equal the number of matched proposals.
  --owner <email>           Restrict to one owner. Repeatable.
  --status <draft|live|all> Default: draft. "live" means already published.
  --created-before <date>   Only proposals created before YYYY-MM-DD.
  --help
`.trim();

const parseArgs = (argv: string[]): Options => {
  const options: Options = { apply: false, confirm: null, owners: [], status: "draft", createdBefore: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "--apply": options.apply = true; break;
      case "--dry-run": options.apply = false; break;
      case "--confirm": options.confirm = Number(next()); break;
      case "--owner": options.owners.push(next().trim().toLowerCase()); break;
      case "--status": {
        const value = next();
        if (value !== "draft" && value !== "live" && value !== "all") throw new Error(`--status must be draft, live or all`);
        options.status = value;
        break;
      }
      case "--created-before": {
        const value = new Date(next());
        if (Number.isNaN(value.getTime())) throw new Error("--created-before must be YYYY-MM-DD");
        options.createdBefore = value;
        break;
      }
      case "--help": case "-h": console.log(usage); process.exit(0); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
};

const statusFilter = (status: Status): Record<string, unknown> => {
  if (status === "draft") return { status: "unsubmitted" };
  if (status === "live") return { status: { $ne: "unsubmitted" } };
  return {};
};

(async () => {
  const options = parseArgs(process.argv.slice(2));

  await mongoose.connect(String(process.env.MONGODB_URL), {
    dbName: process.env.MONGODB_DB_NAME || "dxg_rfp_tool_db",
  });

  const filter: Record<string, unknown> = { ...statusFilter(options.status) };
  if (options.createdBefore) filter.createdAt = { $lt: options.createdBefore };
  if (options.owners.length) {
    const users = await User.find({ email: { $in: options.owners } }).select("_id email").lean<Record<string, any>[]>();
    const missing = options.owners.filter((email) => !users.some((user) => String(user.email).toLowerCase() === email));
    if (missing.length) throw new Error(`No user found for: ${missing.join(", ")}`);
    filter.userId = { $in: users.map((user) => user._id) };
  }

  const matched = await Proposal.find(filter)
    .select("_id status isDraft organizationId userId event.eventName createdAt")
    .lean<Record<string, any>[]>();

  const ownerIds = [...new Set(matched.map((p) => String(p.userId)))].filter((id) => mongoose.isValidObjectId(id));
  const owners = await User.find({ _id: { $in: ownerIds } }).select("_id email").lean<Record<string, any>[]>();
  const emailById = new Map(owners.map((user) => [String(user._id), String(user.email)]));

  const live = matched.filter((p) => p.status !== "unsubmitted");
  // purgeProposalArtifacts resolves the tenant from organizationId. Without one
  // it cannot set the RLS GUC, so S3 objects and Postgres rows would survive a
  // Mongo delete with nothing left pointing at them.
  const withoutOrg = matched.filter((p) => !p.organizationId);
  const distinctOwners = new Set(matched.map((p) => emailById.get(String(p.userId)) ?? `unresolved:${p.userId}`));

  console.log(`\nDatabase        : ${mongoose.connection.name}`);
  console.log(`Filter          : status=${options.status}${options.owners.length ? `, owner=${options.owners.join(",")}` : ""}${options.createdBefore ? `, createdBefore=${options.createdBefore.toISOString().slice(0, 10)}` : ""}`);
  console.log(`Matched         : ${matched.length} proposal(s) across ${distinctOwners.size} owner(s)`);
  console.log(`Owners          : ${[...distinctOwners].join(", ") || "—"}`);
  console.log(`Postgres        : ${postgresEnabled() ? "enabled — artifacts will be purged" : "DISABLED — S3/Postgres artifacts will NOT be purged"}`);

  if (live.length) console.log(`\n  ⚠ ${live.length} of these are LIVE — already published to vendors.`);
  if (withoutOrg.length) console.log(`  ⚠ ${withoutOrg.length} have no organizationId; their S3 objects and Postgres rows cannot be purged and would be orphaned.`);

  console.log("\nProposals:");
  for (const proposal of matched) {
    const label = proposal.event?.eventName?.trim() || "Untitled Proposal";
    const created = proposal.createdAt ? new Date(proposal.createdAt).toISOString().slice(0, 10) : "unknown";
    console.log(`  ${String(proposal._id)}  ${proposal.status === "unsubmitted" ? "draft" : "LIVE "}  ${created}  ${emailById.get(String(proposal.userId)) ?? "unknown owner"}  ${label}`);
  }

  if (!options.apply) {
    console.log(`\nDry run — nothing changed. To apply:\n  --apply --confirm ${matched.length}\n`);
    await mongoose.disconnect();
    await closePostgres();
    return;
  }

  if (options.confirm !== matched.length) {
    console.error(`\nRefusing to apply: --confirm ${options.confirm ?? "(missing)"} does not match ${matched.length} matched proposal(s).`);
    console.error("Re-run the dry run, check the list above, then pass the exact count.\n");
    await mongoose.disconnect();
    await closePostgres();
    process.exitCode = 1;
    return;
  }

  if (!matched.length) {
    console.log("\nNothing to purge.\n");
    await mongoose.disconnect();
    await closePostgres();
    return;
  }

  // Artifacts first: a failure here leaves the Mongo record in place, so the
  // proposal remains identifiable and the run can simply be repeated.
  console.log("\nPurging cross-store artifacts…");
  await purgeProposalArtifacts(
    matched
      .map((proposal) => ({ proposalMongoId: String(proposal._id), organizationMongoId: String(proposal.organizationId ?? "") }))
      .filter((row) => row.organizationMongoId),
  );

  console.log("Deleting proposals…");
  const result = await Proposal.deleteMany({ _id: { $in: matched.map((proposal) => proposal._id) } });
  console.log(`\nDeleted ${result.deletedCount} proposal(s).`);
  console.log("Immutable AI evidence and audit rows are retained until their own retention windows expire.\n");

  await mongoose.disconnect();
  await closePostgres();
})().catch(async (error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  await mongoose.disconnect().catch(() => {});
  await closePostgres().catch(() => {});
  process.exitCode = 1;
});
