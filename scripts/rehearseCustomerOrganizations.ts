// Rehearses the tenancy migration (ORG-107) and its verifier (ORG-109) end to end and times
// every step (ORG-501): snapshot → dry run → apply → verify → rollback dry run → rollback →
// verify → apply again → verify → apply once more (idempotence). Each step is the same npm
// command the cutover runbook uses, run as a child process, so the timings include what an
// operator would wait for. Between steps it fingerprints the shared organization, to prove that
// rollback puts back exactly what was there, and checks the holding tenants.
//
//   npm run rehearsal:run -- --run-id=<id> [--out=<dir>] [--from-slug=dxg]
//
// It mutates whatever database the environment points at. It prints the targets (never
// credentials) first, and refuses anything but the local rehearsal stack unless the operator
// repeats both targets: --confirm-target=<mongo-host>/<database>,<postgres-host>/<database>. docs/runbooks/ORG_TENANCY_REHEARSAL.md
// has the full procedure, including the restored production snapshot.
import "../config/env";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { Pool } from "pg";
import { DATABASE_NAME } from "../config/db";
import Organization from "../modal/organizationModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import Proposal from "../modal/proposalsModel";
import { entitlementsOf } from "../src/modules/entitlements/domain/plans";
import { claimProposalSlot } from "../src/modules/entitlements/infrastructure/mongoOrganizationEntitlements";
import { MOVABLE_COLLECTIONS } from "../src/modules/tenancy/mongoTenantMove";
import { loadTenantSchema } from "../src/modules/tenancy/postgresTenantMove";

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split("=");
  return [key, rest.length ? rest.join("=") : "true"];
}));
const runId = args.get("--run-id") || `rehearsal-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const fromSlug = args.get("--from-slug") || process.env.DEFAULT_ORGANIZATION_SLUG || "dxg";
const outDir = path.resolve(args.get("--out") || path.join(os.tmpdir(), `org-501-${runId}`));
const mongoUri = process.env.MONGODB_URL || process.env.MONGO_URL;
const postgresUri = process.env.POSTGRES_MIGRATION_URL || process.env.POSTGRES_URL;
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1)$/;

const help = () => process.stdout.write(`Usage:
  npm run rehearsal:run -- --run-id=<id> [--out=<dir>] [--from-slug=dxg] [--confirm-target=<mongo-host>/<database>,<postgres-host>/<database>]

