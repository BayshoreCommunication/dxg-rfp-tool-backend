// ORG-110 on production (owner's decision, 2026-11-17): the API has no Postgres migration role, so
// it journals a placement or rollback as a queued run and starts a one-off task on the migrate
// task definition; the task does the move and writes the outcome. Here the API runs exactly as
// in production (no POSTGRES_MIGRATION_URL, placement task settings present) on real MongoDB and
// Postgres, with ECS faked: the "task" is the same function scripts/placeLegacyCustomer.js
// --task-run calls, run in this process with the migration role the real task has.
//
// Proven here: the journal's unique indexes enforce one run per user, the global cap and the
// idempotency key; the run record's states; a task that never starts or stops reporting is given
// up on and cannot commit afterwards; the same audit events, naming the staff member who asked.
import { TEST_MONGODB_DB_NAME, TEST_POSTGRES_URL } from "./env";
import { connectMongo, disconnectMongo, ensureMigrated, ensureServices, randomMongoId } from "./setup";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import http from "node:http";
import mongoose from "mongoose";
import { Pool } from "pg";
import app from "../server";
import Admin from "../modal/adminModel";
import Organization from "../modal/organizationModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import Proposal from "../modal/proposalsModel";
import SecurityAuditEvent from "../modal/securityAuditEventModel";
import Team from "../modal/teamModel";
import TeamMembership from "../modal/teamMembershipModel";
import User from "../modal/userModel";
import { beginAuthenticatedSession } from "../src/modules/auth/composition";
import { closePostgres, postgresPool } from "../config/postgres";
import { closeSecurityRateLimitRedis } from "../middleware/securityRateLimit";
import { closePlacementPool, setPlacementTaskLauncherForTests } from "../controller/adminLegacyCustomersController";
import { findCustomerLeftovers } from "../src/modules/tenancy/migrationVerification";
import { placementTaskCommand } from "../src/modules/tenancy/placementTaskLauncher";
import { runPlacementTask, type PlacementTaskOutcome } from "../src/modules/tenancy/placementTaskRunner";
import { recordTaskHeartbeat } from "../src/modules/tenancy/placementTaskStore";
import { cleanupOrganizations, seedOrganization, type Fixture } from "./memberFixtures";

const tag = randomMongoId().slice(0, 10);
const oid = () => new mongoose.Types.ObjectId();
const JOURNAL = "legacycustomerplacements";
let server: http.Server;
let baseUrl: string;
let adminToken: string;
let secondAdminToken: string;
let customerToken: string;
let receiving: Fixture;
// The migration role, which only the task holds.
let taskPool: Pool;
const dxg = { org: oid(), admin: oid(), secondAdmin: oid() };
type Legacy = { userId: mongoose.Types.ObjectId; holding: mongoose.Types.ObjectId; proposals: mongoose.Types.ObjectId[]; pgOrg?: string };
const names = ["ana", "ben", "cy", "dee", "eve", "fay", "gus", "hal"] as const;
const legacy = Object.fromEntries(names.map((name) => [name, { userId: oid(), holding: oid(), proposals: [oid()] }])) as Record<(typeof names)[number], Legacy>;

const launches: Array<{ runId: string; launchToken: string }> = [];
let failLaunch = false;

const api = async (token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${baseUrl}/api/admin/legacy-customers${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> };
};
const run = async (runId: string) => (await api(adminToken, "GET", `/placements/${encodeURIComponent(runId)}`)).body.data.placement;
// What ECS would do with the launch: run the script's task mode. A lost lease is a test failure.
const runTask = (runId: string) => runPlacementTask({ runId, pool: taskPool, onLeaseLost: (reason) => { throw new Error(`lease lost: ${reason}`); } });
const journal = () => mongoose.connection.collection(JOURNAL);
const pgReferences = async (pgOrgId: string | null | undefined) =>
  pgOrgId ? Number((await postgresPool().query("SELECT count(*) FROM rfpilot.proposal_references WHERE organization_id=$1", [pgOrgId])).rows[0].count) : 0;
const pgOrganization = async (mongoId: string) =>
  (await postgresPool().query<{ id: string }>("SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1", [mongoId])).rows[0]?.id ?? null;
const ownedIn = (organizationId: mongoose.Types.ObjectId | string, userId: mongoose.Types.ObjectId) =>
  Proposal.collection.countDocuments({ organizationId: new mongoose.Types.ObjectId(String(organizationId)), userId });
