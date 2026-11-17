// ORG-110 on production (owner's decision, 2026-11-17): the API has no Postgres migration role and
// may not start ECS tasks, so it journals a placement or rollback as a queued run and starts an
// execution of the placement state machine, which runs the task; the task does the move and
// writes the outcome. Here the API runs exactly as in production (no POSTGRES_MIGRATION_URL, a
// placement launcher present) on real MongoDB and Postgres, with Step Functions faked: the "task"
// is the same function scripts/runPlacementTask.js calls, run in this process with the migration
// role the real task has.
//
// Proven here: the journal's unique indexes enforce one run per user, the global cap and the
// idempotency key; the run record's states; a task that never starts or stops reporting is given
// up on and cannot commit afterwards; the same audit events, naming the staff member who asked;
// and that the task does not take a journal entry's word for who asked or where records go.
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
import { buildStartExecutionInput } from "../src/modules/tenancy/placementTaskLauncher";
import { PlacementError, rollbackPlacement } from "../src/modules/tenancy/legacyCustomerPlacement";
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
// A `users` account that holds a staff membership role but is not an `admins` account.
let staffRoleUserToken: string;
const staffRoleUser = oid();
let receiving: Fixture;
// The migration role, which only the task holds.
let taskPool: Pool;
const dxg = { org: oid(), admin: oid(), secondAdmin: oid() };
type Legacy = { userId: mongoose.Types.ObjectId; holding: mongoose.Types.ObjectId; proposals: mongoose.Types.ObjectId[]; pgOrg?: string };
const names = ["ana", "ben", "cy", "dee", "eve", "fay", "gus", "hal", "ivy", "jon", "kim", "lee", "max"] as const;
const legacy = Object.fromEntries(names.map((name) => [name, { userId: oid(), holding: oid(), proposals: [oid()] }])) as Record<(typeof names)[number], Legacy>;

const launches: Array<{ runId: string; launchToken: string }> = [];
const MACHINE = { stateMachineArn: "arn:aws:states:us-east-2:111111111111:stateMachine:rfpilot-test-placement", region: "us-east-2" };
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
      if (failLaunch) throw new Error("AccessDeniedException: User: arn:aws:sts::111111111111:assumed-role/api is not authorized to perform: states:StartExecution");
      // The real launcher's own check: only a well-formed run id ever becomes an execution input.
      buildStartExecutionInput(MACHINE, input);
      launches.push(input);
    },
  });
  await Organization.collection.insertOne({ _id: dxg.org, name: "DXG", slug: `intg-dxg-task-${tag}`, status: "active", kind: "customer", plan: "free_trial" });
  for (const [id, label] of [[dxg.admin, "staff"], [dxg.secondAdmin, "staff2"]] as const) {
    await Admin.collection.insertOne({ _id: id, organizationId: dxg.org, name: label, email: `${label}-task-${tag}@example.com`, password: "not-a-real-hash", role: "admin", isBlocked: false });
    await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: id, roles: ["dxg_admin"], status: "active", version: 1 });
  }
  adminToken = (await beginAuthenticatedSession({ userId: String(dxg.admin), organizationId: String(dxg.org), correlationId: randomMongoId() })).accessToken;
  secondAdminToken = (await beginAuthenticatedSession({ userId: String(dxg.secondAdmin), organizationId: String(dxg.org), correlationId: randomMongoId() })).accessToken;
  await User.collection.insertOne({ _id: staffRoleUser, organizationId: dxg.org, name: "Leftover", email: `leftover-task-${tag}@example.com`, password: "not-a-real-hash", role: "customer", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: staffRoleUser, roles: ["dxg_admin"], status: "active", version: 1 });
  staffRoleUserToken = (await beginAuthenticatedSession({ userId: String(staffRoleUser), organizationId: String(dxg.org), correlationId: randomMongoId() })).accessToken;
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
    await User.collection.deleteMany({ _id: { $in: [...userIds, staffRoleUser] } });
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

