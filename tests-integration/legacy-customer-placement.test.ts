// ORG-110: a DXG admin places a legacy customer (in a holding tenant since ORG-107) into a new or
// an existing organization through the admin API, on real MongoDB and Postgres, and rolls each
// placement back by run id. ORG-109's checks pass after every run. Rollback moves back only what
// the run moved; a failed MongoDB half or failed checks leave nothing moved; a double submit
// places once.
import { TEST_MONGODB_DB_NAME } from "./env";
import { connectMongo, disconnectMongo, ensureMigrated, ensureServices, randomMongoId } from "./setup";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import http from "node:http";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import app from "../server";
import Team from "../modal/teamModel";
import TeamMembership from "../modal/teamMembershipModel";
import Admin from "../modal/adminModel";
import Organization from "../modal/organizationModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import Proposal from "../modal/proposalsModel";
import SecurityAuditEvent from "../modal/securityAuditEventModel";
import User from "../modal/userModel";
import { beginAuthenticatedSession } from "../src/modules/auth/composition";
import { closePostgres, postgresPool } from "../config/postgres";
import { closeSecurityRateLimitRedis } from "../middleware/securityRateLimit";
import { closePlacementPool } from "../controller/adminLegacyCustomersController";
import { resolveRfpActor } from "../src/modules/identity/application/resolveRfpActor";
import { mongoActorLookups } from "../src/modules/identity/application/mongoActorLookups";
import { rfpListScope } from "../src/modules/identity/domain/rfpAccessPolicy";
import { findCustomerLeftovers, findOrphanedProposals } from "../src/modules/tenancy/migrationVerification";
import { cleanupOrganizations, seedOrganization, type Fixture } from "./memberFixtures";

const tag = randomMongoId().slice(0, 10);
const oid = () => new mongoose.Types.ObjectId();
let server: http.Server;
let baseUrl: string;
let adminToken: string;
let customerToken: string;
let receiving: Fixture;
const dxg = { org: oid(), admin: oid() };
type Legacy = { userId: mongoose.Types.ObjectId; holding: mongoose.Types.ObjectId; proposals: mongoose.Types.ObjectId[]; pgOrg?: string };
const legacy: Record<"ana" | "ben" | "cy" | "dee" | "eve" | "fay" | "gus", Legacy> = {
  ana: { userId: oid(), holding: oid(), proposals: [oid(), oid()] },
  ben: { userId: oid(), holding: oid(), proposals: [oid()] },
  cy: { userId: oid(), holding: oid(), proposals: [] },
  dee: { userId: oid(), holding: oid(), proposals: [oid()] },
  eve: { userId: oid(), holding: oid(), proposals: [oid()] },
  fay: { userId: oid(), holding: oid(), proposals: [oid()] },
  gus: { userId: oid(), holding: oid(), proposals: [oid()] },
};
let second: Fixture;