const untouched = async (who: Legacy, target: string) => {
  assert.equal(await ownedIn(who.holding, who.userId), who.proposals.length, "MongoDB proposals are still in the holding tenant");
  assert.equal(await pgReferences(who.pgOrg), who.proposals.length, "Postgres rows are still in the holding tenant");
  assert.equal((await Organization.findById(who.holding).lean())?.status, "active");
  assert.equal(await OrganizationMembership.exists({ organizationId: target, userId: who.userId }), null);
};
const existing = (role = "planner") => ({ target: "existing", organizationId: receiving.organizationId, role });

const seedLegacy = async (name: string, who: Legacy) => {
  await Organization.collection.insertOne({ _id: who.holding, name: `${name} Holding`, slug: `legacy-${who.userId}`, status: "active", kind: "legacy_holding", plan: "free_trial" });
  await User.collection.insertOne({ _id: who.userId, organizationId: who.holding, name, email: `${name}-task-${tag}@example.com`, password: "not-a-real-hash", role: "customer", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: who.holding, userId: who.userId, roles: ["planner"], status: "active", version: 2 });
  for (const [i, id] of who.proposals.entries()) await Proposal.collection.insertOne({ _id: id, organizationId: who.holding, userId: who.userId, status: "unsubmitted", isDraft: true, event: { eventName: `${name} ${i}` } });
  const pool = postgresPool();
  who.pgOrg = (await pool.query<{ id: string }>("INSERT INTO rfpilot.organizations(external_mongo_id,name) VALUES($1,$2) RETURNING id", [String(who.holding), `${name} Holding`])).rows[0].id;
  const pgUser = (await pool.query<{ id: string }>("INSERT INTO rfpilot.users(organization_id,external_mongo_id) VALUES($1,$2) RETURNING id", [who.pgOrg, String(who.userId)])).rows[0].id;
  for (const id of who.proposals) {
    await pool.query("INSERT INTO rfpilot.proposal_references(organization_id,owner_user_id,external_mongo_id) VALUES($1,$2,$3)", [who.pgOrg, pgUser, String(id)]);
  }
};

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  // Production's shape: the API process has no migration role and is told which task to start.
  taskPool = new Pool({ connectionString: TEST_POSTGRES_URL, max: 2 });
  delete process.env.POSTGRES_MIGRATION_URL;
  setPlacementTaskLauncherForTests({
    async launch(input) {
      if (failLaunch) throw new Error("AccessDeniedException");
      // The real launcher's own check: only a well-formed run id ever becomes a command.
      placementTaskCommand(input.runId);
      launches.push(input);
      return { taskArn: `arn:aws:ecs:us-east-2:111111111111:task/rfpilot-test/${launches.length}` };
    },
  });
  await Organization.collection.insertOne({ _id: dxg.org, name: "DXG", slug: `intg-dxg-task-${tag}`, status: "active", kind: "customer", plan: "free_trial" });
  for (const [id, label] of [[dxg.admin, "staff"], [dxg.secondAdmin, "staff2"]] as const) {
    await Admin.collection.insertOne({ _id: id, organizationId: dxg.org, name: label, email: `${label}-task-${tag}@example.com`, password: "not-a-real-hash", role: "admin", isBlocked: false });
    await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: id, roles: ["dxg_admin"], status: "active", version: 1 });
  }
  adminToken = (await beginAuthenticatedSession({ userId: String(dxg.admin), organizationId: String(dxg.org), correlationId: randomMongoId() })).accessToken;
  secondAdminToken = (await beginAuthenticatedSession({ userId: String(dxg.secondAdmin), organizationId: String(dxg.org), correlationId: randomMongoId() })).accessToken;
  for (const name of names) await seedLegacy(name, legacy[name]);
  receiving = await seedOrganization("Task Receiving Org");
  customerToken = receiving.members.organization_admin.accessToken;
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  setPlacementTaskLauncherForTests(undefined);
  if (mongoose.connection.readyState === 1) {
    const userIds = Object.values(legacy).map((l) => l.userId);
    const placed = await Organization.find({ name: new RegExp(`^Task Events ${tag}`) }).select("_id").lean();
    const orgIds = [dxg.org, ...Object.values(legacy).map((l) => l.holding), ...placed.map((o) => o._id)];
    await journal().deleteMany({ userId: { $in: userIds.map(String) } });
    await OrganizationMembership.collection.deleteMany({ organizationId: { $in: orgIds } });
    await Proposal.collection.deleteMany({ organizationId: { $in: orgIds } });
    await TeamMembership.collection.deleteMany({ userId: { $in: userIds } });
    await Team.collection.deleteMany({ organizationId: new mongoose.Types.ObjectId(receiving.organizationId) });
    await User.collection.deleteMany({ _id: { $in: userIds } });
    await Admin.collection.deleteMany({ _id: { $in: [dxg.admin, dxg.secondAdmin] } });
    await Organization.collection.deleteMany({ _id: { $in: orgIds } });
    await cleanupOrganizations();
  }
  await taskPool?.end();
  await closePlacementPool();
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
});