test("a staff membership role without an admins account is refused on every route", async () => {
  const before = launches.length;
  const run = "placement-2026-11-17T09:00:00.000Z-00000000";
  const attempts: Array<[string, string, unknown?]> = [
    ["GET", "/"],
    ["GET", "/target-organizations"],
    ["POST", `/${legacy.ana.userId}/placements`, existing()],
    ["GET", `/placements/${run}`],
    ["POST", `/placements/${run}/rollback`],
  ];
  for (const [method, path, body] of attempts) {
    const res = await api(staffRoleUserToken, method, path, body);
    assert.deepEqual([res.status, res.body.code], [403, "PLACEMENT_FORBIDDEN"], `${method} ${path}`);
    assert.ok(!("data" in res.body), `${method} ${path} returns nothing`);
  }
  // The same requests from a real staff account get past the guard.
  assert.equal((await api(adminToken, "GET", "/")).status, 200);
  assert.equal((await api(adminToken, "GET", "/target-organizations")).status, 200);
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
  assert.ok(!JSON.stringify(queued.body).includes("arn:"), "no AWS identifier is returned to staff");
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
  // The key is the staff member's own: a colleague sending the same key is asking for something
  // new, which here means the ordinary answer for a customer who is already being placed.
  assert.equal((await api(secondAdminToken, "POST", `/${who.userId}/placements`, existing("team_manager"), { "idempotency-key": `ana-${tag}` })).body.code, "PLACEMENT_IN_PROGRESS");
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
  // All that leaves the API is the run id.
  assert.deepEqual(JSON.parse(buildStartExecutionInput(MACHINE, launches[launches.length - 1]).input as string), { runId: placement.runId });
  const outcome = await runTask(placement.runId);
  assert.equal(outcome.ran && outcome.ok, true, JSON.stringify(outcome));
  const done = await run(placement.runId);
  assert.deepEqual([done.status, done.role, done.createdOrganization], ["succeeded", "owner", true]);
  assert.equal(done.targetOrganizationId, placement.targetOrganizationId, "the organization id the client was given is the one created");
  const org = await Organization.findById(done.targetOrganizationId).lean();
  assert.deepEqual([org?.name, org?.kind, org?.type], [name, "customer", "agency"]);
  assert.deepEqual((await OrganizationMembership.findOne({ organizationId: done.targetOrganizationId, userId: who.userId }).lean())?.roles, ["owner"]);

  // Rolling it back deletes the organization the run created, and only because the run created it.
  assert.equal((await api(adminToken, "POST", `/placements/${placement.runId}/rollback`)).status, 202);
  const rolled = await runTask(placement.runId);
  assert.equal(rolled.ran && rolled.ok, true, JSON.stringify(rolled));
  assert.equal((await run(placement.runId)).status, "rolled_back");
  assert.equal(await Organization.exists({ _id: done.targetOrganizationId }), null);
  assert.equal(await ownedIn(who.holding, who.userId), 1);
  assert.equal(await pgReferences(who.pgOrg), 1);
  assert.equal((await Organization.findById(who.holding).lean())?.status, "active");
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
  const res = await api(adminToken, "POST", `/${who.userId}/placements`, existing(), { "idempotency-key": `dee-${tag}` });
  failLaunch = false;
  assert.deepEqual([res.status, res.body.code], [503, "PLACEMENT_TASK_START_FAILED"]);
  // AWS's error text (account id, role) stays in the server log.
  const stored = await journal().findOne({ runId: res.body.details.runId });
  for (const text of [JSON.stringify(res.body), JSON.stringify(stored)]) assert.ok(!/111111111111|arn:|AccessDenied/.test(text), text);
  const failed = await run(res.body.details.runId);
  assert.deepEqual([failed.status, failed.state, failed.task.code, failed.rollbackRequired], ["failed", "aborted", "PLACEMENT_TASK_START_FAILED", false]);
  await untouched(who, receiving.organizationId);
  // If ECS had started it after all, the task finds nothing to do.
  assert.deepEqual(await runTask(res.body.details.runId), { ran: false, reason: "NOT_QUEUED" });
  assert.equal((await api(adminToken, "POST", `/placements/${res.body.details.runId}/rollback`)).body.code, "NOTHING_TO_ROLL_BACK");
  // The same Idempotency-Key tries again: the failed run moved nothing and no longer holds the key.
  const retried = await api(adminToken, "POST", `/${who.userId}/placements`, existing(), { "idempotency-key": `dee-${tag}` });
  assert.deepEqual([retried.status, retried.body.data?.replayed], [202, false], JSON.stringify(retried.body));
  assert.notEqual(retried.body.data.placement.runId, res.body.details.runId);
  assert.equal((await runTask(retried.body.data.placement.runId)).ran, true);
  assert.equal((await run(retried.body.data.placement.runId)).status, "succeeded");
  // Once it has succeeded the key replays it.
  const replayed = await api(adminToken, "POST", `/${who.userId}/placements`, existing(), { "idempotency-key": `dee-${tag}` });
  assert.deepEqual([replayed.status, replayed.body.data.replayed, replayed.body.data.placement.status], [202, true, "succeeded"]);
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
  // Five minutes pass (the start timeout is four).
  await journal().updateOne({ runId }, { $set: { "task.requestedAt": new Date(Date.now() - 5 * 60_000) } });
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

// Checks failed and the rollback that should follow failed too: the customer's records sit in the
// target with failed checks. That must never read as a placement that succeeded.
test("failed checks whose automatic rollback also fails read as failed and rollback-required", async () => {
  const who = legacy.ivy;
  const bare = oid();
  await Organization.collection.insertOne({ _id: bare, name: `Task Events ${tag} Bare`, slug: `intg-bare-${tag}`, status: "active", kind: "customer", plan: "free_trial", createdAt: new Date("2020-01-01") });
  const team = await Team.create({ organizationId: bare, name: `Task South ${tag}` });
  const stray = oid();
  await Proposal.collection.insertOne({ _id: stray, organizationId: who.holding, userId: oid(), status: "unsubmitted", isDraft: true });
  const queued = await api(adminToken, "POST", `/${who.userId}/placements`, { target: "existing", organizationId: String(bare), role: "planner", teamId: String(team._id) });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const runId = queued.body.data.placement.runId;

  // Inside the placement's transaction the customer becomes the organization's Owner, which is
  // what makes the rollback refuse (USER_IS_OWNER) after the checks have failed.
  const create = TeamMembership.create;
  (TeamMembership as unknown as { create: unknown }).create = async function (this: unknown, ...args: unknown[]) {
    const result = await (create as unknown as (...a: unknown[]) => unknown).apply(this, args);
    await OrganizationMembership.collection.updateOne({ organizationId: bare, userId: who.userId }, { $set: { roles: ["owner"] } }, { session: (args[1] as { session: mongoose.ClientSession }).session });
    return result;
  };
  let outcome: PlacementTaskOutcome;
  try {
    outcome = await runTask(runId);
  } finally {
    (TeamMembership as unknown as { create: unknown }).create = create;
  }
  assert.equal(outcome.ran && !outcome.ok && outcome.code, "PLACEMENT_VERIFICATION_FAILED");
  const view = await run(runId);
  assert.deepEqual([view.status, view.state, view.rollbackRequired, view.task.status, view.task.code, view.task.details.rolledBack], ["failed", "failed", true, "failed", "PLACEMENT_VERIFICATION_FAILED", false]);
  assert.equal(view.task.details.verification.passed, false);
  assert.equal(await ownedIn(bare, who.userId), 1, "the records are still in the target");

  // Once the cause is gone, the run rolls back like any other.
  await OrganizationMembership.collection.updateOne({ organizationId: bare, userId: who.userId }, { $set: { roles: ["planner"] } });
  await Proposal.collection.deleteOne({ _id: stray });
  assert.equal((await api(adminToken, "POST", `/placements/${runId}/rollback`)).status, 202);
  const rolled = await runTask(runId);
  assert.equal(rolled.ran && rolled.ok, true, JSON.stringify(rolled));
  assert.equal((await run(runId)).status, "rolled_back");
  await untouched(who, String(bare));
  await Team.collection.deleteMany({ organizationId: bare });
  await Organization.collection.deleteOne({ _id: bare });
});

/* ── The journal is the trust boundary ───────────────────────────────────────────────────────
   The API writes the journal and the task, which holds the migration role, reads it. A
   compromised API could write anything there, so the task checks the entry against the database
   instead of believing it. These entries are written straight into the journal, as an attacker
   with MongoDB access would. */

const forge = async (fields: Record<string, unknown>, task: Record<string, unknown> = {}) => {
  const now = new Date();
  const runId = `placement-${now.toISOString()}-${randomMongoId().slice(0, 8)}`;
  await journal().insertOne({
    runId, createdOrganization: false, role: "planner", adminUserId: String(dxg.admin), adminOrganizationId: String(dxg.org), createdAt: now, updatedAt: now,
    ...fields,
    task: { operation: "placement", status: "queued", requestedAt: now, adminUserId: String(dxg.admin), adminOrganizationId: String(dxg.org), correlationId: "forged", ...task },
  });
  return runId;
};
const refusedRun = async (runId: string, code: string) => {
  const outcome = await runTask(runId);
  assert.equal(outcome.ran && !outcome.ok && outcome.code, code, JSON.stringify(outcome));
  const entry = await journal().findOne({ runId });
  assert.deepEqual([entry?.task.status, entry?.task.code], ["failed", code]);
  return entry!;
};

test("a forged placement request: the task looks the staff member up and re-validates everything", async () => {
  const who = legacy.jon;
  const target = receiving.organizationId;
  const request = (kind: Record<string, unknown>) => ({ target: kind, fingerprint: "forged" });
  const base = { userId: String(who.userId), state: "queued", holdingOrganizationId: String(who.holding), targetOrganizationId: target, request: request({ kind: "existing", organizationId: target, role: "planner", teamId: null }) };

  // Not a staff member at all: a customer Owner named as the actor.
  const owner = receiving.members.owner.userId;
  const asCustomer = await refusedRun(await forge(base, { adminUserId: owner, adminOrganizationId: target }), "PLACEMENT_REQUEST_INVALID");
  assert.equal(asCustomer.state, "aborted");
  // A real staff member named with someone else's organization.
  await refusedRun(await forge(base, { adminOrganizationId: target }), "PLACEMENT_REQUEST_INVALID");
  // A blocked staff account, and one with no staff membership.
  const blocked = oid();
  const unattached = oid();
  await Admin.collection.insertMany([
    { _id: blocked, organizationId: dxg.org, name: "Blocked", email: `blocked-task-${tag}@example.com`, password: "not-a-real-hash", role: "admin", isBlocked: true },
    { _id: unattached, organizationId: dxg.org, name: "Unattached", email: `unattached-task-${tag}@example.com`, password: "not-a-real-hash", role: "admin", isBlocked: false },
  ]);
  await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: blocked, roles: ["dxg_admin"], status: "active", version: 1 });
  await refusedRun(await forge(base, { adminUserId: String(blocked) }), "PLACEMENT_REQUEST_INVALID");
  await refusedRun(await forge(base, { adminUserId: String(unattached) }), "PLACEMENT_REQUEST_INVALID");
  await refusedRun(await forge(base, { adminUserId: "not-an-id" }), "PLACEMENT_REQUEST_INVALID");
  await Admin.collection.deleteMany({ _id: { $in: [blocked, unattached] } });
  await OrganizationMembership.collection.deleteMany({ organizationId: dxg.org, userId: blocked });

  // A real staff member, but a request the API would have refused.
  await refusedRun(await forge({ ...base, request: request({ kind: "existing", organizationId: target, role: "owner", teamId: null }) }), "INVALID_ROLE");
  await refusedRun(await forge({ ...base, request: request({ kind: "existing", organizationId: String(legacy.eve.holding), role: "planner", teamId: null }) }), "ORGANIZATION_NOT_FOUND");
  await refusedRun(await forge({ ...base, request: request({ kind: "new", organization: { name: "" } }) }), "ORGANIZATION_NAME_REQUIRED");
  await refusedRun(await forge({ ...base, request: undefined }), "PLACEMENT_REQUEST_INVALID");
  // Someone who is not a legacy customer, whatever holding tenant the entry claims for them.
  const member = receiving.members.planner.userId;
  await refusedRun(await forge({ ...base, userId: member }), "NOT_A_LEGACY_CUSTOMER");
  assert.ok(await OrganizationMembership.exists({ organizationId: target, userId: member }), "the member is where they were");

  await untouched(who, target);
  assert.equal(await SecurityAuditEvent.countDocuments({ targetId: String(who.userId), action: /legacy_customer/ }), 0, "a refused run writes no audit event");
  // The holding tenant and target a forged entry names are not used: the real ones are.
  const lying = await forge({ ...base, holdingOrganizationId: String(legacy.eve.holding), targetOrganizationId: String(dxg.org) });
  const outcome = await runTask(lying);
  assert.equal(outcome.ran && outcome.ok, true, JSON.stringify(outcome));
  const entry = await journal().findOne({ runId: lying });
  assert.deepEqual([entry?.holdingOrganizationId, entry?.targetOrganizationId], [String(who.holding), target]);
  assert.equal(await ownedIn(target, who.userId), 1);
  assert.equal(await ownedIn(legacy.eve.holding, legacy.eve.userId), 1, "the other customer's holding tenant is untouched");
});

