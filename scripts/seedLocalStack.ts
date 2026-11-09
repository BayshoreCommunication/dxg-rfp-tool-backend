// Seeds the local Docker stack (deploy/local) with test data: two customer organizations, one
// account per role, a team, a few RFPs, and a back-office admin. Every name, email and RFP here
// is invented; nothing comes from a real customer.
//
//   npm run stack:seed            # also run by stack:up; skips if already seeded
//
// It refuses to run unless RFPILOT_ENV_FILE points at deploy/local/stack.env and every
// connection string targets the loopback stack ports, so it can never write to a shared database.
import "../config/env";
import mongoose from "mongoose";
import { Pool } from "pg";
import Admin from "../modal/adminModel";
import Organization from "../modal/organizationModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import Proposal from "../modal/proposalsModel";
import Team from "../modal/teamModel";
import TeamMembership from "../modal/teamMembershipModel";
import User from "../modal/userModel";

export const LOCAL_PASSWORD = "Rfpilot-local-1";

const STACK_ENV_FILE = "deploy/local/stack.env";
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1)$/;

const assertLocalStack = (): { mongoUrl: string; migrationUrl: string } => {
  const fail = (reason: string): never => {
    throw new Error(`seedLocalStack refused: ${reason}. Run it through \`npm run stack:seed\`.`);
  };
  if (process.env.RFPILOT_ENV_FILE?.trim() !== STACK_ENV_FILE) fail(`RFPILOT_ENV_FILE is not ${STACK_ENV_FILE}`);
  const mongoUrl = process.env.MONGODB_URL ?? fail("MONGODB_URL is not set");
  const migrationUrl = process.env.POSTGRES_MIGRATION_URL ?? fail("POSTGRES_MIGRATION_URL is not set");
  const mongo = new URL(mongoUrl);
  if (!LOCAL_HOSTS.test(mongo.hostname) || mongo.port !== "47017") fail(`MONGODB_URL is not the local stack (${mongo.host})`);
  for (const [name, value] of [["POSTGRES_URL", process.env.POSTGRES_URL], ["POSTGRES_MIGRATION_URL", migrationUrl]] as const) {
    const url = new URL(value ?? fail(`${name} is not set`));
    if (!LOCAL_HOSTS.test(url.hostname) || url.port !== "45432") fail(`${name} is not the local stack (${url.host})`);
  }
  return { mongoUrl, migrationUrl };
};