test("customers can't request, read or roll back a placement", async () => {
  const before = launches.length;
  assert.equal((await api(customerToken, "POST", `/${legacy.ana.userId}/placements`, existing())).status, 403);
  assert.equal((await api(customerToken, "POST", "/placements/placement-2026-11-17T09:00:00.000Z-00000000/rollback")).status, 403);
  assert.equal((await api(customerToken, "GET", "/placements/placement-2026-11-17T09:00:00.000Z-00000000")).status, 403);
  assert.equal(launches.length, before);
  assert.equal(await journal().countDocuments({ userId: String(legacy.ana.userId) }), 0);
});

test("the synchronous path's refusals, with the same codes, and no task started", async () => {
  const before = launches.length;
  const cases: Array<[string, unknown, number, string]> = [
    [String(legacy.ana.userId), { target: "nowhere" }, 400, "TARGET_REQUIRED"],
    [String(legacy.ana.userId), { target: "new", organization: {} }, 400, "ORGANIZATION_NAME_REQUIRED"],
    [String(legacy.ana.userId), { target: "new", organization: { name: "X", type: "not-a-type" } }, 400, "INVALID_ORGANIZATION_TYPE"],
    [String(legacy.ana.userId), existing("owner"), 400, "INVALID_ROLE"],
    [String(legacy.ana.userId), existing("viewer"), 400, "INVALID_ROLE"],
    [String(legacy.ana.userId), { ...existing(), teamId: randomMongoId() }, 400, "UNKNOWN_TEAM"],
    [String(legacy.ana.userId), { ...existing(), organizationId: randomMongoId() }, 404, "ORGANIZATION_NOT_FOUND"],
    [String(legacy.ana.userId), { ...existing(), organizationId: "$(reboot)" }, 404, "ORGANIZATION_NOT_FOUND"],
    ["not-an-id; rm -rf /", existing(), 404, "USER_NOT_FOUND"],
    [receiving.members.planner.userId, existing(), 409, "NOT_A_LEGACY_CUSTOMER"],
  ];
  for (const [userId, body, status, code] of cases) {
    const res = await api(adminToken, "POST", `/${encodeURIComponent(userId)}/placements`, body);
    assert.deepEqual([res.status, res.body.code], [status, code], JSON.stringify(body));
  }
  assert.equal((await api(adminToken, "POST", "/placements/placement-2026-11-17T09:00:00.000Z-00000000/rollback")).body.code, "PLACEMENT_NOT_FOUND");
  assert.equal((await api(adminToken, "GET", "/placements/placement-2026-11-17T09:00:00.000Z-00000000")).status, 404);
  assert.equal(launches.length, before);
  assert.equal(await journal().countDocuments({ userId: String(legacy.ana.userId) }), 0);
});

