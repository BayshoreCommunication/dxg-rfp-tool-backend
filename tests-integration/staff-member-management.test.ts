// Owner decision 2026-11-24 (docs/DECISIONS.md): RFPilot staff (an `admins` account holding an
// admin role) VIEW a customer organization's members and change none of them. Through the real
// API on real MongoDB: two customer organizations (A and B), the staff organization and a legacy
// holding tenant.
// - The read of one member works and is recorded in the staff organization only.
// - The five staff member write routes are gone: 404 for everyone, nothing changed, nothing recorded.
// - A membership or session that still carries a marker of a staff change made before the
//   removal behaves as it did: the member's own requests write nothing in the customer organization.
// - The organization's own Owner reactivates a member staff had deactivated, through the customer route.
// - The customer's own member routes write the rows they always did.
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
import { STAFF_MEMBER_AUDIT } from "../src/modules/staffAccess/domain";
import { closePostgres } from "../config/postgres";
import { closeSecurityRateLimitRedis } from "../middleware/securityRateLimit";
import { closeSupportRedis } from "../src/modules/supportDesk/infrastructure/redis/supportRedis";
import { cleanupOrganizations, createProposals, ROLES, seedOrganization, type Fixture } from "./memberFixtures";

const tag = randomMongoId().slice(0, 10);
const oid = (value?: string) => new mongoose.Types.ObjectId(value);
const BASE = "/api/v1/admin/organizations";
const AUDIT_LOG = "/api/v1/organization/audit-events";
const REASON = `Customer asked on the phone, ticket ${tag}`; // a body the removed write routes took; also text that must never show to a customer
const STAFF_ACTIONS = Object.values(STAFF_MEMBER_AUDIT);
const CUSTOMER_MEMBER_ACTIONS = [
  "organization.member.role_changed", "organization.member.deactivated", "organization.member.reactivated",
  "organization.ownership.transferred", "proposal.owner.reassigned", "auth.sessions.revoked_others",
];
const MEMBER_KEYS = ["email", "joinedAt", "lastSignedInAt", "name", "roles", "status", "teams", "userId"];

let server: http.Server;
let baseUrl: string;
let a: Fixture;
let b: Fixture;
let aId: mongoose.Types.ObjectId;
let bId: mongoose.Types.ObjectId;
let staffToken: string;
let superToken: string;
let impostorToken: string;
let baseline: { a: number; b: number; staff: number };
let bBefore: string;
// Requests made as staff to the member routes: each must leave exactly one staff-side event.
let staffRequests = 0;
// RFPilot's own organization: two staff accounts and a `users` account holding a staff role.
const dxg = { org: oid(), staff: oid(), superAdmin: oid(), impostor: oid() };
const holding = { org: oid(), member: oid() };
const suspendedMember = oid();

const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
};
const asStaff = async (method: string, path: string, body?: unknown, token = staffToken) => {
  staffRequests += 1;
  const res = await call(token, method, path, body);
  assert.notEqual(res.status, 429, `rate limited: ${method} ${path}`);
  return res;
};
const sessionFor = async (userId: mongoose.Types.ObjectId, organizationId: mongoose.Types.ObjectId) =>
  (await beginAuthenticatedSession({ userId: String(userId), organizationId: String(organizationId), correlationId: randomMongoId() })).accessToken;
const eventCount = (organizationId: mongoose.Types.ObjectId) => SecurityAuditEvent.countDocuments({ organizationId });
const staffEvents = async (): Promise<Array<Record<string, any>>> =>
  SecurityAuditEvent.find({ organizationId: dxg.org, action: { $in: STAFF_ACTIONS } }).sort({ createdAt: 1, _id: 1 }).lean();
const lastStaffEvent = async () => (await staffEvents()).at(-1)!;
const membership = async (organizationId: mongoose.Types.ObjectId, userId: string | mongoose.Types.ObjectId) =>
  (await OrganizationMembership.findOne({ organizationId, userId: oid(String(userId)) }).lean()) as Record<string, any>;
const sessionStatus = async (sessionId: string) => (await RefreshSession.findOne({ sessionId }).lean())?.status;
const proposalOwners = async (organizationId: mongoose.Types.ObjectId) =>
  Object.fromEntries((await Proposal.collection.find({ organizationId }).toArray()).map((row) => [String(row._id), String(row.userId)]));