const api = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${baseUrl}/api/admin/legacy-customers${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const pgOrganization = async (mongoId: string) =>
  (await postgresPool().query<{ id: string }>("SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1", [mongoId])).rows[0]?.id ?? null;
const pgReferences = async (pgOrgId: string | null) =>
  pgOrgId ? Number((await postgresPool().query("SELECT count(*) FROM rfpilot.proposal_references WHERE organization_id=$1", [pgOrgId])).rows[0].count) : 0;
const ownedIn = (organizationId: mongoose.Types.ObjectId | string, userId: mongoose.Types.ObjectId) =>
  Proposal.collection.countDocuments({ organizationId: new mongoose.Types.ObjectId(String(organizationId)), userId });
const unplacedIds = async () => ((await api(adminToken, "GET", "/")).body.data.customers as Array<{ userId: string }>).map((c) => c.userId);
const orphansIn = async (organizationId: string) =>
  (await findOrphanedProposals()).byOrganization.find((o) => o.organizationId === organizationId)?.count ?? 0;

const seedLegacy = async (name: string, who: Legacy) => {
  await Organization.collection.insertOne({ _id: who.holding, name: `${name} Holding`, slug: `legacy-${who.userId}`, status: "active", kind: "legacy_holding", plan: "free_trial" });
  await User.collection.insertOne({ _id: who.userId, organizationId: who.holding, name, email: `${name.toLowerCase()}-${tag}@example.com`, password: "not-a-real-hash", role: "customer", isBlocked: false });
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
  await Organization.collection.insertOne({ _id: dxg.org, name: "DXG", slug: `intg-dxg-${tag}`, status: "active", kind: "customer", plan: "free_trial" });
  await Admin.collection.insertOne({ _id: dxg.admin, organizationId: dxg.org, name: "Staff", email: `staff-${tag}@example.com`, password: "not-a-real-hash", role: "admin", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: dxg.admin, roles: ["dxg_admin"], status: "active", version: 1 });
  adminToken = (await beginAuthenticatedSession({ userId: String(dxg.admin), organizationId: String(dxg.org), correlationId: randomMongoId() })).accessToken;
  await seedLegacy("Ana", legacy.ana);
  await seedLegacy("Ben", legacy.ben);
  await seedLegacy("Cy", legacy.cy);
  for (const name of ["Dee", "Eve", "Fay", "Gus"] as const) await seedLegacy(name, legacy[name.toLowerCase() as "dee" | "eve" | "fay" | "gus"]);
  receiving = await seedOrganization("Receiving Org");
  second = await seedOrganization("Second Receiving Org");
  customerToken = receiving.members.organization_admin.accessToken;
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    const holdings = Object.values(legacy).map((l) => l.holding);
    const placed = await Organization.find({ name: { $in: [new RegExp(`^Ana Events ${tag}`), new RegExp(`^Eve Events ${tag}`)] } }).select("_id").lean();
    const orgIds = [dxg.org, ...holdings, ...placed.map((o) => o._id)];
    await OrganizationMembership.collection.deleteMany({ organizationId: { $in: orgIds } });
    await Proposal.collection.deleteMany({ organizationId: { $in: orgIds } });
    await TeamMembership.collection.deleteMany({ organizationId: { $in: [new mongoose.Types.ObjectId(second.organizationId)] } });
    await Team.collection.deleteMany({ organizationId: new mongoose.Types.ObjectId(second.organizationId) });
    await User.collection.deleteMany({ _id: { $in: Object.values(legacy).map((l) => l.userId) } });
    await Admin.collection.deleteOne({ _id: dxg.admin });
    await Organization.collection.deleteMany({ _id: { $in: orgIds } });
    await cleanupOrganizations();
  }
  await closePlacementPool();
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
});

test("DXG admins list unplaced legacy customers with proposal counts; customers can't", async () => {
  const res = await api(adminToken, "GET", "/");
  assert.equal(res.status, 200);
  const byId = new Map((res.body.data.customers as Array<{ userId: string; proposalCount: number; email: string }>).map((c) => [c.userId, c]));
  assert.equal(byId.get(String(legacy.ana.userId))?.proposalCount, 2);
  assert.equal(byId.get(String(legacy.ben.userId))?.proposalCount, 1);
  assert.equal(byId.get(String(legacy.cy.userId))?.proposalCount, 0);
  assert.equal((await api(customerToken, "GET", "/")).status, 403);
  assert.equal((await api(customerToken, "POST", `/${legacy.ana.userId}/placements`, { target: "new", organization: { name: "Nope" } })).status, 403);
});