test("a placement is queued (202), run by the task, and read back as succeeded; then rolled back the same way", async () => {
  const who = legacy.ana;
  const target = receiving.organizationId;
  const before = launches.length;
  const queued = await api(adminToken, "POST", `/${who.userId}/placements`, existing("team_manager"), { "idempotency-key": `ana-${tag}` });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const placement = queued.body.data.placement;
  assert.equal(queued.body.data.replayed, false);
  assert.deepEqual([placement.status, placement.operation, placement.state, placement.task.status], ["queued", "placement", "queued", "queued"]);
  assert.equal(launches.length, before + 1);
  assert.equal(launches[launches.length - 1].runId, placement.runId);
  // Nothing moves in the API process.
  await untouched(who, target);
  assert.equal((await run(placement.runId)).status, "queued");

  // The same request again: the same run, no second task. Without the key it is refused.
  const again = await api(adminToken, "POST", `/${who.userId}/placements`, existing("team_manager"), { "idempotency-key": `ana-${tag}` });
  assert.deepEqual([again.status, again.body.data.replayed, again.body.data.placement.runId], [202, true, placement.runId]);
  assert.equal((await api(adminToken, "POST", `/${who.userId}/placements`, existing("team_manager"))).body.code, "PLACEMENT_IN_PROGRESS");
  assert.equal((await api(adminToken, "POST", `/${legacy.ben.userId}/placements`, existing(), { "idempotency-key": `ana-${tag}` })).body.code, "IDEMPOTENCY_KEY_REUSED");
  // One task at a time across the platform.
  const busy = await api(adminToken, "POST", `/${legacy.ben.userId}/placements`, existing());
  assert.deepEqual([busy.status, busy.body.code, busy.headers.get("retry-after")], [429, "PLACEMENT_CAPACITY_REACHED", "30"]);
  assert.equal((await api(adminToken, "POST", `/placements/${placement.runId}/rollback`)).body.code, "PLACEMENT_IN_PROGRESS");
  assert.equal(launches.length, before + 1);

  const outcome = await runTask(placement.runId);
  assert.equal(outcome.ran && outcome.ok, true, JSON.stringify(outcome));
  const done = await run(placement.runId);
  assert.deepEqual([done.status, done.state, done.task.status, done.rollbackRequired], ["succeeded", "done", "succeeded", false]);
  assert.equal(done.verification.passed, true, JSON.stringify(done.verification));
  assert.deepEqual((await OrganizationMembership.findOne({ organizationId: target, userId: who.userId }).lean())?.roles, ["team_manager"]);
  assert.equal(await ownedIn(target, who.userId), 1);
  assert.equal(await pgReferences(await pgOrganization(target)), 1);
  assert.equal(await pgReferences(who.pgOrg), 0);
  assert.deepEqual(await findCustomerLeftovers({ organizationId: String(who.holding), pool: postgresPool() }), { mongo: {}, postgres: {} });
  const entry = await journal().findOne({ runId: placement.runId });
  assert.deepEqual([entry?.inFlight, entry?.taskSlot], [undefined, undefined], "the user's lock and the slot are released");

  // The same audit events as the synchronous path, naming the staff member who asked.
  const audit = await SecurityAuditEvent.findOne({ organizationId: target, action: "organization.legacy_customer.placed", targetId: String(who.userId) }).lean();
  assert.equal(String(audit?.actorUserId), String(dxg.admin));
  assert.equal(audit?.metadata.runId, placement.runId);
  assert.ok(await SecurityAuditEvent.exists({ organizationId: dxg.org, actorUserId: dxg.admin, action: "admin.organization.legacy_customer.placed", targetId: String(who.userId) }));

  // A second task for the same run (ECS started two, or an operator re-ran it) does nothing.
  assert.deepEqual(await runTask(placement.runId), { ran: false, reason: "NOT_QUEUED" });
  assert.equal(await ownedIn(target, who.userId), 1);

  // Rollback, asked for by another staff member.
  const rollback = await api(secondAdminToken, "POST", `/placements/${placement.runId}/rollback`, undefined, { "idempotency-key": `ana-rb-${tag}` });
  assert.equal(rollback.status, 202, JSON.stringify(rollback.body));
  assert.deepEqual([rollback.body.data.placement.status, rollback.body.data.placement.operation, rollback.body.data.placement.state], ["queued", "rollback", "rolling_back"]);
  assert.equal(launches.length, before + 2);
  assert.equal(launches[launches.length - 1].runId, placement.runId);
  assert.notEqual(launches[launches.length - 1].launchToken, launches[launches.length - 2].launchToken);
  assert.equal((await api(adminToken, "POST", `/placements/${placement.runId}/rollback`)).body.code, "ROLLBACK_IN_PROGRESS");
  assert.equal((await api(secondAdminToken, "POST", `/placements/${placement.runId}/rollback`, undefined, { "idempotency-key": `ana-rb-${tag}` })).body.data.replayed, true);
  assert.equal(launches.length, before + 2);
  assert.equal(await ownedIn(target, who.userId), 1, "nothing moves back in the API process");

  const rolled = await runTask(placement.runId);
  assert.equal(rolled.ran && rolled.ok, true, JSON.stringify(rolled));
  const back = await run(placement.runId);
  assert.deepEqual([back.status, back.operation, back.state, back.task.operation, back.task.status], ["rolled_back", "rollback", "rolled_back", "rollback", "succeeded"]);
  await untouched(who, target);
  assert.ok(await SecurityAuditEvent.exists({ organizationId: target, actorUserId: dxg.secondAdmin, action: "organization.legacy_customer.placement_rolled_back", targetId: String(who.userId) }));
  assert.ok(await SecurityAuditEvent.exists({ organizationId: dxg.org, actorUserId: dxg.secondAdmin, action: "admin.organization.legacy_customer.placement_rolled_back", targetId: String(who.userId) }));
  assert.equal((await api(adminToken, "POST", `/placements/${placement.runId}/rollback`)).body.code, "ALREADY_ROLLED_BACK");
});