// Everything of B a staff action on A could wrongly touch.
const snapshotB = async () => JSON.stringify({
  members: (await OrganizationMembership.find({ organizationId: bId }).sort({ userId: 1 }).lean()).map((row: any) => [String(row.userId), row.roles, row.status, row.version, row.sessionRevocationPending ?? false]),
  proposals: await proposalOwners(bId),
  sessions: (await RefreshSession.find({ organizationId: bId }).sort({ sessionId: 1 }).lean()).map((row: any) => [row.sessionId, row.status]),
  events: await eventCount(bId),
});
const noNewCustomerRows = async (label: string) => {
  assert.equal(await eventCount(aId), baseline.a, `${label}: no audit row was written in A`);
  assert.equal(await eventCount(bId), baseline.b, `${label}: no audit row was written in B`);
  assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: { $in: [aId, bId] }, action: { $in: [...STAFF_ACTIONS, ...CUSTOMER_MEMBER_ACTIONS] } }), 0, label);
};
const member = (role: (typeof ROLES)[number]) => `${BASE}/${a.organizationId}/members/${a.members[role].userId}`;

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);

  a = await seedOrganization(`A Events ${tag}`);
  b = await seedOrganization(`B Company ${tag}`);
  aId = oid(a.organizationId);
  bId = oid(b.organizationId);
  await createProposals(a.organizationId, a.members.planner.userId, 3);
  await createProposals(b.organizationId, b.members.planner.userId, 2);
  await User.collection.insertOne({ _id: suspendedMember, organizationId: aId, name: "Gone Person", email: `a-gone-${tag}@example.com`, password: "not-a-real-hash", role: "customer", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: aId, userId: suspendedMember, roles: ["planner"], status: "suspended", version: 1, suspendedAt: new Date(), createdAt: new Date(), updatedAt: new Date() });

  await Organization.collection.insertOne({ _id: dxg.org, name: `RFPilot ${tag}`, slug: `intg-members-dxg-${tag}`, status: "active", kind: "customer", plan: "free_trial" });
  for (const [id, name, role] of [[dxg.staff, "Dana Staff", "admin"], [dxg.superAdmin, "Sam Super", "super_admin"]] as const) {
    await Admin.collection.insertOne({ _id: id, organizationId: dxg.org, name, email: `${role}-members-${tag}@example.com`, password: "not-a-real-hash", role, isBlocked: false });
    await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: id, roles: [role === "admin" ? "dxg_admin" : "super_admin"], status: "active", version: 1 });
  }
  // A `users` account that holds a staff membership role and an administrative account role.
  await User.collection.insertOne({ _id: dxg.impostor, organizationId: dxg.org, name: "Member With Staff Role", email: `impostor-members-${tag}@example.com`, password: "not-a-real-hash", role: "admin", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: dxg.impostor, roles: ["dxg_admin"], status: "active", version: 1 });
  // A legacy holding tenant with one member.
  await Organization.collection.insertOne({ _id: holding.org, name: `Holding ${tag}`, slug: `intg-members-holding-${tag}`, status: "active", kind: "legacy_holding", plan: "free_trial" });
  await User.collection.insertOne({ _id: holding.member, organizationId: holding.org, name: "Legacy Person", email: `legacy-${tag}@example.com`, password: "not-a-real-hash", role: "customer", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: holding.org, userId: holding.member, roles: ["planner"], status: "active", version: 1 });

  staffToken = await sessionFor(dxg.staff, dxg.org);
  superToken = await sessionFor(dxg.superAdmin, dxg.org);
  impostorToken = await sessionFor(dxg.impostor, dxg.org);

  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  baseline = { a: await eventCount(aId), b: await eventCount(bId), staff: await eventCount(dxg.org) };
  bBefore = await snapshotB();
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    const orgIds = [dxg.org, holding.org, ...(aId ? [aId] : []), ...(bId ? [bId] : [])];
    await mongoose.connection.db!.collection("securityauditevents").deleteMany({ organizationId: { $in: orgIds } });
    await OrganizationMembership.collection.deleteMany({ organizationId: { $in: [dxg.org, holding.org] } });
    await RefreshSession.deleteMany({ organizationId: dxg.org });
    await User.collection.deleteMany({ organizationId: { $in: [dxg.org, holding.org] } });
    await Admin.collection.deleteMany({ _id: { $in: [dxg.staff, dxg.superAdmin] } });
    await Organization.collection.deleteMany({ _id: { $in: [dxg.org, holding.org] } });
    await cleanupOrganizations();
  }
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
  await closeSupportRedis();
});

test("trust boundary: no customer role, no `users` account holding a staff role and no anonymous caller can read a member; nothing changes and nothing is recorded", async () => {
  const planner = a.members.planner.userId;
  const routes: Array<[string, string, unknown]> = [
    ["GET", member("planner"), undefined],
    ["GET", `${BASE}/${a.organizationId}/members/${suspendedMember}`, undefined],
  ];
  const before = JSON.stringify(await OrganizationMembership.find({ organizationId: aId }).sort({ userId: 1 }).select("userId roles status version").lean());
  for (const [method, path, body] of routes) {
    assert.equal((await call(null, method, path, body)).status, 401, `${method} ${path} anonymous`);
    for (const fixture of [a, b]) {
      for (const role of ROLES) {
        const res = await call(fixture.members[role].accessToken, method, path, body);
        assert.equal(res.status, 403, `${method} ${path} as ${role}: ${res.text}`);
        assert.equal(res.body.data, undefined);
      }
    }
    const impostor = await call(impostorToken, method, path, body);
    assert.equal(impostor.status, 403, `${method} ${path} as a users account with a staff role: ${impostor.text}`);
    assert.equal(impostor.body.code, "STAFF_ACCESS_FORBIDDEN");
  }
  assert.equal(JSON.stringify(await OrganizationMembership.find({ organizationId: aId }).sort({ userId: 1 }).select("userId roles status version").lean()), before);
  assert.deepEqual(Object.values(await proposalOwners(aId)), [planner, planner, planner]);
  assert.equal(await eventCount(dxg.org), baseline.staff, "a refused caller leaves no staff-side event either");
  await noNewCustomerRows("refused callers");
});