test("a forged rollback: records only go back to the customer's own holding tenant, and only a run's own organization is deleted", async () => {
  const target = receiving.organizationId;
  const member = receiving.members.planner;
  const memberProposals = await ownedIn(target, new mongoose.Types.ObjectId(member.userId));
  const membersBefore = await OrganizationMembership.countDocuments({ organizationId: target });
  const rollback = (fields: Record<string, unknown>) => forge({ state: "rolling_back", rollbackFrom: "done", ...fields }, { operation: "rollback" });
  const refusedRollback = async (fields: Record<string, unknown>) => {
    const entry = await refusedRun(await rollback(fields), "PLACEMENT_REQUEST_INVALID");
    assert.deepEqual([entry.state, entry.rollbackFrom], ["done", undefined], "the run is given back as it was");
  };

  // An ordinary member of an organization, "rolled back" into a tenant that isn't theirs: a
  // customer organization, then another customer's holding tenant.
  await refusedRollback({ userId: member.userId, holdingOrganizationId: String(dxg.org), targetOrganizationId: target });
  await refusedRollback({ userId: member.userId, holdingOrganizationId: String(legacy.eve.holding), targetOrganizationId: target });
  // An existing organization claimed as one the run created, so that it would be emptied and deleted.
  await refusedRollback({ userId: member.userId, holdingOrganizationId: String(legacy.eve.holding), targetOrganizationId: target, createdOrganization: true });
  // Jon really was placed (previous test) and really has a holding tenant of his own; the
  // organization he is in is old, so it cannot be one a run created today.
  const jon = legacy.jon;
  await refusedRollback({ userId: String(jon.userId), holdingOrganizationId: String(jon.holding), targetOrganizationId: target, createdOrganization: true });
  await refusedRollback({ userId: String(jon.userId), holdingOrganizationId: String(jon.holding), targetOrganizationId: target, request: { target: { kind: "existing", organizationId: String(dxg.org), role: "planner" }, fingerprint: "forged" } });
  // The staff organization, a holding tenant as the target, the same organization twice, bad ids.
  await refusedRollback({ userId: String(jon.userId), holdingOrganizationId: String(jon.holding), targetOrganizationId: String(dxg.org) });
  await refusedRollback({ userId: String(jon.userId), holdingOrganizationId: String(jon.holding), targetOrganizationId: String(legacy.eve.holding) });
  await refusedRollback({ userId: String(jon.userId), holdingOrganizationId: target, targetOrganizationId: target });
  await refusedRollback({ userId: String(jon.userId), holdingOrganizationId: "$(reboot)", targetOrganizationId: target });
  // A customer who isn't in the organization the entry names.
  await refusedRollback({ userId: String(legacy.eve.userId), holdingOrganizationId: String(legacy.eve.holding), targetOrganizationId: target });
  // And the actor is checked here too.
  const asCustomer = await rollback({ userId: String(jon.userId), holdingOrganizationId: String(jon.holding), targetOrganizationId: target });
  await journal().updateOne({ runId: asCustomer }, { $set: { "task.adminUserId": receiving.members.owner.userId, "task.adminOrganizationId": target } });
  await refusedRun(asCustomer, "PLACEMENT_REQUEST_INVALID");

  // Nothing moved or disappeared.
  assert.ok(await Organization.exists({ _id: target, status: "active" }));
  assert.equal(await OrganizationMembership.countDocuments({ organizationId: target }), membersBefore);
  assert.equal(await ownedIn(target, new mongoose.Types.ObjectId(member.userId)), memberProposals);
  assert.equal(await ownedIn(target, jon.userId), 1);
  assert.equal(await ownedIn(legacy.eve.holding, legacy.eve.userId), 1);
  assert.equal(await pgReferences(legacy.eve.pgOrg), 1);
  assert.equal(await OrganizationMembership.exists({ organizationId: legacy.eve.holding, userId: member.userId }), null);
});