test("placing into a new organization makes the customer its Owner, and rolls back", async () => {
  const placed = await api(adminToken, "POST", `/${legacy.ana.userId}/placements`, {
    target: "new", organization: { name: `Ana Events ${tag}`, type: "agency", country: "US", timeZone: "America/New_York" },
  });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const placement = placed.body.data.placement;
  assert.equal(placement.role, "owner");
  assert.equal(placement.createdOrganization, true);
  assert.equal(placement.verification.passed, true, JSON.stringify(placement.verification));
  const target = placement.targetOrganizationId as string;

  const org = await Organization.findById(target).lean();
  assert.equal(org?.kind, "customer");
  assert.equal(org?.type, "agency");
  const membership = await OrganizationMembership.findOne({ organizationId: target, userId: legacy.ana.userId }).lean();
  assert.deepEqual(membership?.roles, ["owner"]);
  assert.equal(await ownedIn(target, legacy.ana.userId), 2);
  assert.equal((await User.findById(legacy.ana.userId).lean())?.organizationId?.toString(), target);
  assert.equal((await Organization.findById(legacy.ana.holding).lean())?.status, "inactive", "the holding tenant is retired");
  assert.equal(await pgReferences(await pgOrganization(target)), 2);
  assert.equal(await pgReferences(legacy.ana.pgOrg!), 0);
  assert.ok(!(await unplacedIds()).includes(String(legacy.ana.userId)));

  // ORG-109's checks.
  const leftovers = await findCustomerLeftovers({ organizationId: String(legacy.ana.holding), pool: postgresPool() });
  assert.deepEqual(leftovers, { mongo: {}, postgres: {} });
  assert.equal(await orphansIn(target), 0);

  // Audit in the target organization and in the admin's trail.
  const targetAudit = await SecurityAuditEvent.findOne({ organizationId: target, action: "organization.legacy_customer.placed" }).lean();
  assert.equal(String(targetAudit?.actorUserId), String(dxg.admin));
  assert.equal(targetAudit?.metadata.runId, placement.runId);
  assert.ok(await SecurityAuditEvent.exists({ organizationId: dxg.org, action: "admin.organization.legacy_customer.placed", targetId: String(legacy.ana.userId) }));

  // The customer signs in to the new organization and sees exactly their proposals.
  const session = await beginAuthenticatedSession({ userId: String(legacy.ana.userId), organizationId: target, correlationId: randomMongoId() });
  const list = await fetch(`${baseUrl}/api/proposals?limit=50`, { headers: { authorization: `Bearer ${session.accessToken}` } });
  assert.equal(list.status, 200);
  const ids = JSON.stringify(await list.json());
  for (const id of legacy.ana.proposals) assert.ok(ids.includes(String(id)), `sees ${id}`);

  const rolled = await api(adminToken, "POST", `/placements/${placement.runId}/rollback`);
  assert.equal(rolled.status, 200, JSON.stringify(rolled.body));
  assert.equal(await Organization.exists({ _id: target }), null, "the created organization is removed");
  assert.equal(await pgOrganization(target), null);
  assert.equal(await ownedIn(legacy.ana.holding, legacy.ana.userId), 2);
  assert.equal(await pgReferences(legacy.ana.pgOrg!), 2);
  assert.deepEqual((await OrganizationMembership.findOne({ organizationId: legacy.ana.holding, userId: legacy.ana.userId }).lean())?.roles, ["planner"]);
  assert.equal((await Organization.findById(legacy.ana.holding).lean())?.status, "active");
  assert.ok((await unplacedIds()).includes(String(legacy.ana.userId)));
  assert.equal(await orphansIn(String(legacy.ana.holding)), 0);
  assert.equal((await api(adminToken, "POST", `/placements/${placement.runId}/rollback`)).body.code, "ALREADY_ROLLED_BACK");
});

test("placing into an existing organization: the receiving Admin sees the proposals; rollback restores", async () => {
  const target = receiving.organizationId;
  for (const role of ["owner", "viewer"]) {
    const refused = await api(adminToken, "POST", `/${legacy.ben.userId}/placements`, { target: "existing", organizationId: target, role });
    assert.equal(refused.body.code, "INVALID_ROLE", role);
  }
  const withTeam = await api(adminToken, "POST", `/${legacy.ben.userId}/placements`, { target: "existing", organizationId: target, role: "planner", teamId: randomMongoId() });
  assert.equal(withTeam.body.code, "UNKNOWN_TEAM");

  const placed = await api(adminToken, "POST", `/${legacy.ben.userId}/placements`, { target: "existing", organizationId: target, role: "team_manager" });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const placement = placed.body.data.placement;
  assert.equal(placement.verification.passed, true, JSON.stringify(placement.verification));
  assert.deepEqual((await OrganizationMembership.findOne({ organizationId: target, userId: legacy.ben.userId }).lean())?.roles, ["team_manager"]);
  assert.equal(await ownedIn(target, legacy.ben.userId), 1);
  assert.equal(await pgReferences(await pgOrganization(target)), 1);

  // The receiving Admin sees Ben's proposal through the access policy; a Planner doesn't.
  const visible = async (role: "organization_admin" | "planner") => {
    const actor = await resolveRfpActor({ organizationId: target, userId: receiving.members[role].userId, roles: [role], status: "active" }, mongoActorLookups);
    return (await Proposal.collection.find(rfpListScope(actor)).toArray()).map((p) => String(p._id));
  };
  assert.ok((await visible("organization_admin")).includes(String(legacy.ben.proposals[0])));
  assert.ok(!(await visible("planner")).includes(String(legacy.ben.proposals[0])));
  assert.equal(await orphansIn(target), 0);
  assert.deepEqual(await findCustomerLeftovers({ organizationId: String(legacy.ben.holding), pool: postgresPool() }), { mongo: {}, postgres: {} });

  const rolled = await api(adminToken, "POST", `/placements/${placement.runId}/rollback`);
  assert.equal(rolled.status, 200, JSON.stringify(rolled.body));
  assert.ok(await Organization.exists({ _id: target }), "an existing organization is never deleted");
  assert.equal(await OrganizationMembership.exists({ organizationId: target, userId: legacy.ben.userId }), null);
  assert.equal(await ownedIn(legacy.ben.holding, legacy.ben.userId), 1);
  assert.equal(await pgReferences(legacy.ben.pgOrg!), 1);
  assert.equal(await OrganizationMembership.countDocuments({ organizationId: target }), 5, "the receiving organization's members are untouched");
  assert.equal(await orphansIn(target), 0);
});