test("member read: one member of the path's organization with its version, through the members allowlist; another organization's member is 404", async () => {
  const res = await asStaff("GET", member("planner"));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.body.data).sort(), ["member", "organizationId", "version"]);
  assert.deepEqual(Object.keys(res.body.data.member).sort(), MEMBER_KEYS);
  assert.deepEqual([res.body.data.organizationId, res.body.data.member.userId, res.body.data.member.email, res.body.data.member.roles, res.body.data.version], [a.organizationId, a.members.planner.userId, a.members.planner.email, ["planner"], 1]);
  assert.equal(res.text.includes("not-a-real-hash"), false);
  const event = await lastStaffEvent();
  assert.deepEqual([event.action, event.decision, String(event.actorUserId), event.targetId, event.metadata.organizationId], [STAFF_MEMBER_AUDIT.read, "allowed", String(dxg.staff), a.members.planner.userId, a.organizationId]);

  const foreign = await asStaff("GET", `${BASE}/${a.organizationId}/members/${b.members.planner.userId}`);
  assert.deepEqual([foreign.status, foreign.body.code], [404, "MEMBER_NOT_FOUND"]);
  assert.equal(foreign.text.includes(b.members.planner.email), false);
  assert.deepEqual([(await lastStaffEvent()).decision, (await lastStaffEvent()).reason], ["denied", "member_not_found"]);
  for (const [path, code] of [[`${BASE}/${a.organizationId.toUpperCase()}/members/${a.members.planner.userId}`, "INVALID_ORGANIZATION_ID"], [`${BASE}/${a.organizationId}/members/not-an-id`, "INVALID_MEMBER_ID"]]) {
    const bad = await asStaff("GET", path);
    assert.deepEqual([bad.status, bad.body.code], [400, code]);
  }
  await noNewCustomerRows("member read");
});

test("the five staff member write routes are gone: 404 for a staff admin, a super admin and everyone else, with nothing changed and nothing recorded anywhere", async () => {
  const planner = a.members.planner.userId;
  const removed: Array<[string, string, unknown]> = [
    ["PATCH", `${member("planner")}/role`, { role: "organization_admin", version: 1, reason: REASON }],
    ["POST", `${member("planner")}/deactivate`, { version: 1, reason: REASON }],
    ["POST", `${BASE}/${a.organizationId}/members/${suspendedMember}/reactivate`, { version: 1, reason: REASON }],
    ["POST", `${member("planner")}/reassign-rfps`, { toUserId: a.members.team_manager.userId, reason: REASON }],
    ["POST", `${BASE}/${a.organizationId}/ownership/transfer`, { toUserId: planner, version: 1, reason: REASON }],
  ];
  const state = async () => JSON.stringify({
    members: await OrganizationMembership.find({ organizationId: aId }).sort({ userId: 1 }).select("userId roles status version sessionRevocationPending sessionRevocationStaff suspendedByStaff").lean(),
    proposals: await proposalOwners(aId),
    sessions: (await RefreshSession.find({ organizationId: aId }).sort({ sessionId: 1 }).lean()).map((row: any) => [row.sessionId, row.status, row.revokeReason ?? null]),
  });
  const before = await state();
  const staffRowsBefore = await eventCount(dxg.org);
  // The route does not exist, so the answer is the application's plain 404 for every caller: an
  // RFPilot admin, a super admin, an anonymous caller, the organization's own Owner and Admin, and
  // a `users` account holding a staff role. Nobody is told anything about the organization.
  const callers: Array<[string, string | null]> = [
    ["staff admin", staffToken], ["super admin", superToken], ["anonymous", null], ["A's Owner", a.members.owner.accessToken],
    ["A's Admin", a.members.organization_admin.accessToken], ["B's Owner", b.members.owner.accessToken], ["a users account with a staff role", impostorToken],
  ];
  for (const [method, path, body] of removed) {
    for (const [label, token] of callers) {
      const res = await call(token, method, path, body);
      assert.equal(res.status, 404, `${method} ${path} as ${label}: ${res.text}`);
      assert.deepEqual(res.body, { success: false, message: "Route not found" }, `${method} ${path} as ${label}`);
    }
    // Not a route under another method either.
    for (const other of ["GET", "PUT", "DELETE"]) assert.equal((await call(staffToken, other, path, body && other !== "GET" ? body : undefined)).status, 404, `${other} ${path}`);
  }
  assert.equal(await state(), before, "no member, proposal or session of A changed");
  assert.equal(await eventCount(dxg.org), staffRowsBefore, "nothing was recorded in the staff organization");
  assert.equal((await membership(aId, suspendedMember)).status, "suspended");
  assert.deepEqual(Object.values(await proposalOwners(aId)), [planner, planner, planner]);
  await noNewCustomerRows("removed routes");
  // The read beside them still answers.
  assert.equal((await asStaff("GET", member("planner"))).status, 200);
});

test("RFPilot's own organization and a legacy holding tenant are refused (409), an unknown organization is 404; none is changed", async () => {
  const cases: Array<[mongoose.Types.ObjectId, mongoose.Types.ObjectId, number, string, string | null]> = [
    [dxg.org, dxg.impostor, 409, "ORGANIZATION_NOT_MANAGEABLE", "platform"],
    [holding.org, holding.member, 409, "ORGANIZATION_NOT_MANAGEABLE", "legacy_holding"],
    [oid(), oid(a.members.planner.userId), 404, "ORGANIZATION_NOT_FOUND", null],
  ];
  for (const [organization, user, status, code, standing] of cases) {
    const requests: Array<[string, string, unknown]> = [["GET", `${BASE}/${organization}/members/${user}`, undefined]];
    for (const [method, path, body] of requests) {
      const res = await asStaff(method, path, body, superToken);
      assert.deepEqual([res.status, res.body.code], [status, code], `${method} ${path}: ${res.text}`);
      const event = await lastStaffEvent();
      assert.deepEqual([String(event.organizationId), event.decision, event.reason, event.metadata.organizationId, event.metadata.standing ?? null], [String(dxg.org), "denied", code.toLowerCase(), String(organization), standing]);
    }
  }
  for (const [organization, user] of [[dxg.org, dxg.impostor], [dxg.org, dxg.staff], [holding.org, holding.member]] as const) {
    const row = await membership(organization, user);
    assert.deepEqual([row.status, row.version], ["active", 1]);
  }
  assert.equal(await eventCount(holding.org), 0);
  await noNewCustomerRows("refused organizations");
});