// The journal says `done` once the MongoDB move commits, which is before the Postgres commit, the
// checks and the audit events. A rollback asked for in that window must not be accepted: it would
// take the run away from the placement task in the middle of its checks.
test("while the placement task is still checking its work the run reads running and can't be rolled back", async () => {
  const who = legacy.kim;
  const target = receiving.organizationId;
  const queued = await api(adminToken, "POST", `/${who.userId}/placements`, existing());
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const runId = queued.body.data.placement.runId;
  const before = launches.length;

  // The audit write is the task's last step, after the move, both commits and the checks.
  const create = SecurityAuditEvent.create;
  const seen: { calls: number; view: Record<string, any> | null; rollback: { status: number; body: Record<string, any> } | null; state: string | null; byHand: unknown } = { calls: 0, view: null, rollback: null, state: null, byHand: null };
  (SecurityAuditEvent as unknown as { create: unknown }).create = async function (this: unknown, ...args: unknown[]) {
    if (seen.calls++ === 0) {
      seen.state = (await journal().findOne({ runId }))?.state ?? null;
      seen.view = await run(runId);
      seen.rollback = await api(secondAdminToken, "POST", `/placements/${runId}/rollback`);
      // What an operator's `placeLegacyCustomer.js --rollback=<runId> --apply` would do now.
      seen.byHand = await rollbackPlacement({ runId, actor: { adminUserId: String(dxg.admin), adminOrganizationId: String(dxg.org), correlationId: "by-hand" }, pool: taskPool })
        .catch((error: unknown) => error);
    }
    return (create as unknown as (...a: unknown[]) => unknown).apply(this, args);
  };
  let outcome: PlacementTaskOutcome;
  try {
    outcome = await runTask(runId);
  } finally {
    (SecurityAuditEvent as unknown as { create: unknown }).create = create;
  }
  assert.ok(seen.calls >= 1, "the placement reached its audit write");
  assert.equal(seen.state, "done", "the journal already says done");
  assert.deepEqual([seen.view?.status, seen.view?.operation, seen.view?.rollbackRequired], ["running", "placement", false]);
  assert.deepEqual([seen.rollback?.status, seen.rollback?.body.code], [409, "PLACEMENT_IN_PROGRESS"]);
  assert.equal(launches.length, before, "no rollback task was started");
  assert.ok(seen.byHand instanceof PlacementError, "a rollback by hand is refused as well");
  assert.equal((seen.byHand as PlacementError).code, "PLACEMENT_IN_PROGRESS");

  // The placement task was left alone and finished its work.
  assert.equal(outcome.ran && outcome.ok, true, JSON.stringify(outcome));
  const done = await run(runId);
  assert.deepEqual([done.status, done.state, done.task.operation, done.task.status, done.verification.passed], ["succeeded", "done", "placement", "succeeded", true]);
  assert.ok(await SecurityAuditEvent.exists({ organizationId: target, action: "organization.legacy_customer.placed", targetId: String(who.userId) }));
  assert.equal(await ownedIn(target, who.userId), 1);
  assert.equal(await pgReferences(who.pgOrg), 0);
  // Now it can be rolled back.
  assert.equal((await api(adminToken, "POST", `/placements/${runId}/rollback`)).status, 202);
  assert.equal((await runTask(runId)).ran, true);
  assert.equal((await run(runId)).status, "rolled_back");
  await untouched(who, target);
});

