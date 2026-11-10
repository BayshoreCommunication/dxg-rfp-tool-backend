// ORG-603: plan management through the real API on real MongoDB. RFPilot staff (an `admins`
// account) see every customer organization's plan and RFP usage and change the plan; the change
// applies on the customer's next request and is audited in the customer's organization. No
// customer role, and no member holding a staff role, can read or change a plan.
import { TEST_MONGODB_DB_NAME } from "./env";
import { connectMongo, disconnectMongo, ensureMigrated, ensureServices, randomMongoId } from "./setup";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import http from "node:http";
import mongoose from "mongoose";
import app from "../server";
import Admin from "../modal/adminModel";
import Organization from "../modal/organizationModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import Proposal from "../modal/proposalsModel";
import RefreshSession from "../modal/refreshSessionModel";
import SecurityAuditEvent from "../modal/securityAuditEventModel";
import User from "../modal/userModel";
import { beginAuthenticatedSession } from "../src/modules/auth/composition";
import { closePostgres } from "../config/postgres";
import { closeSecurityRateLimitRedis } from "../middleware/securityRateLimit";
import { closeSupportRedis } from "../src/modules/supportDesk/infrastructure/redis/supportRedis";
import { closeQueue } from "../src/modules/durableJobs/queue";
import { cleanupOrganizations, ROLES, seedOrganization, SLUG_PREFIX, type Fixture } from "./memberFixtures";

const tag = randomMongoId().slice(0, 10);
const oid = (value?: string) => new mongoose.Types.ObjectId(value);
const PLANS = "/api/v1/admin/organization-plans";

let server: http.Server;
let baseUrl: string;
let acme: Fixture;
let other: Fixture;
let staffToken: string;
let superToken: string;
let impostorToken: string;
// DXG's own organization: two staff accounts and a `users` account holding a staff role.
const dxg = { org: oid(), staff: oid(), superAdmin: oid(), impostor: oid() };
const holding = oid();

const call = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const planEvents = (organizationId: string | mongoose.Types.ObjectId) =>
  SecurityAuditEvent.find({ organizationId, action: "organization.plan_changed" }).sort({ createdAt: 1, _id: 1 }).lean();
const stored = async (organizationId: string | mongoose.Types.ObjectId) => {
  const row = await Organization.findById(organizationId).select("plan proposalsCreated").lean();
  return { plan: row?.plan, proposalsCreated: row?.proposalsCreated };
};
const sessionFor = async (userId: mongoose.Types.ObjectId, organizationId: mongoose.Types.ObjectId) =>
  (await beginAuthenticatedSession({ userId: String(userId), organizationId: String(organizationId), correlationId: randomMongoId() })).accessToken;
const createRfp = (token: string) => call(token, "POST", "/api/proposals", { event: { eventName: `Gala ${randomMongoId().slice(0, 6)}` } });

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);

  acme = await seedOrganization(`Acme Events ${tag}`);
  other = await seedOrganization(`Other Co ${tag}`);

  await Organization.collection.insertOne({ _id: dxg.org, name: `DXG ${tag}`, slug: `${SLUG_PREFIX}dxg-${tag}`, status: "active", kind: "customer", plan: "free_trial", proposalsCreated: 0 });
  await Organization.collection.insertOne({ _id: holding, name: `Holding ${tag}`, slug: `${SLUG_PREFIX}holding-${tag}`, status: "active", kind: "legacy_holding", plan: "free_trial", proposalsCreated: 0 });
  await Admin.collection.insertOne({ _id: dxg.staff, organizationId: dxg.org, name: "Staff Agent", email: `staff-${tag}@example.com`, password: "not-a-real-hash", role: "admin", isBlocked: false });
  await Admin.collection.insertOne({ _id: dxg.superAdmin, organizationId: dxg.org, name: "Staff Lead", email: `lead-${tag}@example.com`, password: "not-a-real-hash", role: "super_admin", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: dxg.staff, roles: ["dxg_admin"], status: "active", version: 1 });
  await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: dxg.superAdmin, roles: ["super_admin"], status: "active", version: 1 });
  await User.collection.insertOne({ _id: dxg.impostor, organizationId: dxg.org, name: "Member With Staff Role", email: `impostor-${tag}@example.com`, password: "not-a-real-hash", role: "customer", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: dxg.impostor, roles: ["dxg_admin"], status: "active", version: 1 });
  staffToken = await sessionFor(dxg.staff, dxg.org);
  superToken = await sessionFor(dxg.superAdmin, dxg.org);
  impostorToken = await sessionFor(dxg.impostor, dxg.org);

  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    const orgIds = [dxg.org, holding, oid(acme.organizationId), oid(other.organizationId)];
    const db = mongoose.connection.db!;
    for (const name of ["proposalstatustransitions", "notifications"]) {
      await db.collection(name).deleteMany({ organizationId: { $in: orgIds } });
    }
    await OrganizationMembership.collection.deleteMany({ organizationId: dxg.org });
    await RefreshSession.deleteMany({ organizationId: dxg.org });
    await User.collection.deleteMany({ organizationId: dxg.org });
    await Admin.collection.deleteMany({ _id: { $in: [dxg.staff, dxg.superAdmin] } });
    await cleanupOrganizations();
  }
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
  await closeSupportRedis();
  await closeQueue();
});

