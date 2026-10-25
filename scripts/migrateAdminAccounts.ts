import "dotenv/config";
import mongoose from "mongoose";
import { DATABASE_NAME } from "../config/db";
import Admin from "../modal/adminModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import Proposal from "../modal/proposalsModel";
import SupportTicket from "../modal/supportTicketModel";
import User from "../modal/userModel";
import {
  isLegacyAdminRole,
  planAdminAccountMigration,
  type AdminMigrationAction,
} from "../src/modules/identity/application/adminAccountMigration";
import { legacyRoleToMembershipRoles } from "../src/modules/identity/application/membershipMigration";

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split("=");
  return [key, rest.length ? rest.join("=") : "true"];
}));
const apply = args.get("--apply") === "true";
const runId = args.get("--run-id") || `admin-accounts-${new Date().toISOString()}`;
const forceSplitEmails = new Set(
  String(args.get("--split-email") ?? "")
    .split(",")
    .map((email) => email.toLowerCase().trim())
    .filter(Boolean),
);
const mongoUri = process.env.MONGODB_URL || process.env.MONGO_URL;

const help = () => process.stdout.write(`Usage:
  npm run migrate:admin-accounts -- [--split-email=a@x.com,b@y.com] [--run-id=<id>]
  npm run migrate:admin-accounts -- --apply [--split-email=...] [--run-id=<id>]

Moves administrator accounts from \`users\` into \`admins\`. Default mode is
dry-run and prints the plan. Pure admins move with the same _id; accounts also
used as planners (own proposals or support tickets, Google sign-in, or listed
in --split-email) are split into a planner in \`users\` and a new admin in
\`admins\`. Re-running after --apply finds nothing left to do.
`);

type LegacyUser = {
  _id: mongoose.Types.ObjectId;
  organizationId?: mongoose.Types.ObjectId;
  name: string;
  email: string;
  phone?: string;
  password?: string;
  avatar?: string;
  googleId?: string;
  role?: string;
  isBlocked?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

const adminDocument = (user: LegacyUser, id: mongoose.Types.ObjectId, now: Date) => ({
  _id: id,
  organizationId: user.organizationId,
  name: user.name,
  email: user.email.toLowerCase().trim(),
  phone: user.phone,
  // Already a bcrypt hash: written through the driver so the model's
  // pre-save hook cannot hash it a second time.
  password: user.password,
  avatar: user.avatar,
  role: user.role,
  isBlocked: Boolean(user.isBlocked),
  createdAt: user.createdAt ?? now,
  updatedAt: now,
  __v: 0,
});

const setMembershipRoles = async (
  userId: mongoose.Types.ObjectId,
  organizationId: mongoose.Types.ObjectId,
  roles: string[],
  now: Date,
) => {
  const membership = await OrganizationMembership.findOne({ userId, organizationId }).lean();
  if (!membership) {
    await OrganizationMembership.collection.insertOne({
      userId,
      organizationId,
      roles,
      status: "active",
      version: 1,
      activatedAt: now,
      invitedAt: null,
      suspendedAt: null,
      removedAt: null,
      migrationRunId: runId,
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });
    return;
  }
  const same = membership.roles.length === roles.length && roles.every((role) => membership.roles.includes(role as never));
  if (same) return;
  // Bumping the version makes every token minted under the old roles stale.
  await OrganizationMembership.updateOne(
    { _id: membership._id },
    { $set: { roles, updatedAt: now }, $inc: { version: 1 } },
  );
};

const applyAction = async (action: AdminMigrationAction) => {
  if (action.kind === "skip") return;
  const now = new Date();
  const user = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(action.id) }) as LegacyUser | null;
  if (!user || !isLegacyAdminRole(user.role)) return; // changed since planning
  if (!user.organizationId || !user.password) {
    throw new Error(`${action.email} has no organization or password; resolve it by hand`);
  }
  const adminRoles = legacyRoleToMembershipRoles(user.role);

  if (action.kind === "move") {
    await Admin.collection.insertOne(adminDocument(user, user._id, now));
    await User.collection.deleteOne({ _id: user._id });
    await setMembershipRoles(user._id, user.organizationId, adminRoles, now);
    return;
  }

  const adminId = new mongoose.Types.ObjectId();
  await Admin.collection.insertOne(adminDocument(user, adminId, now));
  await setMembershipRoles(adminId, user.organizationId, adminRoles, now);
  await User.collection.updateOne({ _id: user._id }, { $set: { role: "customer", updatedAt: now } });
  await setMembershipRoles(user._id, user.organizationId, ["planner"], now);
};

const main = async () => {
  if (args.has("--help")) return help();
  if (!mongoUri) throw new Error("MONGODB_URL or MONGO_URL is required");
  await mongoose.connect(mongoUri, { dbName: DATABASE_NAME });
  try {
    const legacy = await User.find({ role: { $in: ["admin", "super_admin", "superadmin"] } })
      .select("_id email role googleId")
      .lean();
    const candidates = await Promise.all(legacy.map(async (user) => ({
      id: String(user._id),
      email: user.email,
      role: String(user.role),
      ownedProposals: await Proposal.countDocuments({ userId: user._id }),
      requestedTickets: await SupportTicket.countDocuments({ requesterUserId: user._id }),
      hasGoogleId: Boolean(user.googleId),
    })));
    const existingAdminEmails = new Set(
      (await Admin.find({ email: { $in: candidates.map((candidate) => candidate.email.toLowerCase().trim()) } })
        .select("email")
        .lean()).map((admin) => admin.email),
    );
    const plan = planAdminAccountMigration({ candidates, existingAdminEmails, forceSplitEmails });

    if (apply) {
      await Admin.createIndexes();
      for (const action of plan) await applyAction(action);
    }

    process.stdout.write(`${JSON.stringify({
      mode: apply ? "apply" : "dry_run",
      database: DATABASE_NAME,
      runId,
      legacyAdmins: candidates.length,
      move: plan.filter((action) => action.kind === "move").length,
      split: plan.filter((action) => action.kind === "split").length,
      skip: plan.filter((action) => action.kind === "skip").length,
      plan,
    }, null, 2)}\n`);
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