Runs the whole migration round trip against the databases in the environment and writes each
step's output and a timing summary to --out (mode 0700; the files hold ids, no content).
Never point it at production: it applies and rolls back the migration.
`);

type Fingerprint = Record<string, { count: number; ids: string }>;
type State = {
  mongo: Fingerprint; memberships: { count: number; rolesAndStatus: string };
  postgres: Fingerprint | "skipped"; organizations: Record<string, number>;
};
type Step = { step: string; command: string; exitCode: number; expectedExit: number; seconds: number; note?: string };

const sha = (values: string[]) => crypto.createHash("sha256").update(values.sort().join("\n")).digest("hex").slice(0, 16);

const targets = () => {
  if (!mongoUri) throw new Error("MONGODB_URL or MONGO_URL is required");
  // An SRV or multi-host URI is not a plain URL; the first host is enough to name the target.
  const mongoHost = mongoUri.replace(/^mongodb(\+srv)?:\/\//, "").replace(/^[^@/]*@/, "").split(/[/?]/)[0];
  const postgres = postgresUri ? new URL(postgresUri) : null;
  const postgresTarget = postgres ? `${postgres.host}${postgres.pathname}` : "none";
  // Only the rehearsal stack itself runs unconfirmed: its env file and its two loopback ports.
  const rehearsalStack = process.env.RFPILOT_ENV_FILE?.trim() === "deploy/rehearsal/rehearsal.env"
    && /^(localhost|127\.0\.0\.1):37017$/.test(mongoHost)
    && postgres !== null && LOCAL_HOSTS.test(postgres.hostname) && postgres.port === "35432";
  return {
    mongo: `${mongoHost}/${DATABASE_NAME}`,
    postgres: postgres ? `${postgresTarget} as ${postgres.username}` : "not configured (Postgres steps are skipped)",
    confirmation: `${mongoHost}/${DATABASE_NAME},${postgresTarget}`,
    rehearsalStack,
  };
};

// What one organization holds, as counts plus a hash of the ids, per collection and table.
const stateOf = async (organizationMongoId: string, pool: Pool | null): Promise<State> => {
  const organizationId = new mongoose.Types.ObjectId(organizationMongoId);
  const db = mongoose.connection.db!;
  const mongo: Fingerprint = {};
  for (const name of MOVABLE_COLLECTIONS) {
    const ids = (await db.collection(name).find({ organizationId }, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id));
    if (ids.length) mongo[name] = { count: ids.length, ids: sha(ids) };
  }
  // Roles and status must come back exactly; the version is meant to move forward.
  const members = await OrganizationMembership.collection.find({ organizationId }, { projection: { userId: 1, roles: 1, status: 1 } }).toArray();
  const memberships = { count: members.length, rolesAndStatus: sha(members.map((m) => `${m.userId}:${(m.roles as string[]).join(",")}:${m.status}`)) };
  const kinds = await Organization.collection.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$kind", n: { $sum: 1 } } }]).toArray();
  const organizations = Object.fromEntries(kinds.map((k) => [String(k._id), k.n]));

  let postgres: Fingerprint | "skipped" = "skipped";
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      // Forced row-level security binds the table owner too: read as this organization.
      await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [organizationMongoId]);
      const pg = (await client.query<{ id: string }>("SELECT id FROM rfpilot.organizations WHERE external_mongo_id = $1", [organizationMongoId])).rows[0]?.id;
      if (pg) {
        postgres = {};
        await client.query("SELECT set_config('app.organization_id',$1,true)", [pg]);
        const schema = await loadTenantSchema(client);
        for (const name of schema.tables) {
          const key = (schema.primaryKeys[name] ?? []).map((column) => `"${column}"::text`).join(" || ':' || ");
          const row = (await client.query<{ n: string; ids: string | null }>(
            `SELECT count(*) AS n, ${key ? `md5(string_agg(${key}, ',' ORDER BY ${key}))` : "NULL"} AS ids FROM rfpilot."${name}" WHERE organization_id = $1`, [pg],
          )).rows[0];
          if (Number(row.n)) postgres[name] = { count: Number(row.n), ids: (row.ids ?? "").slice(0, 16) };
        }
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
  return { mongo, memberships, postgres, organizations };
};

const differences = (before: State, after: State): string[] => {
  const out: string[] = [];
  const compare = (label: string, a: Fingerprint | "skipped", b: Fingerprint | "skipped") => {
    if (a === "skipped" || b === "skipped") return;
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[name]?.count !== b[name]?.count) out.push(`${label}.${name}: ${a[name]?.count ?? 0} rows before, ${b[name]?.count ?? 0} after`);
      else if (a[name]?.ids !== b[name]?.ids) out.push(`${label}.${name}: same count, different rows`);
    }
  };
  compare("mongo", before.mongo, after.mongo);
  compare("postgres", before.postgres, after.postgres);
  if (before.memberships.count !== after.memberships.count) out.push(`memberships: ${before.memberships.count} before, ${after.memberships.count} after`);
  else if (before.memberships.rolesAndStatus !== after.memberships.rolesAndStatus) out.push("memberships: roles or status differ");
  return out;
};

// ORG-107: each holding tenant has exactly one member, a Planner, and no Owner. ORG-601: it is
// exempt from plan limits, both in the plan table and in the query that takes an RFP slot.
const holdingTenantChecks = async () => {
  const holdings = await Organization.find({ kind: "legacy_holding" }).select("_id kind plan proposalsCreated status").lean();
  const ids = holdings.map((h) => h._id);
  const members = await OrganizationMembership.collection.aggregate<{ _id: unknown; n: number; roles: string[][]; statuses: string[] }>([
    { $match: { organizationId: { $in: ids } } },
    { $group: { _id: "$organizationId", n: { $sum: 1 }, roles: { $push: "$roles" }, statuses: { $push: "$status" } } },
  ]).toArray();
  const onePlanner = members.filter((m) => m.n === 1 && m.roles[0].length === 1 && m.roles[0][0] === "planner" && m.statuses[0] === "active").length;
  const notExempt = holdings.filter((h) => {
    const e = entitlementsOf(h);
    return !(e.exempt && e.proposals.limit === null && e.proposals.canCreate && Object.values(e.features).every(Boolean));
  }).length;
  // The busiest holding tenant, far past the free-trial limit, can still take an RFP slot. The
  // transaction is aborted, so the counter is not changed.
  const busiest = (await Proposal.collection.aggregate<{ _id: unknown; n: number }>([
    { $match: { organizationId: { $in: ids } } }, { $group: { _id: "$organizationId", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 1 },
  ]).toArray())[0];
  let slot = "no holding tenant has an RFP";
  if (busiest) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      await claimProposalSlot(String(busiest._id), session);
      slot = `taken by a holding tenant with ${busiest.n} RFPs (aborted)`;
    } catch (error) {
      slot = `REFUSED for a holding tenant with ${busiest.n} RFPs: ${error instanceof Error ? error.message : "error"}`;
    } finally {
      await session.abortTransaction().catch(() => undefined);
      await session.endSession();
    }
  }
  return {
    holdingTenants: holdings.length,
    withExactlyOneActivePlanner: onePlanner,
    withAnOwner: members.filter((m) => m.roles.flat().includes("owner")).length,
    inactive: holdings.filter((h) => h.status !== "active").length,
    notExemptFromPlanLimits: notExempt,
    rfpSlot: slot,
  };
};

const main = async () => {
  if (args.has("--help")) return help();
  const target = targets();
  process.stdout.write(`Rehearsal targets\n  MongoDB:    ${target.mongo}\n  PostgreSQL: ${target.postgres}\n  run id:     ${runId}\n  output:     ${outDir}\n`);
  if (!target.rehearsalStack && args.get("--confirm-target") !== target.confirmation) {
    throw new Error(`These are not the rehearsal stack's databases. If both are an isolated restore and never production, repeat both targets: --confirm-target=${target.confirmation}`);
  }
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const snapshotFile = path.join(outDir, "visibility-before.json");
  const steps: Step[] = [];
  const outputs: Record<string, unknown> = {};

  const run = (step: string, script: string, scriptArgs: string[], expectedExit = 0, note?: string) => {
    const command = `npm run ${script} -- ${scriptArgs.join(" ")}`.trim();
    process.stdout.write(`\n[${step}] ${command}\n  targets: ${target.mongo} | ${target.postgres}\n`);
    const started = process.hrtime.bigint();
    const child = spawnSync("npm", ["run", "-s", script, "--", ...scriptArgs], { encoding: "utf8", maxBuffer: 1 << 30, env: process.env });
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    fs.writeFileSync(path.join(outDir, `${step}.out`), `${child.stdout}${child.stderr ? `\n--- stderr ---\n${child.stderr}` : ""}`, { mode: 0o600 });
    const exitCode = child.status ?? -1;
    steps.push({ step, command, exitCode, expectedExit, seconds: Math.round(seconds * 10) / 10, note });
    // The scripts print connection lines around their JSON report.
    try { outputs[step] = JSON.parse(child.stdout.slice(child.stdout.search(/^\{/m), child.stdout.lastIndexOf("\n}") + 2)); } catch { outputs[step] = null; }
    process.stdout.write(`  exit ${exitCode} in ${seconds.toFixed(1)} s\n`);
    if (exitCode !== expectedExit) {
      throw new Error(`Step '${step}' exited ${exitCode} (expected ${expectedExit}). Its output is in ${path.join(outDir, `${step}.out`)}. Nothing after it was run.`);
    }
    return outputs[step] as Record<string, unknown> | null;
  };

  const pool = postgresUri
    ? new Pool({ connectionString: postgresUri, max: 1, ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: true } : undefined })
    : null;
  await mongoose.connect(mongoUri!, { dbName: DATABASE_NAME });
  const summary: Record<string, unknown> = { runId, targets: { mongo: target.mongo, postgres: target.postgres }, startedAt: new Date().toISOString() };
  const save = () => fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ ...summary, steps }, null, 2), { mode: 0o600 });
  try {
    const shared = await Organization.findOne({ slug: fromSlug }).select("_id").lean();
    if (!shared) throw new Error(`Organization '${fromSlug}' was not found`);
    const sharedId = String(shared._id);
    const bystander = await Organization.findOne({ kind: "customer", _id: { $ne: shared._id } }).select("_id").lean();
    const before = await stateOf(sharedId, pool);
    const bystanderBefore = bystander ? await stateOf(String(bystander._id), pool) : null;
    summary.before = before;

    // What starting the process costs (npm, ts-node, connecting): part of every step below.
    run("00-startup", "migrate:customer-organizations", ["--help"], 0, "process start-up only");
    run("01-snapshot", "verify:customer-organizations", [`--snapshot=${snapshotFile}`]);
    run("02-dry-run", "migrate:customer-organizations", [`--run-id=${runId}`, `--from-slug=${fromSlug}`]);
    summary.unchangedByDryRun = differences(before, await stateOf(sharedId, pool));
    run("03-apply", "migrate:customer-organizations", ["--apply", `--run-id=${runId}`, `--from-slug=${fromSlug}`]);
    run("04-verify-after-apply", "verify:customer-organizations", [`--before=${snapshotFile}`, `--from-slug=${fromSlug}`]);
    summary.afterApply = await stateOf(sharedId, pool);
    summary.holdingTenantsAfterApply = await holdingTenantChecks();

    run("05-rollback-dry-run", "migrate:customer-organizations", [`--rollback-run=${runId}`]);
    run("06-rollback", "migrate:customer-organizations", [`--rollback-run=${runId}`, "--apply"]);
    // After a rollback the customers are back in the shared organization, so the verifier's
    // "nothing customer-owned is left there" check fails by design and it exits 1.
    const afterRollback = run("07-verify-after-rollback", "verify:customer-organizations", [`--before=${snapshotFile}`, `--from-slug=${fromSlug}`], 1,
      "exit 1 is expected: customers are back in the shared organization");
    const checks = (afterRollback?.checks ?? null) as { visibilityUnchanged?: unknown; noCustomerRecordsInSharedOrganization?: unknown } | null;
    summary.verifierChecksAfterRollback = checks;
    // Exit 1 alone could be a crash: require the report, and the two answers a rollback must give.
    if (checks?.visibilityUnchanged !== true || checks.noCustomerRecordsInSharedOrganization !== false) {
      throw new Error(`Step '07-verify-after-rollback' did not report what a rollback should (visibility unchanged, customers back in the shared organization). See ${path.join(outDir, "07-verify-after-rollback.out")}. Nothing after it was run.`);
    }
    summary.restoredByRollback = differences(before, await stateOf(sharedId, pool));
    summary.afterRollback = await stateOf(sharedId, pool);

    run("08-apply-again", "migrate:customer-organizations", ["--apply", `--run-id=${runId}`, `--from-slug=${fromSlug}`]);
    run("09-verify-after-apply-again", "verify:customer-organizations", [`--before=${snapshotFile}`, `--from-slug=${fromSlug}`]);
    summary.sameAsFirstApply = differences(summary.afterApply as State, await stateOf(sharedId, pool));
    const rerun = run("10-apply-once-more", "migrate:customer-organizations", ["--apply", `--run-id=${runId}`, `--from-slug=${fromSlug}`]);
    summary.customersConsideredOnRerun = rerun?.customers ?? null;
    run("11-verify-final", "verify:customer-organizations", [`--before=${snapshotFile}`, `--from-slug=${fromSlug}`]);
    summary.holdingTenantsFinal = await holdingTenantChecks();
    summary.bystanderUntouched = bystander && bystanderBefore ? differences(bystanderBefore, await stateOf(String(bystander._id), pool)) : "no other customer organization";
    summary.finishedAt = new Date().toISOString();
  } finally {
    save();
    // The snapshot lists which ids each member can see; it is not kept.
    fs.rmSync(snapshotFile, { force: true });
    await pool?.end();
    await mongoose.disconnect();
    process.stdout.write(`\n| Step | Wall clock (s) | Exit |\n|---|---|---|\n${steps.map((s) =>
      `| ${s.step} | ${s.seconds.toFixed(1)} | ${s.exitCode}${s.exitCode === s.expectedExit ? "" : " (UNEXPECTED)"} |`).join("\n")}\n`);
    process.stdout.write(`\nSummary: ${path.join(outDir, "summary.json")}\n`);
  }
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Rehearsal failed"}\n`);
  process.exitCode = 1;
});