test("a user who isn't waiting in a holding tenant can't be placed", async () => {
  const res = await api(adminToken, "POST", `/${receiving.members.planner.userId}/placements`, { target: "existing", organizationId: receiving.organizationId, role: "planner" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NOT_A_LEGACY_CUSTOMER");
  const missingName = await api(adminToken, "POST", `/${legacy.cy.userId}/placements`, { target: "new", organization: {} });
  assert.equal(missingName.body.code, "ORGANIZATION_NAME_REQUIRED");
});

// The review's case: after placement an Admin gives the user a colleague's RFP. Rolling back moves
// only what the placement moved; the colleague's RFP and its Postgres rows stay in the organization.
test("rollback from an existing organization moves back only what the placement moved", async () => {
  const target = second.organizationId;
  const team = await Team.create({ organizationId: target, name: `East ${tag}` });
  const placed = await api(adminToken, "POST", `/${legacy.dee.userId}/placements`, { target: "existing", organizationId: target, role: "planner", teamId: String(team._id) });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const placement = placed.body.data.placement;
  assert.ok(await TeamMembership.exists({ teamId: team._id, userId: legacy.dee.userId }), "the placement puts the user on the team");

  // The colleague's RFP, mirrored in Postgres with a conversation hanging off it.
  const pool = postgresPool();
  const pgTarget = (await pgOrganization(target))!;
  const colleague = second.members.planner;
  const colleagueRfp = oid();
  await Proposal.collection.insertOne({ _id: colleagueRfp, organizationId: new mongoose.Types.ObjectId(target), userId: new mongoose.Types.ObjectId(colleague.userId), status: "unsubmitted", isDraft: true, event: { eventName: "Colleague" } });
  const pgColleague = (await pool.query<{ id: string }>("INSERT INTO rfpilot.users(organization_id,external_mongo_id) VALUES($1,$2) RETURNING id", [pgTarget, colleague.userId])).rows[0].id;
  const colleagueRef = (await pool.query<{ id: string }>("INSERT INTO rfpilot.proposal_references(organization_id,owner_user_id,external_mongo_id) VALUES($1,$2,$3) RETURNING id", [pgTarget, pgColleague, String(colleagueRfp)])).rows[0].id;
  const conversation = randomUUID();
  await pool.query("INSERT INTO rfpilot.conversations(id,organization_id,proposal_reference_id,owner_external_user_id) VALUES($1,$2,$3,$4)", [conversation, pgTarget, colleagueRef, colleague.userId]);

  // The Admin reassigns it to the placed user, in both stores.
  await Proposal.collection.updateOne({ _id: colleagueRfp }, { $set: { userId: legacy.dee.userId } });
  const pgDee = (await pool.query<{ id: string }>("SELECT id FROM rfpilot.users WHERE organization_id=$1 AND external_mongo_id=$2", [pgTarget, String(legacy.dee.userId)])).rows[0].id;
  await pool.query("UPDATE rfpilot.proposal_references SET owner_user_id=$1 WHERE id=$2", [pgDee, colleagueRef]);

  const rolled = await api(adminToken, "POST", `/placements/${placement.runId}/rollback`);
  assert.equal(rolled.status, 200, JSON.stringify(rolled.body));
  assert.deepEqual(rolled.body.data.rollback.leftInTarget, { proposals: 1 });

  const pgOrgOf = async (table: string, id: string) => (await pool.query<{ organization_id: string }>(`SELECT organization_id FROM rfpilot.${table} WHERE id=$1`, [id])).rows[0]?.organization_id;
  assert.equal(String((await Proposal.collection.findOne({ _id: colleagueRfp }))?.organizationId), target, "the colleague's RFP stays");
  assert.equal(await pgOrgOf("proposal_references", colleagueRef), pgTarget);
  assert.equal(await pgOrgOf("conversations", conversation), pgTarget);
  assert.equal(await pgOrgOf("users", pgColleague), pgTarget);
  // What the placement moved went back.
  assert.equal(await ownedIn(legacy.dee.holding, legacy.dee.userId), 1);
  assert.equal(await pgReferences(legacy.dee.pgOrg!), 1);
  assert.equal(await pgOrgOf("users", pgDee), legacy.dee.pgOrg);
  assert.equal(await TeamMembership.exists({ teamId: team._id, userId: legacy.dee.userId }), null);
  assert.equal(await OrganizationMembership.countDocuments({ organizationId: target }), 5);
});

test("concurrent placements of one user: exactly one runs and one organization is created", async () => {
  const body = { target: "new", organization: { name: `Eve Events ${tag}` } };
  const results = await Promise.all([1, 2, 3].map(() => api(adminToken, "POST", `/${legacy.eve.userId}/placements`, body)));
  assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.body.code)));
  for (const r of results.filter((x) => x.status !== 201)) assert.ok(["PLACEMENT_IN_PROGRESS", "NOT_A_LEGACY_CUSTOMER"].includes(r.body.code), r.body.code);
  const created = await Organization.find({ name: `Eve Events ${tag}` }).select("_id").lean();
  assert.equal(created.length, 1);
  assert.equal(await OrganizationMembership.countDocuments({ userId: legacy.eve.userId, status: "active", roles: "owner" }), 1);

  // Two rollbacks at once: one runs, the other is refused.
  const runId = results.find((r) => r.status === 201)!.body.data.placement.runId;
  const rollbacks = await Promise.all([1, 2].map(() => api(adminToken, "POST", `/placements/${runId}/rollback`)));
  assert.equal(rollbacks.filter((r) => r.status === 200).length, 1, JSON.stringify(rollbacks.map((r) => r.body.code)));
  assert.ok(["ROLLBACK_IN_PROGRESS", "ALREADY_ROLLED_BACK"].includes(rollbacks.find((r) => r.status !== 200)!.body.code));
  assert.equal(await ownedIn(legacy.eve.holding, legacy.eve.userId), 1);
  assert.equal(await Organization.exists({ name: `Eve Events ${tag}` }), null);
});