test("a new organization: the details travel in the journal, never on the command line", async () => {
  const who = legacy.ben;
  const name = `Task Events ${tag} "; DROP TABLE users; --`;
  const queued = await api(adminToken, "POST", `/${who.userId}/placements`, { target: "new", organization: { name, type: "agency", country: "US" } });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const placement = queued.body.data.placement;
  assert.deepEqual(placementTaskCommand(launches[launches.length - 1].runId), ["node", "dist/scripts/placeLegacyCustomer.js", `--task-run=${placement.runId}`]);
  const outcome = await runTask(placement.runId);
  assert.equal(outcome.ran && outcome.ok, true, JSON.stringify(outcome));
  const done = await run(placement.runId);
  assert.deepEqual([done.status, done.role, done.createdOrganization], ["succeeded", "owner", true]);
  assert.equal(done.targetOrganizationId, placement.targetOrganizationId, "the organization id the client was given is the one created");
  const org = await Organization.findById(done.targetOrganizationId).lean();
  assert.deepEqual([org?.name, org?.kind, org?.type], [name, "customer", "agency"]);
  assert.deepEqual((await OrganizationMembership.findOne({ organizationId: done.targetOrganizationId, userId: who.userId }).lean())?.roles, ["owner"]);
});

test("concurrent requests for one user queue one run and start one task; concurrent rollbacks likewise", async () => {
  const who = legacy.cy;
  const before = launches.length;
  const results = await Promise.all([1, 2, 3, 4].map(() => api(adminToken, "POST", `/${who.userId}/placements`, existing())));
  assert.equal(results.filter((r) => r.status === 202).length, 1, JSON.stringify(results.map((r) => r.body.code)));
  for (const r of results.filter((x) => x.status !== 202)) assert.equal(r.body.code, "PLACEMENT_IN_PROGRESS");
  assert.equal(launches.length, before + 1);
  assert.equal(await journal().countDocuments({ userId: String(who.userId) }), 1);
  const runId = results.find((r) => r.status === 202)!.body.data.placement.runId;
  assert.equal((await runTask(runId)).ran, true);

  const rollbacks = await Promise.all([1, 2, 3].map(() => api(adminToken, "POST", `/placements/${runId}/rollback`)));
  assert.equal(rollbacks.filter((r) => r.status === 202).length, 1, JSON.stringify(rollbacks.map((r) => r.body.code)));
  for (const r of rollbacks.filter((x) => x.status !== 202)) assert.equal(r.body.code, "ROLLBACK_IN_PROGRESS");
  assert.equal(launches.length, before + 2);
  assert.equal((await runTask(runId)).ran, true);
  assert.equal((await run(runId)).status, "rolled_back");
});

test("concurrent requests for different users respect the global cap in the database", async () => {
  const before = launches.length;
  const results = await Promise.all([legacy.cy, legacy.dee, legacy.eve].map((who) => api(adminToken, "POST", `/${who.userId}/placements`, existing())));
  assert.equal(results.filter((r) => r.status === 202).length, 1, JSON.stringify(results.map((r) => r.body.code)));
  for (const r of results.filter((x) => x.status !== 202)) assert.equal(r.body.code, "PLACEMENT_CAPACITY_REACHED");
  assert.equal(launches.length, before + 1);
  const winner = results.find((r) => r.status === 202)!.body.data.placement;
  assert.equal((await runTask(winner.runId)).ran, true);
  // Put the winner back so later tests start from a holding tenant.
  await api(adminToken, "POST", `/placements/${winner.runId}/rollback`);
  assert.equal((await runTask(winner.runId)).ran, true);
});