test("audit: one event per staff request, all in the staff organization; A and B gained no row; no staff account was written into a customer organization", async () => {
  const events = await staffEvents();
  assert.equal(events.length, staffRequests, "exactly one event per request");
  assert.equal(await eventCount(dxg.org), baseline.staff + staffRequests, "and nothing else was written in the staff organization");
  for (const event of events) {
    assert.equal(String(event.organizationId), String(dxg.org));
    assert.ok([String(dxg.staff), String(dxg.superAdmin)].includes(String(event.actorUserId)));
    assert.equal(event.action, STAFF_MEMBER_AUDIT.read, "the read is the only staff member action written");
    assert.ok(["allowed", "denied"].includes(event.decision));
    assert.equal(event.targetType, "organization_membership");
    assert.equal(event.metadata.agentAccountType, "admin");
    assert.equal(typeof event.metadata.organizationId, "string");
    assert.equal(event.metadata.staffReason, undefined);
  }
  assert.ok(events.some((event) => event.decision === "allowed"), "a read that returned a member");
  assert.ok(events.some((event) => event.decision === "denied"), "a refused read");
  assert.equal(JSON.stringify(events).includes(REASON), false, "the body of a removed route was never read");
  await noNewCustomerRows("the whole run");
  assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: { $nin: [dxg.org] }, action: { $in: STAFF_ACTIONS } }), 0, "no staff member event outside the staff organization");
  assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: { $in: [aId, bId] }, actorUserId: { $in: [dxg.staff, dxg.superAdmin] } }), 0);
  assert.equal(await OrganizationMembership.countDocuments({ organizationId: { $in: [aId, bId, holding.org] }, userId: { $in: [dxg.staff, dxg.superAdmin] } }), 0);
});

test("A's customer audit endpoints (list, filters, CSV) show none of the staff actions, by default, by action, by category or by actor, even if such rows were stored in A", async () => {
  // Rows that the service never writes: the staff actions stored in A itself. Still never returned.
  const planted = await SecurityAuditEvent.insertMany(STAFF_ACTIONS.map((action) => ({
    organizationId: aId, actorUserId: dxg.staff, action, targetType: "organization_membership", targetId: a.members.planner.userId,
    decision: "allowed", reason: "role_changed", correlationId: randomMongoId(), metadata: { staffReason: `planted-${tag}`, role: "viewer", previousRole: "planner" },
  })));
  // The Admin of A was never touched by a staff action, so the session is intact.
  const admin = a.members.organization_admin.accessToken;
  const hiddenText = ["platform.", "organization_member.", `planted-${tag}`, REASON, String(dxg.staff), String(dxg.superAdmin), "Dana Staff", "Sam Super"];
  for (const query of ["?limit=100", "?category=members&limit=100", `?actor=${dxg.staff}`, `?actor=${dxg.superAdmin}`, "?actor=support"]) {
    const res = await call(admin, "GET", `${AUDIT_LOG}${query}`);
    assert.equal(res.status, 200, `${query}: ${res.text}`);
    for (const row of planted) assert.equal(res.text.includes(String(row._id)), false, `${query} returned ${row.action}`);
    for (const text of hiddenText) assert.equal(res.text.includes(text), false, `${query}: ${text}`);
    if (query.startsWith("?actor=")) assert.deepEqual(res.body.data.events, [], query);
    // Nothing a staff action would have written customer-side is there either.
    for (const event of res.body.data.events) assert.equal(CUSTOMER_MEMBER_ACTIONS.includes(event.action), false, `${query}: ${event.action}`);
  }
  for (const action of STAFF_ACTIONS) {
    const res = await call(admin, "GET", `${AUDIT_LOG}?action=${action}`);
    assert.deepEqual([res.status, res.body.code], [400, "AUDIT_FILTER_INVALID"], action);
  }
  // The export is limited to 20 per user per 15 minutes: five calls here.
  for (const query of ["", "?category=members", `?actor=${dxg.staff}`]) {
    const res = await call(admin, "GET", `${AUDIT_LOG}/export${query}`);
    assert.equal(res.status, 200, `export${query}: ${res.text.slice(0, 200)}`);
    for (const row of planted) assert.equal(res.text.includes(String(row._id)), false, `export${query} returned ${row.action}`);
    for (const text of hiddenText) assert.equal(res.text.includes(text), false, `export${query}: ${text}`);
    for (const action of CUSTOMER_MEMBER_ACTIONS) assert.equal(res.text.includes(action), false);
  }
  for (const action of [STAFF_MEMBER_AUDIT.roleChanged, STAFF_MEMBER_AUDIT.ownershipTransferred]) {
    const res = await call(admin, "GET", `${AUDIT_LOG}/export?action=${action}`);
    assert.equal(res.status, 400, action);
  }
  const filters = await call(admin, "GET", `${AUDIT_LOG}/filters`);
  assert.equal(filters.status, 200);
  for (const text of ["platform", "organization_member.", "RFPilot"]) assert.equal(filters.text.includes(text), false, text);
  // The log still works for A: the Admin's own sign-in is there.
  const own = await call(admin, "GET", `${AUDIT_LOG}?action=auth.session.created&actor=${a.members.organization_admin.userId}`);
  assert.equal(own.status, 200);
  assert.ok(own.body.data.events.length >= 1);
});