test("a MongoDB failure mid-placement leaves Postgres untouched and reports an error", async () => {
  const target = second.organizationId;
  const team = await Team.create({ organizationId: target, name: `West ${tag}` });
  // A stale team membership makes the MongoDB transaction fail after Postgres has moved.
  await TeamMembership.collection.insertOne({ organizationId: new mongoose.Types.ObjectId(target), teamId: team._id, userId: legacy.fay.userId, isManager: false });
  const res = await api(adminToken, "POST", `/${legacy.fay.userId}/placements`, { target: "existing", organizationId: target, role: "planner", teamId: String(team._id) });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "PLACEMENT_FAILED");
  assert.equal(await pgReferences(legacy.fay.pgOrg!), 1, "the Postgres move was not committed");
  assert.equal(await ownedIn(legacy.fay.holding, legacy.fay.userId), 1);
  assert.equal((await Organization.findById(legacy.fay.holding).lean())?.status, "active");
  assert.equal(await OrganizationMembership.exists({ organizationId: target, userId: legacy.fay.userId }), null);
  const runId = (await mongoose.connection.collection("legacycustomerplacements").findOne({ userId: String(legacy.fay.userId) }, { sort: { createdAt: -1 } }))!.runId;
  assert.equal((await api(adminToken, "GET", `/placements/${runId}`)).body.data.placement.state, "aborted");
  assert.equal((await api(adminToken, "POST", `/placements/${runId}/rollback`)).body.code, "NOTHING_TO_ROLL_BACK");
  await TeamMembership.collection.deleteMany({ userId: legacy.fay.userId });
  // Once the cause is gone the same placement goes through.
  const retried = await api(adminToken, "POST", `/${legacy.fay.userId}/placements`, { target: "existing", organizationId: target, role: "planner" });
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
});

test("a placement whose checks fail is rolled back and reported as an error", async () => {
  // Someone else's proposal in the holding tenant can't move with the user, so the holding
  // tenant isn't empty afterwards and ORG-109's check fails.
  const stray = oid();
  await Proposal.collection.insertOne({ _id: stray, organizationId: legacy.gus.holding, userId: oid(), status: "unsubmitted", isDraft: true });
  const res = await api(adminToken, "POST", `/${legacy.gus.userId}/placements`, { target: "existing", organizationId: second.organizationId, role: "planner" });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "PLACEMENT_VERIFICATION_FAILED");
  assert.equal(res.body.details.rolledBack, true);
  assert.equal(res.body.details.verification.passed, false);
  assert.equal(await ownedIn(legacy.gus.holding, legacy.gus.userId), 1);
  assert.equal(await pgReferences(legacy.gus.pgOrg!), 1);
  assert.equal((await Organization.findById(legacy.gus.holding).lean())?.status, "active");
  assert.equal(await OrganizationMembership.exists({ organizationId: second.organizationId, userId: legacy.gus.userId }), null);
  await Proposal.collection.deleteOne({ _id: stray });
});