test("a task that can't be started: 503, nothing queued behind it, and the request can be made again", async () => {
  const who = legacy.dee;
  failLaunch = true;
  const res = await api(adminToken, "POST", `/${who.userId}/placements`, existing());
  failLaunch = false;
  assert.deepEqual([res.status, res.body.code], [503, "PLACEMENT_TASK_START_FAILED"]);
  const failed = await run(res.body.details.runId);
  assert.deepEqual([failed.status, failed.state, failed.task.code, failed.rollbackRequired], ["failed", "aborted", "PLACEMENT_TASK_START_FAILED", false]);
  await untouched(who, receiving.organizationId);
  // If ECS had started it after all, the task finds nothing to do.
  assert.deepEqual(await runTask(res.body.details.runId), { ran: false, reason: "NOT_QUEUED" });
  assert.equal((await api(adminToken, "POST", `/placements/${res.body.details.runId}/rollback`)).body.code, "NOTHING_TO_ROLL_BACK");
  const retried = await api(adminToken, "POST", `/${who.userId}/placements`, existing());
  assert.equal(retried.status, 202, JSON.stringify(retried.body));
  assert.equal((await runTask(retried.body.data.placement.runId)).ran, true);
  assert.equal((await run(retried.body.data.placement.runId)).status, "succeeded");
});

test("a placement the task refuses or fails reports the code and moves nothing", async () => {
  const who = legacy.eve;
  const target = receiving.organizationId;
  const team = await Team.create({ organizationId: target, name: `Task West ${tag}` });
  // A stale team membership makes the MongoDB transaction fail after Postgres has moved.
  await TeamMembership.collection.insertOne({ organizationId: new mongoose.Types.ObjectId(target), teamId: team._id, userId: who.userId, isManager: false });
  const queued = await api(adminToken, "POST", `/${who.userId}/placements`, { ...existing(), teamId: String(team._id) });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const runId = queued.body.data.placement.runId;
  const outcome = await runTask(runId);
  assert.deepEqual([outcome.ran, outcome.ran && outcome.ok, outcome.ran && !outcome.ok && outcome.code], [true, false, "PLACEMENT_FAILED"]);
  const failed = await run(runId);
  assert.deepEqual([failed.status, failed.state, failed.task.status, failed.task.code, failed.rollbackRequired], ["failed", "aborted", "failed", "PLACEMENT_FAILED", false]);
  await TeamMembership.collection.deleteMany({ userId: who.userId });
  await untouched(who, target);

  // The request was valid when queued but not when the task ran it: refused there, same code.
  const second = await api(adminToken, "POST", `/${who.userId}/placements`, { ...existing(), teamId: String(team._id) });
  assert.equal(second.status, 202, JSON.stringify(second.body));
  await Team.collection.updateOne({ _id: team._id }, { $set: { archived: true } });
  const refused = await runTask(second.body.data.placement.runId);
  assert.equal(refused.ran && !refused.ok && refused.code, "UNKNOWN_TEAM");
  const view = await run(second.body.data.placement.runId);
  assert.deepEqual([view.status, view.state, view.task.code], ["failed", "aborted", "UNKNOWN_TEAM"]);
  await untouched(who, target);
  const entry = await journal().findOne({ runId: second.body.data.placement.runId });
  assert.deepEqual([entry?.inFlight, entry?.taskSlot], [undefined, undefined]);
});

test("a placement whose checks fail is rolled back by the task and reported with the verification", async () => {
  const who = legacy.fay;
  const stray = oid();
  await Proposal.collection.insertOne({ _id: stray, organizationId: who.holding, userId: oid(), status: "unsubmitted", isDraft: true });
  const queued = await api(adminToken, "POST", `/${who.userId}/placements`, existing());
  const runId = queued.body.data.placement.runId;
  const outcome = await runTask(runId);
  assert.equal(outcome.ran && !outcome.ok && outcome.code, "PLACEMENT_VERIFICATION_FAILED");
  const view = await run(runId);
  assert.deepEqual([view.status, view.state, view.task.status, view.task.code], ["rolled_back", "rolled_back", "failed", "PLACEMENT_VERIFICATION_FAILED"]);
  assert.equal(view.task.details.rolledBack, true);
  assert.equal(view.task.details.verification.passed, false);
  await Proposal.collection.deleteOne({ _id: stray });
  await untouched(who, receiving.organizationId);
});