// ── Rows that still carry a marker of a staff change ─────────────────────────────────────────
// Staff changed members between 2026-11-18 and 2026-11-24. A staff demotion, deactivation or
// ownership transfer ended sessions and left markers: `sessionRevocationStaff` and
// `suspendedByStaff` on the membership, revoke reason `staff_membership_changed` on the session.
// No route writes them any more, but rows that carry them exist, and they must behave exactly as
// they did: when the member's browser comes back, nothing is written in the CUSTOMER
// organization. The test below plants each marker as the removed staff flow wrote it. A change
// made by a member of the organization still writes its usual rows (the control test).
const SESSION_TRACE_ACTIONS = ["auth.refresh.reuse_detected", "auth.sessions.revoked_others", "auth.sessions.revoked_all"];
const SESSION_TRACE_LABELS = ["Session reuse detected", "Other sessions signed out", "All sessions signed out"];
const STAFF_SESSIONS_REVOKED = "platform.organization_member.sessions_revoked";
const STAFF_REVOKE_REASON = "staff_membership_changed";
const MEMBERS_ROUTE = "/api/organization/members";
// The real refresh endpoint, with the refresh cookie a browser holds.
const refresh = async (refreshToken: string) => {
  const res = await fetch(`${baseUrl}/api/auth/refresh`, { method: "POST", headers: { cookie: `rfpilot_refresh=${encodeURIComponent(refreshToken)}` } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const refused = async (refreshToken: string, label: string) => {
  const res = await refresh(refreshToken);
  assert.deepEqual([res.status, res.body.code, res.body.reason], [401, "REFRESH_SESSION_EXPIRED", "reuse_detected"], label);
  assert.equal(res.body.accessToken, undefined, label);
};
const sessionRow = async (sessionId: string) => {
  const row = await RefreshSession.findOne({ sessionId }).lean();
  return [row?.status, row?.revokeReason ?? null];
};
// A second device for a member: another real session, started before the change under test.
const secondDevice = async (fixture: Fixture, role: (typeof ROLES)[number]) => {
  const session = await beginAuthenticatedSession({ userId: fixture.members[role].userId, organizationId: fixture.organizationId, correlationId: randomMongoId() });
  return { accessToken: session.accessToken, refreshToken: session.refreshToken, sessionId: session.sessionId };
};
// A revocation that did not run (the request died after the change committed): the session is live again.
const revive = (sessionId: string) => RefreshSession.updateOne({ sessionId }, { $set: { status: "active", revokedAt: null, revokeReason: null } });
const traceRows = async (organizationId: mongoose.Types.ObjectId): Promise<string[]> =>
  (await SecurityAuditEvent.find({ organizationId, action: { $in: SESSION_TRACE_ACTIONS } }).sort({ createdAt: 1, _id: 1 }).lean())
    .map((row: any) => `${row.action} ${row.reason} ${String(row.actorUserId)}`);
const auditView = async (token: string) => {
  const list = await call(token, "GET", `${AUDIT_LOG}?limit=100`);
  assert.equal(list.status, 200, list.text);
  const byAction: Record<string, number> = {};
  for (const action of SESSION_TRACE_ACTIONS) {
    const res = await call(token, "GET", `${AUDIT_LOG}?action=${action}&limit=100`);
    assert.equal(res.status, 200, `${action}: ${res.text}`);
    byAction[action] = res.body.data.events.length;
  }
  const signIn = await call(token, "GET", `${AUDIT_LOG}?category=sign_in&limit=100`);
  assert.equal(signIn.status, 200, signIn.text);
  // One export per call of this helper (the limit is 20 per user per 15 minutes; each user here makes at most two).
  const csv = await call(token, "GET", `${AUDIT_LOG}/export`);
  assert.equal(csv.status, 200, csv.text.slice(0, 200));
  return {
    ids: (list.body.data.events as Array<Record<string, any>>).map((event) => event.id).sort(),
    actions: (list.body.data.events as Array<Record<string, any>>).map((event) => event.action),
    signInIds: (signIn.body.data.events as Array<Record<string, any>>).map((event) => event.id).sort(),
    byAction, text: `${list.text}\n${signIn.text}`, csv: csv.text, csvLines: csv.text.trim().split("\n").length,
  };
};

test("existing staff markers behave as before: the member's real refresh and real requests are refused or kept as they were and leave NO row in the customer organization; the organization's own Owner then reactivates the member staff deactivated", async () => {
  const c = await seedOrganization(`C Traces ${tag}`);
  const cId = oid(c.organizationId);
  const staffCause = { organizationId: String(dxg.org), actorUserId: String(dxg.staff) };
  const plant = async (userId: string, update: Record<string, unknown>) => {
    const result = await OrganizationMembership.collection.updateOne({ organizationId: cId, userId: oid(userId) }, { $set: update });
    assert.equal(result.modifiedCount, 1, "the fixture membership was found and marked");
  };
  try {
    const plannerOther = await secondDevice(c, "planner");
    const before = await auditView(c.members.owner.accessToken);
    const rowsBefore = await eventCount(cId);
    const staffRevocationsBefore = await SecurityAuditEvent.countDocuments({ organizationId: dxg.org, action: STAFF_SESSIONS_REVOKED });
    assert.deepEqual(await traceRows(cId), []);

    // 1. A session staff ended (a demotion, before the removal): its own last refresh token comes back.
    const admin = c.members.organization_admin;
    await RefreshSession.updateOne({ sessionId: admin.sessionId }, { $set: { status: "revoked", revokedAt: new Date(), revokeReason: STAFF_REVOKE_REASON } });
    assert.deepEqual(await sessionRow(admin.sessionId), ["revoked", STAFF_REVOKE_REASON]);
    await refused(admin.refreshToken, "refresh of a session staff ended");
    await refused(admin.refreshToken, "refresh of a session staff ended, again");
    assert.equal(await eventCount(cId), rowsBefore, "a session staff ended");

    // 2. A pending flag staff set (a role change that was not a demotion): the member's next
    //    request ends their OTHER sessions, for the staff reason, and clears the flag and its marker.
    const planner = c.members.planner;
    await plant(planner.userId, { sessionRevocationPending: true, sessionRevocationClaim: null, sessionRevocationStaff: staffCause });
    assert.notEqual((await call(planner.accessToken, "GET", MEMBERS_ROUTE)).status, 401, "the requesting session is kept");
    assert.deepEqual([await sessionRow(planner.sessionId), await sessionRow(plannerOther.sessionId)], [["active", null], ["revoked", STAFF_REVOKE_REASON]]);
    let row = await membership(cId, planner.userId);
    assert.deepEqual([row.sessionRevocationPending, row.sessionRevocationStaff ?? null], [false, null], "the flag and its marker are cleared");
    await refused(plannerOther.refreshToken, "the other device's refresh");
    assert.equal(await eventCount(cId), rowsBefore, "a pending flag staff set");

    // 3. A member staff deactivated, whose sessions are still live (the revocation did not run).
    const viewer = c.members.viewer;
    await plant(viewer.userId, { status: "suspended", suspendedAt: new Date(), suspendedByStaff: staffCause, version: 2 });
    let inactive = await call(viewer.accessToken, "GET", MEMBERS_ROUTE);
    assert.deepEqual([inactive.status, inactive.body.code], [401, "MEMBERSHIP_INACTIVE"]);
    assert.deepEqual(await sessionRow(viewer.sessionId), ["revoked", STAFF_REVOKE_REASON]);
    await refused(viewer.refreshToken, "deactivated member's refresh after their own request");
    // ... and when the refresh comes first.
    await revive(viewer.sessionId);
    const refreshFirst = await refresh(viewer.refreshToken);
    assert.deepEqual([refreshFirst.status, refreshFirst.body.reason], [401, "membership_inactive"]);
    assert.deepEqual(await sessionRow(viewer.sessionId), ["revoked", STAFF_REVOKE_REASON]);
    await refused(viewer.refreshToken, "deactivated member's second refresh");
    inactive = await call(viewer.accessToken, "GET", MEMBERS_ROUTE);
    assert.deepEqual([inactive.status, inactive.body.code], [401, "MEMBERSHIP_INACTIVE"]);
    assert.equal(await eventCount(cId), rowsBefore, "a member staff deactivated");
    assert.deepEqual((await membership(cId, viewer.userId)).suspendedByStaff, staffCause, "reading the marker does not clear it");

    // The customer organization: not one new row, of any action.
    assert.equal(await eventCount(cId), rowsBefore, "the whole sequence");
    assert.deepEqual(await traceRows(cId), []);
    assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: cId, actorUserId: { $in: [dxg.staff, dxg.superAdmin] } }), 0);
    // Its audit list, filters and CSV, read by the Owner: exactly what the Owner saw before.
    const owner = c.members.owner;
    const after = await auditView(owner.accessToken);
    assert.deepEqual(after.ids, before.ids);
    assert.deepEqual(after.signInIds, before.signInIds);
    assert.deepEqual(after.byAction, { "auth.refresh.reuse_detected": 0, "auth.sessions.revoked_others": 0, "auth.sessions.revoked_all": 0 });
    assert.equal(after.csvLines, before.csvLines);
    for (const action of SESSION_TRACE_ACTIONS) assert.equal(after.actions.includes(action), false, action);
    for (const label of SESSION_TRACE_LABELS) assert.equal(after.csv.includes(label), false, `CSV: ${label}`);
    for (const hidden of [STAFF_REVOKE_REASON, "platform.", "organization_member.", String(dxg.staff)]) {
      assert.equal(after.text.includes(hidden), false, `list: ${hidden}`);
      assert.equal(after.csv.includes(hidden), false, `CSV: ${hidden}`);
    }
    const filters = await call(owner.accessToken, "GET", `${AUDIT_LOG}/filters`);
    assert.equal(filters.status, 200);
    for (const hidden of ["platform", "organization_member.", STAFF_REVOKE_REASON]) assert.equal(filters.text.includes(hidden), false, hidden);
    // No marker is in an answer of the customer's member list.
    const list = await call(owner.accessToken, "GET", MEMBERS_ROUTE);
    assert.equal(list.status, 200, list.text);
    for (const text of ["sessionRevocationStaff", "suspendedByStaff", STAFF_REVOKE_REASON, "sessionRevocationPending", String(dxg.staff), String(dxg.org)]) assert.equal(list.text.includes(text), false, text);

    // The staff organization holds the record of what the members' requests revoked.
    const revocations = (await SecurityAuditEvent.find({ organizationId: dxg.org, action: STAFF_SESSIONS_REVOKED, "metadata.organizationId": c.organizationId }).sort({ createdAt: 1, _id: 1 }).lean()) as Array<Record<string, any>>;
    assert.deepEqual(revocations.map((event) => [String(event.actorUserId), event.targetId, event.decision, event.reason, event.metadata.revokedCount, event.metadata.keptSession]), [
      [String(dxg.staff), planner.userId, "revoked", "membership_role_changed", 1, true],
      [String(dxg.staff), viewer.userId, "revoked", "membership_inactive", 1, false],
    ]);
    assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: dxg.org, action: STAFF_SESSIONS_REVOKED }), staffRevocationsBefore + 2);
    assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: { $ne: dxg.org }, action: STAFF_SESSIONS_REVOKED }), 0);

    // 4. Staff can no longer reactivate the member: the staff route is gone, and the member stays deactivated.
    const staffRowsBefore = await eventCount(dxg.org);
    const byStaff = await call(staffToken, "POST", `${BASE}/${c.organizationId}/members/${viewer.userId}/reactivate`, { version: 2, reason: REASON });
    assert.deepEqual([byStaff.status, byStaff.body], [404, { success: false, message: "Route not found" }]);
    row = await membership(cId, viewer.userId);
    assert.deepEqual([row.status, row.version, row.suspendedByStaff], ["suspended", 2, staffCause]);
    assert.equal(await eventCount(dxg.org), staffRowsBefore);
    // The staff read still shows the member, deactivated, with the version; no marker in the answer.
    const read = await asStaff("GET", `${BASE}/${c.organizationId}/members/${viewer.userId}`);
    assert.deepEqual([read.status, read.body.data.member.status, read.body.data.version], [200, "suspended", 2], read.text);
    for (const text of ["suspendedByStaff", "sessionRevocationStaff", String(dxg.staff)]) assert.equal(read.text.includes(text), false, text);

    // 5. The organization's own Owner reactivates the member through the customer route. The
    //    customer's list shows the member as deactivated with the version to send.
    const listed = (list.body.data.members as Array<Record<string, any>>).find((entry) => entry.userId === viewer.userId)!;
    assert.deepEqual([listed.status, listed.version], ["deactivated", 2]);
    const reactivated = await call(owner.accessToken, "POST", `${MEMBERS_ROUTE}/${viewer.userId}/reactivate`, { version: listed.version });
    assert.equal(reactivated.status, 200, reactivated.text);
    assert.deepEqual([reactivated.body.data.member.userId, reactivated.body.data.member.status, reactivated.body.data.member.version], [viewer.userId, "active", 3]);
    for (const text of ["suspendedByStaff", "sessionRevocationStaff", String(dxg.staff)]) assert.equal(reactivated.text.includes(text), false, text);
    row = await membership(cId, viewer.userId);
    assert.deepEqual([row.status, row.version, row.suspendedByStaff ?? null, row.suspendedAt ?? null], ["active", 3, null, null], "active again, and the staff marker went with the suspension");
    // It is the organization's own change: recorded in the organization, by the Owner, as always.
    const reactivations = (await SecurityAuditEvent.find({ organizationId: cId, action: "organization.member.reactivated" }).lean()) as Array<Record<string, any>>;
    assert.deepEqual(reactivations.map((event) => [String(event.actorUserId), event.targetId, event.decision]), [[owner.userId, viewer.userId, "allowed"]]);
    assert.equal(await eventCount(dxg.org), staffRowsBefore + 1, "the staff read above, and nothing for the customer's reactivation");
    // The member signs in again and works; the sessions staff ended stay ended.
    const again = await secondDevice(c, "viewer");
    assert.notEqual((await call(again.accessToken, "GET", MEMBERS_ROUTE)).status, 401, "the reactivated member's new session is accepted");
    assert.deepEqual([await sessionRow(again.sessionId), await sessionRow(viewer.sessionId)], [["active", null], ["revoked", STAFF_REVOKE_REASON]]);
    // From here the member is the organization's again: a deactivation by the Owner is the
    // customer's flow, with the customer's reason and the customer's rows.
    const deactivated = await call(owner.accessToken, "POST", `${MEMBERS_ROUTE}/${viewer.userId}/deactivate`, { version: 3 });
    assert.equal(deactivated.status, 200, deactivated.text);
    assert.equal((await membership(cId, viewer.userId)).suspendedByStaff ?? null, null);
    assert.deepEqual(await sessionRow(again.sessionId), ["revoked", "membership_deactivated"]);
    assert.deepEqual(await traceRows(cId), [`auth.sessions.revoked_others membership_deactivated ${owner.userId}`]);
    assert.equal(await OrganizationMembership.countDocuments({ organizationId: cId, $or: [{ sessionRevocationStaff: { $ne: null } }, { suspendedByStaff: { $ne: null } }] }), 0, "no marker is left in the organization");
  } finally {
    await SecurityAuditEvent.collection.deleteMany({ organizationId: cId });
  }
});