// `succeeded` has to mean the checks passed. The journal says `done` as soon as the MongoDB move
// commits; a task that then fails must not leave a run that reads as succeeded unless they did.
test("a task that fails after the move: failed and rollback-required if its checks never ran; succeeded but flagged if only the audit write failed", async () => {
  const target = receiving.organizationId;

  // 1. The checks themselves blow up (here: the first of ORG-109's queries).
  const lee = legacy.lee;
  const queued = await api(adminToken, "POST", `/${lee.userId}/placements`, existing());
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const runId = queued.body.data.placement.runId;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const verification = require("../src/modules/tenancy/migrationVerification") as { findCustomerLeftovers: (...args: unknown[]) => unknown };
  const leftovers = verification.findCustomerLeftovers;
  verification.findCustomerLeftovers = async () => { throw new Error("connection to 10.0.3.17:5432 terminated unexpectedly"); };
  let outcome: PlacementTaskOutcome;
  try {
    outcome = await runTask(runId);
  } finally {
    verification.findCustomerLeftovers = leftovers;
  }
  assert.equal(outcome.ran && !outcome.ok && outcome.code, "PLACEMENT_TASK_ERROR", JSON.stringify(outcome));
  const view = await run(runId);
  assert.deepEqual([view.status, view.state, view.rollbackRequired, view.task.status, view.task.code, view.task.details.rollbackRequired], ["failed", "failed", true, "failed", "PLACEMENT_TASK_ERROR", true]);
  assert.equal(view.verification, undefined, "no checks were recorded");
  assert.ok(!JSON.stringify(view).includes("10.0.3.17"), "the driver's message is not returned");
  assert.equal(await ownedIn(target, lee.userId), 1, "the move did happen");
  assert.equal(await SecurityAuditEvent.exists({ action: "organization.legacy_customer.placed", targetId: String(lee.userId) }), null);
  // And it rolls back.
  assert.equal((await api(adminToken, "POST", `/placements/${runId}/rollback`)).status, 202);
  const rolled = await runTask(runId);
  assert.equal(rolled.ran && rolled.ok, true, JSON.stringify(rolled));
  assert.equal((await run(runId)).status, "rolled_back");
  await untouched(lee, target);

  // 2. The move, both commits and the checks went through; only the audit write fails.
  const max = legacy.max;
  const second = await api(adminToken, "POST", `/${max.userId}/placements`, existing());
  assert.equal(second.status, 202, JSON.stringify(second.body));
  const secondRun = second.body.data.placement.runId;
  const create = SecurityAuditEvent.create;
  (SecurityAuditEvent as unknown as { create: unknown }).create = async () => { throw new Error("audit store unavailable"); };
  let audited: PlacementTaskOutcome;
  try {
    audited = await runTask(secondRun);
  } finally {
    (SecurityAuditEvent as unknown as { create: unknown }).create = create;
  }
  assert.equal(audited.ran && !audited.ok && audited.code, "PLACEMENT_TASK_ERROR", JSON.stringify(audited));
  const stands = await run(secondRun);
  assert.deepEqual([stands.status, stands.state, stands.rollbackRequired, stands.verification.passed, stands.task.status, stands.task.details.auditUnconfirmed], ["succeeded", "done", false, true, "failed", true]);
  assert.equal(await ownedIn(target, max.userId), 1);
  assert.equal(await pgReferences(max.pgOrg), 0);
});
