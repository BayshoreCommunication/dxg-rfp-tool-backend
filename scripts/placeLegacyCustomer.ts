import "../config/env";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { Pool } from "pg";
import { DATABASE_NAME } from "../config/db";
import Admin from "../modal/adminModel";
import Organization from "../modal/organizationModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import Proposal from "../modal/proposalsModel";
import User from "../modal/userModel";
import {
  PLACEMENT_ROLES,
  placeLegacyCustomer,
  PlacementError,
  rollbackPlacement,
  type PlacementTarget,
} from "../src/modules/tenancy/legacyCustomerPlacement";

// ORG-110 from the command line. Sign-in refuses an account still in a legacy holding tenant
// (ORGANIZATION_SETUP_REQUIRED) until DXG places it. The API normally does that, but moving
// Postgres rows needs the table-owner role, which in production only the one-off migration task
// holds, so DXG runs this there. Same code path, journal, checks, audit and rollback as the API.

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split("=");
  return [key, rest.length ? rest.join("=") : "true"];
}));
const arg = (name: string) => args.get(name)?.trim() || undefined;
const apply = args.get("--apply") === "true";
const mongoUri = process.env.MONGODB_URL || process.env.MONGO_URL;

const help = () => process.stdout.write(`Usage (dry run unless --apply):
  node dist/scripts/placeLegacyCustomer.js --list
  node dist/scripts/placeLegacyCustomer.js --email=<customer> --admin-email=<DXG admin> --new-org="<name>" [--type=<type>] [--country=US] [--time-zone=America/New_York] [--apply]
  node dist/scripts/placeLegacyCustomer.js --email=<customer> --admin-email=<DXG admin> --org-slug=<slug> --role=organization_admin|team_manager|planner [--team-id=<id>] [--apply]
  node dist/scripts/placeLegacyCustomer.js --rollback=<runId> --admin-email=<DXG admin> [--apply]

--new-org makes the customer Owner of a new organization. --org-slug adds them to an existing
one with the given role (never Owner or Viewer). The audit trail records --admin-email as the actor.
`);

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

const listUnplaced = async () => {
  const holdings = await Organization.find({ kind: "legacy_holding", status: "active" }).select("_id").lean();
  const memberships = await OrganizationMembership.find({ organizationId: { $in: holdings.map((h) => h._id) }, status: "active" }).select("userId organizationId").lean();
  const users = await User.find({ _id: { $in: memberships.map((m) => m.userId) } }).select("email").lean();
  const emailOf = new Map(users.map((u) => [String(u._id), u.email]));
  const rows = [];
  for (const m of memberships) {
    // tenant-scoped: a count inside one holding tenant
    rows.push({ email: emailOf.get(String(m.userId)) ?? null, proposals: await Proposal.countDocuments({ organizationId: m.organizationId }) });
  }
  print({ unplaced: rows.length, customers: rows });
};

const actorFor = async (adminEmail: string | undefined) => {
  if (!adminEmail) throw new Error("--admin-email is required: the DXG admin the audit trail records");
  const admin = await Admin.findOne({ email: adminEmail.toLowerCase(), isBlocked: { $ne: true } }).select("_id organizationId").lean();
  if (!admin?.organizationId) throw new Error(`No active DXG admin with email ${adminEmail}`);
  return { adminUserId: String(admin._id), adminOrganizationId: String(admin.organizationId), correlationId: randomUUID() };
};

const targetFrom = async (): Promise<PlacementTarget> => {
  const newOrg = arg("--new-org");
  const slug = arg("--org-slug");
  if (Boolean(newOrg) === Boolean(slug)) throw new Error("Give exactly one of --new-org or --org-slug");
  if (newOrg) {
    return {
      kind: "new",
      organization: {
        name: newOrg, type: (arg("--type") as never) ?? null, country: arg("--country") ?? null, timeZone: arg("--time-zone") ?? null,
      },
    };
  }
  const organization = await Organization.findOne({ slug, kind: "customer", status: "active" }).select("_id").lean();
  if (!organization) throw new Error(`No active customer organization with slug ${slug}`);
  const role = arg("--role");
  if (!role || !(PLACEMENT_ROLES as readonly string[]).includes(role)) throw new Error(`--role must be one of ${PLACEMENT_ROLES.join(", ")}`);
  return { kind: "existing", organizationId: String(organization._id), role, teamId: arg("--team-id") ?? null };
};

const main = async () => {
  if (args.has("--help") || args.size === 0) return help();
  if (!mongoUri) throw new Error("MONGODB_URL or MONGO_URL is required");
  await mongoose.connect(mongoUri, { dbName: DATABASE_NAME });
  if (args.has("--list")) return listUnplaced();

  const foundation = process.env.POSTGRES_FOUNDATION_ENABLED === "true";
  const connectionString = process.env.POSTGRES_MIGRATION_URL?.trim();
  if (foundation && !connectionString) throw new Error("POSTGRES_MIGRATION_URL is required: run this as the one-off migration task");
  const pool = foundation
    ? new Pool({ connectionString, max: 2, ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: true } : undefined })
    : null;
  try {
    const actor = await actorFor(arg("--admin-email"));
    const runId = arg("--rollback");
    if (runId) {
      if (!apply) return print({ mode: "dry-run", wouldRollBack: runId });
      return print({ mode: "applied", rollback: await rollbackPlacement({ runId, actor, pool }) });
    }

    const email = arg("--email")?.toLowerCase();
    if (!email) throw new Error("--email is required");
    const user = await User.findOne({ email }).select("_id email").lean();
    if (!user) throw new Error(`No account with email ${email}`);
    const target = await targetFrom();
    if (!apply) {
      const membership = await OrganizationMembership.findOne({ userId: user._id, status: "active" }).select("organizationId").lean();
      const holding = membership && await Organization.findOne({ _id: membership.organizationId, kind: "legacy_holding", status: "active" }).select("_id").lean();
      return print({
        mode: "dry-run",
        email,
        waitingForPlacement: Boolean(holding),
        // tenant-scoped: the holding tenant's proposals
        proposalsToMove: holding ? await Proposal.countDocuments({ organizationId: holding._id }) : 0,
        target,
        note: holding ? "Re-run with --apply to place." : "This account isn't waiting in a holding tenant; --apply would be refused.",
      });
    }
    const placement = await placeLegacyCustomer({ userId: String(user._id), target, actor, pool });
    print({ mode: "applied", placement });
  } finally {
    await pool?.end();
  }
};

main()
  .catch((error) => {
    if (error instanceof PlacementError) {
      process.stderr.write(`${error.code}: ${error.message}${error.details ? ` ${JSON.stringify(error.details)}` : ""}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