// The API connects as rfpilot_app, which (unlike the superuser) is bound by forced RLS. Grants
// are re-applied on every run because migrations add tables.
const grantAppRole = async (migrationUrl: string) => {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'rfpilot_app') THEN
        CREATE ROLE rfpilot_app LOGIN PASSWORD 'rfpilot_local';
      END IF; END $$;`);
    await pool.query("GRANT USAGE ON SCHEMA rfpilot TO rfpilot_app");
    await pool.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA rfpilot TO rfpilot_app");
    await pool.query("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA rfpilot TO rfpilot_app");
    await pool.query("GRANT SELECT ON public.rfpilot_schema_migrations TO rfpilot_app");
  } finally {
    await pool.end();
  }
};

type Role = "owner" | "organization_admin" | "team_manager" | "planner" | "viewer";
type SeedUser = { key: string; name: string; email: string; role: Role };
type SeedOrganization = { name: string; slug: string; users: SeedUser[] };

const ORGANIZATIONS: SeedOrganization[] = [
  {
    name: "Northwind Events",
    slug: "northwind-events",
    users: [
      { key: "nw-owner", name: "Olivia Owner", email: "owner.northwind@example.com", role: "owner" },
      { key: "nw-admin", name: "Adam Admin", email: "admin.northwind@example.com", role: "organization_admin" },
      { key: "nw-manager", name: "Maya Manager", email: "manager.northwind@example.com", role: "team_manager" },
      { key: "nw-planner", name: "Pat Planner", email: "planner.northwind@example.com", role: "planner" },
      { key: "nw-viewer", name: "Val Viewer", email: "viewer.northwind@example.com", role: "viewer" },
    ],
  },
  {
    // A second tenant, so cross-organization leaks are visible: nothing here should ever
    // appear for a Northwind account.
    name: "Contoso Live",
    slug: "contoso-live",
    users: [
      { key: "ct-owner", name: "Casey Contoso", email: "owner.contoso@example.com", role: "owner" },
      { key: "ct-planner", name: "Chris Contoso", email: "planner.contoso@example.com", role: "planner" },
    ],
  },
];

const proposal = (fields: {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  teamId?: mongoose.Types.ObjectId;
  eventName: string;
  startDate: string;
  attendees: string;
  eventFormat: "In-Person" | "Hybrid" | "Virtual";
  published?: boolean;
}) => ({
  organizationId: fields.organizationId,
  userId: fields.userId,
  teamId: fields.teamId ?? null,
  status: fields.published ? "submitted" : "unsubmitted",
  isDraft: !fields.published,
  event: {
    eventName: fields.eventName,
    startDate: fields.startDate,
    endDate: fields.startDate,
    attendees: fields.attendees,
    eventFormat: fields.eventFormat,
  },
  contact: {
    contactFirstName: "Test",
    contactLastName: "Contact",
    contactEmail: "contact@example.com",
    contactPhone: "+1 555 0100",
  },
});

const main = async () => {
  const { mongoUrl, migrationUrl } = assertLocalStack();
  await grantAppRole(migrationUrl);
  await mongoose.connect(mongoUrl, { dbName: process.env.MONGODB_DB_NAME, serverSelectionTimeoutMS: 5_000 });

  if (await Organization.exists({ slug: ORGANIZATIONS[0].slug })) {
    process.stdout.write("Local stack already seeded (run `npm run stack:reset` to start over).\n");
    return;
  }

  const ids = new Map<string, mongoose.Types.ObjectId>();
  for (const seed of ORGANIZATIONS) {
    const organization = await Organization.create({ name: seed.name, slug: seed.slug, kind: "customer", onboardingStep: "done" });
    ids.set(seed.slug, organization._id as mongoose.Types.ObjectId);
    for (const person of seed.users) {
      // save() hashes the password (userModel pre-save hook).
      const user = await User.create({
        name: person.name,
        email: person.email,
        password: LOCAL_PASSWORD,
        role: "customer",
        organizationId: organization._id,
        isBlocked: false,
      });
      ids.set(person.key, user._id as mongoose.Types.ObjectId);
      await OrganizationMembership.create({ organizationId: organization._id, userId: user._id, roles: [person.role], status: "active" });
    }
  }

  const northwind = ids.get("northwind-events")!;
  const team = await Team.create({ organizationId: northwind, name: "Corporate Events" });
  await TeamMembership.create([
    { organizationId: northwind, teamId: team._id, userId: ids.get("nw-manager"), isManager: true },
    { organizationId: northwind, teamId: team._id, userId: ids.get("nw-planner"), isManager: false },
  ]);

  await Proposal.create([
    proposal({ organizationId: northwind, userId: ids.get("nw-planner")!, teamId: team._id as mongoose.Types.ObjectId, eventName: "Spring Sales Kickoff", startDate: "2027-03-15", attendees: "450", eventFormat: "In-Person" }),
    proposal({ organizationId: northwind, userId: ids.get("nw-planner")!, eventName: "Partner Webinar Series", startDate: "2027-02-02", attendees: "1200", eventFormat: "Virtual" }),
    proposal({ organizationId: northwind, userId: ids.get("nw-owner")!, teamId: team._id as mongoose.Types.ObjectId, eventName: "Annual Leadership Summit", startDate: "2027-05-20", attendees: "300", eventFormat: "Hybrid", published: true }),
    proposal({ organizationId: ids.get("contoso-live")!, userId: ids.get("ct-planner")!, eventName: "Contoso Product Launch", startDate: "2027-04-08", attendees: "800", eventFormat: "In-Person" }),
  ]);

  // Back-office (admin app) accounts live in their own collection and organization.
  const platform = await Organization.create({ name: "RFPilot Back Office (local)", slug: "rfpilot-back-office", kind: "customer", onboardingStep: "done" });
  await Admin.create({ organizationId: platform._id, name: "Sam Superadmin", email: "superadmin@example.com", password: LOCAL_PASSWORD, role: "super_admin" });

  process.stdout.write(`Seeded the local stack. Password for every account: ${LOCAL_PASSWORD}

  Dashboard (http://localhost:3100)
    Northwind Events  owner.northwind@example.com     Owner
                      admin.northwind@example.com     Admin
                      manager.northwind@example.com   Team Manager (Corporate Events)
                      planner.northwind@example.com   Planner (Corporate Events)
                      viewer.northwind@example.com    Viewer
    Contoso Live      owner.contoso@example.com       Owner
                      planner.contoso@example.com     Planner
  Admin app (http://localhost:3101)
                      superadmin@example.com          super_admin
  Email inbox: http://127.0.0.1:48025
`);
};

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