test("a queued task that never starts is given up on at the next read; a late start does nothing", async () => {
  const who = legacy.gus;
  const queued = await api(adminToken, "POST", `/${who.userId}/placements`, existing());
  const runId = queued.body.data.placement.runId;
  assert.equal((await run(runId)).status, "queued");
  // Eleven minutes pass (the start timeout is ten).
  await journal().updateOne({ runId }, { $set: { "task.requestedAt": new Date(Date.now() - 11 * 60_000) } });
  const view = await run(runId);
  assert.deepEqual([view.status, view.state, view.task.status, view.task.code, view.rollbackRequired], ["failed", "aborted", "failed", "PLACEMENT_TASK_NOT_STARTED", false]);
  const entry = await journal().findOne({ runId });
  assert.deepEqual([entry?.inFlight, entry?.taskSlot], [undefined, undefined]);
  assert.deepEqual(await runTask(runId), { ran: false, reason: "NOT_QUEUED" });
  await untouched(who, receiving.organizationId);
  // The user and the slot are free again.
  const retried = await api(adminToken, "POST", `/${who.userId}/placements`, existing());
  assert.equal(retried.status, 202, JSON.stringify(retried.body));
  assert.equal((await runTask(retried.body.data.placement.runId)).ran, true);
  assert.equal((await run(retried.body.data.placement.runId)).status, "succeeded");
});

// The dangerous case: the API gives up on a task that is in fact still working. The task must
// not be able to commit the move afterwards, or the customer could be placed twice.
test("a task the API has given up on cannot commit: nothing moves in either store", async () => {
  const who = legacy.hal;
  const target = receiving.organizationId;
  const team = await Team.create({ organizationId: target, name: `Task North ${tag}` });
  const queued = await api(adminToken, "POST", `/${who.userId}/placements`, { ...existing(), teamId: String(team._id) });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const runId = queued.body.data.placement.runId;

  // Inside the task's MongoDB transaction, after Postgres has moved (uncommitted): its heartbeat
  // goes stale and the API, asked for the run, gives up on it.
  const create = TeamMembership.create;
  const seen: { interventions: number; byApi: Record<string, any> | null; leaseLost: string | null } = { interventions: 0, byApi: null, leaseLost: null };
  (TeamMembership as unknown as { create: unknown }).create = async function (this: unknown, ...args: unknown[]) {
    if (seen.interventions++ === 0) {
      await journal().updateOne({ runId }, { $set: { "task.heartbeatAt": new Date(Date.now() - 4 * 60_000) } });
      seen.byApi = await run(runId);
    }
    return (create as unknown as (...a: unknown[]) => unknown).apply(this, args);
  };
  let outcome: PlacementTaskOutcome;
  try {
    // No heartbeat fires during the run, so the only thing stopping the commit is the journal.
    outcome = await runPlacementTask({ runId, pool: taskPool, heartbeatMs: 3_600_000, onLeaseLost: (reason) => { seen.leaseLost = reason; } });
  } finally {
    (TeamMembership as unknown as { create: unknown }).create = create;
  }
  assert.ok(seen.interventions >= 1, "the placement reached its MongoDB transaction");
  assert.equal(seen.leaseLost, null);
  assert.deepEqual([seen.byApi?.status, seen.byApi?.state, seen.byApi?.task.code], ["failed", "aborted", "PLACEMENT_TASK_LOST"]);
  assert.equal(outcome.ran && !outcome.ok && outcome.code, "PLACEMENT_FAILED");
  await untouched(who, target);
  assert.equal(await TeamMembership.exists({ teamId: team._id, userId: who.userId }), null);
  const view = await run(runId);
  // The API's verdict stands; the task's late report does not overwrite it.
  assert.deepEqual([view.status, view.state, view.task.status, view.task.code, view.rollbackRequired], ["failed", "aborted", "failed", "PLACEMENT_TASK_LOST", false]);
  assert.equal((await api(adminToken, "POST", `/placements/${runId}/rollback`)).body.code, "NOTHING_TO_ROLL_BACK");

  // A heartbeat on a run the API has given up on is refused, which is what tells the task to stop.
  const entry = await journal().findOne({ runId });
  assert.equal(await recordTaskHeartbeat(runId, entry!.task.requestedAt), false);

  // And the customer can still be placed.
  const again = await api(adminToken, "POST", `/${who.userId}/placements`, existing());
  assert.equal(again.status, 202, JSON.stringify(again.body));
  const secondRun = again.body.data.placement.runId;
  assert.equal((await runTask(secondRun)).ran, true);
  assert.equal((await run(secondRun)).status, "succeeded");
});