test("control: the same changes made by the organization's Owner through the customer routes still write the usual rows, and nothing on the staff side", async () => {
  const d = await seedOrganization(`D Control ${tag}`);
  const dId = oid(d.organizationId);
  const owner = d.members.owner;
  try {
    const plannerOther = await secondDevice(d, "planner");
    const managerOther = await secondDevice(d, "team_manager");
    const staffRowsBefore = await eventCount(dxg.org);
    assert.deepEqual(await traceRows(dId), []);

    // 1. Demotion by the Owner.
    const admin = d.members.organization_admin;
    const demoted = await call(owner.accessToken, "PATCH", `${MEMBERS_ROUTE}/${admin.userId}/role`, { role: "planner", version: 1 });
    assert.equal(demoted.status, 200, demoted.text);
    assert.deepEqual(await sessionRow(admin.sessionId), ["revoked", "membership_role_demoted"]);
    await refused(admin.refreshToken, "demoted member's refresh");

    // 2. A role change that is not a demotion.
    const planner = d.members.planner;
    const promoted = await call(owner.accessToken, "PATCH", `${MEMBERS_ROUTE}/${planner.userId}/role`, { role: "team_manager", version: 1 });
    assert.equal(promoted.status, 200, promoted.text);
    let row = await membership(dId, planner.userId);
    assert.deepEqual([row.sessionRevocationPending, row.sessionRevocationStaff ?? null], [true, null]);
    assert.notEqual((await call(planner.accessToken, "GET", MEMBERS_ROUTE)).status, 401);
    assert.deepEqual([await sessionRow(planner.sessionId), await sessionRow(plannerOther.sessionId)], [["active", null], ["revoked", "membership_role_changed"]]);
    await refused(plannerOther.refreshToken, "the other device's refresh");

    // 3. Deactivation, then the member's request with the revocation not having run.
    const viewer = d.members.viewer;
    const deactivated = await call(owner.accessToken, "POST", `${MEMBERS_ROUTE}/${viewer.userId}/deactivate`, { version: 1 });
    assert.equal(deactivated.status, 200, deactivated.text);
    assert.equal((await membership(dId, viewer.userId)).suspendedByStaff ?? null, null);
    assert.deepEqual(await sessionRow(viewer.sessionId), ["revoked", "membership_deactivated"]);
    await revive(viewer.sessionId);
    const inactive = await call(viewer.accessToken, "GET", MEMBERS_ROUTE);
    assert.deepEqual([inactive.status, inactive.body.code], [401, "MEMBERSHIP_INACTIVE"]);
    assert.deepEqual(await sessionRow(viewer.sessionId), ["revoked", "membership_inactive"]);
    await refused(viewer.refreshToken, "deactivated member's refresh");

    // 4. Ownership transfer by the Owner: the new Owner's next request ends their other sessions.
    const next = d.members.team_manager;
    const transferred = await call(owner.accessToken, "POST", "/api/organization/ownership/transfer", { toUserId: next.userId, version: 1 });
    assert.equal(transferred.status, 200, transferred.text);
    assert.equal((await call(next.accessToken, "GET", MEMBERS_ROUTE)).status, 200);
    assert.deepEqual([await sessionRow(next.sessionId), await sessionRow(managerOther.sessionId)], [["active", null], ["revoked", "membership_role_changed"]]);
    await refused(managerOther.refreshToken, "the new Owner's other device");

    // The usual rows, in the organization, in order.
    assert.deepEqual(await traceRows(dId), [
      `auth.sessions.revoked_others membership_role_demoted ${owner.userId}`,
      `auth.refresh.reuse_detected consumed_or_revoked_token_presented ${admin.userId}`,
      `auth.sessions.revoked_others membership_role_changed ${planner.userId}`,
      `auth.refresh.reuse_detected consumed_or_revoked_token_presented ${planner.userId}`,
      `auth.sessions.revoked_others membership_deactivated ${owner.userId}`,
      `auth.sessions.revoked_all membership_inactive ${viewer.userId}`,
      `auth.refresh.reuse_detected consumed_or_revoked_token_presented ${viewer.userId}`,
      `auth.sessions.revoked_others membership_role_changed ${next.userId}`,
      `auth.refresh.reuse_detected consumed_or_revoked_token_presented ${next.userId}`,
    ]);
    for (const action of ["organization.member.role_changed", "organization.member.deactivated", "organization.ownership.transferred"]) {
      assert.ok(await SecurityAuditEvent.countDocuments({ organizationId: dId, action }) >= 1, action);
    }
    // And the organization's audit list, filters and CSV show them (read by the previous Owner, now an Admin, whose session was kept).
    const view = await auditView(owner.accessToken);
    assert.deepEqual(view.byAction, { "auth.refresh.reuse_detected": 4, "auth.sessions.revoked_others": 4, "auth.sessions.revoked_all": 1 });
    for (const action of SESSION_TRACE_ACTIONS) assert.ok(view.actions.includes(action), action);
    for (const label of SESSION_TRACE_LABELS) assert.ok(view.csv.includes(label), `CSV: ${label}`);
    // No session ended for the staff reason, no staff marker, and nothing written on the staff side.
    assert.equal(await RefreshSession.countDocuments({ organizationId: dId, revokeReason: STAFF_REVOKE_REASON }), 0);
    assert.equal(await OrganizationMembership.countDocuments({ organizationId: dId, $or: [{ sessionRevocationStaff: { $ne: null } }, { suspendedByStaff: { $ne: null } }] }), 0);
    assert.equal(await eventCount(dxg.org), staffRowsBefore);
  } finally {
    await SecurityAuditEvent.collection.deleteMany({ organizationId: dId });
  }
});

test("nothing changed in B", async () => {
  assert.equal(await snapshotB(), bBefore);
  for (const role of ROLES) {
    const row = await membership(bId, b.members[role].userId);
    assert.deepEqual([row.roles, row.status, row.version], [[role], "active", 1], role);
    assert.equal(await sessionStatus(b.members[role].sessionId), "active", role);
  }
  assert.deepEqual(Object.values(await proposalOwners(bId)), [b.members.planner.userId, b.members.planner.userId]);
});