test("AC: staff see every customer organization's plan and RFPs created against the limit", async () => {
  await Organization.updateOne({ _id: acme.organizationId }, { $set: { proposalsCreated: 1 } });
  const listed = await call(staffToken, "GET", `${PLANS}?search=${tag}`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const rows = listed.body.data.organizations as Array<Record<string, any>>;
  // Sorted by name; the legacy holding tenant is exempt from plans and not listed.
  assert.deepEqual(rows.map((row) => row.name), [`Acme Events ${tag}`, `DXG ${tag}`, `Other Co ${tag}`]);
  assert.deepEqual(
    { id: rows[0].id, plan: rows[0].plan, proposals: rows[0].proposals, features: rows[0].features, status: rows[0].status },
    {
      id: acme.organizationId, plan: "free_trial", status: "active",
      proposals: { created: 1, limit: 2, remaining: 1, canCreate: true },
      features: { vendorResponses: false, proposalIntelligence: false },
    },
  );
  assert.deepEqual(listed.body.data.plans.map((plan: any) => [plan.id, plan.proposalLimit]), [["free_trial", 2], ["full_access", null]]);
  assert.equal(listed.body.data.pagination.total, 3);
  // Nothing about an organization's people or RFPs is in the staff directory.
  assert.ok(!JSON.stringify(listed.body).includes("@example.com"));

  const one = await call(superToken, "GET", `${PLANS}/${acme.organizationId}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.data.organization.name, `Acme Events ${tag}`);
  assert.deepEqual(one.body.data.history, []);
  // Search also takes an organization id.
  assert.deepEqual((await call(staffToken, "GET", `${PLANS}?search=${other.organizationId}`)).body.data.organizations.map((row: any) => row.id), [other.organizationId]);
});

test("AC: a plan change by staff is stored, audited in that organization, and applies on the customer's next request", async () => {
  const owner = acme.members.owner.accessToken;
  await Organization.updateOne({ _id: acme.organizationId }, { $set: { proposalsCreated: 0 } });
  assert.equal((await createRfp(owner)).status, 201);
  assert.equal((await createRfp(owner)).status, 201);
  assert.equal((await createRfp(owner)).body.code, "PLAN_LIMIT_REACHED");
  assert.equal((await call(owner, "GET", "/api/vendor-responses/proposals")).body.code, "PLAN_FEATURE_LOCKED");

  const raised = await call(staffToken, "PUT", `${PLANS}/${acme.organizationId}`, { plan: "full_access", note: "Launch customer" });
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  assert.equal(raised.body.data.changed, true);
  assert.deepEqual(raised.body.data.organization.proposals, { created: 2, limit: null, remaining: null, canCreate: true });
  assert.deepEqual(await stored(acme.organizationId), { plan: "full_access", proposalsCreated: 2 });

  // The customer's existing session is unlocked at once: no sign-out, no token refresh.
  assert.equal((await createRfp(owner)).status, 201);
  assert.equal((await call(owner, "GET", "/api/vendor-responses/proposals")).status, 200);
  assert.equal((await call(owner, "GET", "/api/organization/entitlements")).body.data.plan, "full_access");

  const [event, ...rest] = await planEvents(acme.organizationId);
  assert.equal(rest.length, 0);
  assert.deepEqual(
    { actor: String(event.actorUserId), targetType: event.targetType, targetId: event.targetId, decision: event.decision, reason: event.reason, metadata: event.metadata },
    {
      actor: String(dxg.staff), targetType: "organization", targetId: acme.organizationId, decision: "allowed", reason: "staff_plan_change",
      metadata: { fromPlan: "free_trial", toPlan: "full_access", proposalsCreated: 2, actorAccountType: "admin", actorOrganizationId: String(dxg.org), note: "Launch customer" },
    },
  );
  // The event is in the customer's organization only.
  assert.equal((await planEvents(dxg.org)).length, 0);
  assert.equal((await planEvents(other.organizationId)).length, 0);
  assert.deepEqual(await stored(other.organizationId), { plan: "free_trial", proposalsCreated: 0 });

  const view = await call(staffToken, "GET", `${PLANS}/${acme.organizationId}`);
  assert.deepEqual(view.body.data.history.map((h: any) => [h.fromPlan, h.toPlan, h.note, h.changedBy]), [
    ["free_trial", "full_access", "Launch customer", { id: String(dxg.staff), name: "Staff Agent" }],
  ]);

  // Setting the same plan again is a no-op with no second event.
  const again = await call(superToken, "PUT", `${PLANS}/${acme.organizationId}`, { plan: "full_access" });
  assert.equal(again.status, 200);
  assert.equal(again.body.data.changed, false);
  assert.equal((await planEvents(acme.organizationId)).length, 1);
});

test("a downgrade locks the features and the limit at once, keeps the RFPs and the count, and is audited", async () => {
  const owner = acme.members.owner.accessToken;
  const before = await Proposal.countDocuments({ organizationId: acme.organizationId });
  const lowered = await call(superToken, "PUT", `${PLANS}/${acme.organizationId}`, { plan: "free_trial" });
  assert.equal(lowered.status, 200, JSON.stringify(lowered.body));
  assert.deepEqual(lowered.body.data.organization.proposals, { created: 3, limit: 2, remaining: 0, canCreate: false });

  const refused = await createRfp(owner);
  assert.equal(refused.body.code, "PLAN_LIMIT_REACHED");
  assert.equal(refused.body.created, 3);
  assert.equal((await call(owner, "GET", "/api/vendor-responses/proposals")).body.code, "PLAN_FEATURE_LOCKED");
  assert.equal(await Proposal.countDocuments({ organizationId: acme.organizationId }), before);
  assert.equal((await call(owner, "GET", "/api/proposals")).status, 200);

  const events = await planEvents(acme.organizationId);
  assert.deepEqual(events.map((e) => [String(e.actorUserId), e.metadata.fromPlan, e.metadata.toPlan]), [
    [String(dxg.staff), "free_trial", "full_access"],
    [String(dxg.superAdmin), "full_access", "free_trial"],
  ]);
  assert.ok(!("note" in events[1].metadata));
});

test("trust boundary: no customer role, and no member holding a staff role, can read or change a plan", async () => {
  await Organization.updateOne({ _id: acme.organizationId }, { $set: { plan: "free_trial" } });
  const eventsBefore = (await planEvents(acme.organizationId)).length;
  for (const role of ROLES) {
    const token = acme.members[role].accessToken;
    for (const [method, path, body] of [
      ["GET", PLANS, undefined],
      ["GET", `${PLANS}/${acme.organizationId}`, undefined],
      ["PUT", `${PLANS}/${acme.organizationId}`, { plan: "full_access" }],
      ["PUT", `${PLANS}/${other.organizationId}`, { plan: "full_access" }],
    ] as const) {
      const res = await call(token, method, path, body);
      assert.equal(res.status, 403, `${role} ${method} ${path}`);
      assert.ok(!JSON.stringify(res.body).includes("Other Co"), `${role} ${method} ${path}`);
    }
  }
  // A `users` account with a staff membership role passes the route guard but isn't an admin-app account.
  for (const [method, path, body] of [["GET", PLANS, undefined], ["PUT", `${PLANS}/${acme.organizationId}`, { plan: "full_access" }], ["PUT", `${PLANS}/${dxg.org}`, { plan: "full_access" }]] as const) {
    const res = await call(impostorToken, method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.body.code, "PLAN_MANAGEMENT_FORBIDDEN");
  }
  assert.equal((await fetch(`${baseUrl}${PLANS}`)).status, 401);

  // The routes an Owner does have never raise the plan.
  const owner = acme.members.owner.accessToken;
  const profile = await call(owner, "PUT", "/api/organization/profile", { name: `Acme Events ${tag}`, plan: "full_access", proposalsCreated: 0 });
  assert.notEqual(profile.status, 500, JSON.stringify(profile.body));
  await Organization.updateOne({ _id: acme.organizationId }, { $set: { onboardingStep: "plan" } });
  assert.equal((await call(owner, "POST", "/api/organization/onboarding/plan", { plan: "full_access" })).status, 400);
  await Organization.updateOne({ _id: acme.organizationId }, { $set: { onboardingStep: "done" } });

  assert.deepEqual((await stored(acme.organizationId)).plan, "free_trial");
  assert.deepEqual((await stored(other.organizationId)).plan, "free_trial");
  assert.deepEqual((await stored(dxg.org)).plan, "free_trial");
  assert.equal((await planEvents(acme.organizationId)).length, eventsBefore);
});

test("a plan assigned by staff survives the Owner finishing onboarding", async () => {
  await Organization.updateOne({ _id: other.organizationId }, { $set: { onboardingStep: "plan" } });
  assert.equal((await call(staffToken, "PUT", `${PLANS}/${other.organizationId}`, { plan: "full_access" })).status, 200);
  const chosen = await call(other.members.owner.accessToken, "POST", "/api/organization/onboarding/plan", { plan: "free_trial" });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
  const row = await Organization.findById(other.organizationId).select("plan onboardingStep").lean();
  assert.deepEqual({ plan: row?.plan, onboardingStep: row?.onboardingStep }, { plan: "full_access", onboardingStep: "team" });
  await Organization.updateOne({ _id: other.organizationId }, { $set: { onboardingStep: "done", plan: "free_trial" } });
});

test("a missing organization, a malformed id and a legacy holding tenant answer the same 404; bad input is a 400", async () => {
  const missing = await call(staffToken, "PUT", `${PLANS}/${randomMongoId()}`, { plan: "full_access" });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "ORGANIZATION_NOT_FOUND");
  for (const id of ["not-an-id", String(holding)]) {
    assert.deepEqual((await call(staffToken, "PUT", `${PLANS}/${id}`, { plan: "full_access" })).body, missing.body, id);
    assert.equal((await call(staffToken, "GET", `${PLANS}/${id}`)).status, 404, id);
  }
  assert.deepEqual(await stored(holding), { plan: "free_trial", proposalsCreated: 0 });
  assert.equal((await planEvents(holding)).length, 0);

  for (const body of [{ plan: "enterprise" }, {}, { plan: { $ne: "free_trial" } }]) {
    const res = await call(staffToken, "PUT", `${PLANS}/${other.organizationId}`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, "INVALID_PLAN");
  }
  assert.equal((await call(staffToken, "PUT", `${PLANS}/${other.organizationId}`, { plan: "full_access", note: "x".repeat(501) })).body.code, "INVALID_PLAN_NOTE");
  assert.deepEqual((await stored(other.organizationId)).plan, "free_trial");
});

test("staff can raise their own organization, and an organization written before plans existed", async () => {
  const own = await call(staffToken, "PUT", `${PLANS}/${dxg.org}`, { plan: "full_access", note: "DXG's own organization" });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal((await stored(dxg.org)).plan, "full_access");
  assert.equal((await planEvents(dxg.org)).length, 1);

  await Organization.collection.updateOne({ _id: oid(other.organizationId) }, { $unset: { plan: "", proposalsCreated: "" } });
  const before = await call(staffToken, "GET", `${PLANS}/${other.organizationId}`);
  assert.deepEqual([before.body.data.organization.plan, before.body.data.organization.proposals.created], ["free_trial", 0]);
  const raised = await call(staffToken, "PUT", `${PLANS}/${other.organizationId}`, { plan: "full_access" });
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  assert.equal(raised.body.data.changed, true);
  assert.equal((await stored(other.organizationId)).plan, "full_access");
  const [event] = await planEvents(other.organizationId).then((events) => events.slice(-1));
  assert.deepEqual([event.metadata.fromPlan, event.metadata.toPlan], ["free_trial", "full_access"]);
});

test("two staff changing the same organization at once: one change, one event", async () => {
  await Organization.updateOne({ _id: other.organizationId }, { $set: { plan: "free_trial" } });
  const eventsBefore = (await planEvents(other.organizationId)).length;
  const results = await Promise.all([
    call(staffToken, "PUT", `${PLANS}/${other.organizationId}`, { plan: "full_access" }),
    call(superToken, "PUT", `${PLANS}/${other.organizationId}`, { plan: "full_access" }),
  ]);
  // The loser sees a conflict, a no-op, or (after a transaction retry) a refusal; never a second event.
  assert.ok(results.some((res) => res.status === 200 && res.body.data.changed === true), JSON.stringify(results.map((r) => r.body)));
  for (const res of results) assert.ok(res.status === 200 || res.status === 409, JSON.stringify(res.body));
  assert.equal((await stored(other.organizationId)).plan, "full_access");
  assert.equal((await planEvents(other.organizationId)).length, eventsBefore + 1);
});
