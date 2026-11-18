// Owner decision 2026-11-18 (docs/DECISIONS.md): RFPilot staff (an `admins` account holding an
// admin role) manage a customer organization's members under the customer's own rules, and what
// they do is recorded on the RFPilot side only. Through the real API on real MongoDB: two
// customer organizations (A and B), the staff organization and a legacy holding tenant. Every
// action end to end in A; every event lands in the staff organization; A and B gain no audit
// row; A's own audit endpoints (list, filters, CSV) show none of it; nothing changes in B.
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
import { mongoMembershipStore, mongoRfpReassignmentStore } from "../src/modules/organizationMembers/infrastructure/mongoMembershipStore";
import { STAFF_MEMBER_AUDIT } from "../src/modules/staffAccess/domain";
import { closePostgres } from "../config/postgres";
import { closeSecurityRateLimitRedis } from "../middleware/securityRateLimit";
import { closeSupportRedis } from "../src/modules/supportDesk/infrastructure/redis/supportRedis";
import { cleanupOrganizations, createProposals, ROLES, seedOrganization, type Fixture } from "./memberFixtures";

const tag = randomMongoId().slice(0, 10);
const oid = (value?: string) => new mongoose.Types.ObjectId(value);
const BASE = "/api/v1/admin/organizations";
const AUDIT_LOG = "/api/v1/organization/audit-events";
const REASON = `Customer asked on the phone, ticket ${tag}`;
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
let aProposals: string[];
let bProposals: string[];
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
const ownersOf = async (organizationId: mongoose.Types.ObjectId) =>
  (await OrganizationMembership.find({ organizationId, roles: "owner" }).lean()).map((row) => String(row.userId));
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
  aProposals = await createProposals(a.organizationId, a.members.planner.userId, 3);
  bProposals = await createProposals(b.organizationId, b.members.planner.userId, 2);
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

test("trust boundary: no customer role, no `users` account holding a staff role and no anonymous caller can use any route; nothing changes and nothing is recorded", async () => {
  const planner = a.members.planner.userId;
  const routes: Array<[string, string, unknown]> = [
    ["GET", member("planner"), undefined],
    ["PATCH", `${member("planner")}/role`, { role: "organization_admin", version: 1, reason: REASON }],
    ["POST", `${member("planner")}/deactivate`, { version: 1, reason: REASON }],
    ["POST", `${BASE}/${a.organizationId}/members/${suspendedMember}/reactivate`, { version: 1, reason: REASON }],
    ["POST", `${member("planner")}/reassign-rfps`, { toUserId: a.members.team_manager.userId, reason: REASON }],
    ["POST", `${BASE}/${a.organizationId}/ownership/transfer`, { toUserId: planner, version: 1, reason: REASON }],
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

test("role change: applied under the customer's rules with one staff-side event; sessions end as in the customer flow; the Owner role is out of reach", async () => {
  const planner = a.members.planner;
  const promoted = await asStaff("PATCH", `${member("planner")}/role`, { role: "team_manager", version: 1, reason: `  ${REASON}  ` });
  assert.equal(promoted.status, 200, promoted.text);
  assert.deepEqual([promoted.body.data.changed, promoted.body.data.member.roles, promoted.body.data.version], [true, ["team_manager"], 2]);
  assert.deepEqual(Object.keys(promoted.body.data.member).sort(), MEMBER_KEYS);
  let row = await membership(aId, planner.userId);
  assert.deepEqual([row.roles, row.version, row.sessionRevocationPending], [["team_manager"], 2, true]);
  assert.equal(await sessionStatus(planner.sessionId), "active", "a promotion ends the other sessions on the member's next request");
  let event = await lastStaffEvent();
  assert.deepEqual([String(event.organizationId), event.action, event.decision, event.reason, event.targetType, event.targetId], [String(dxg.org), STAFF_MEMBER_AUDIT.roleChanged, "allowed", "role_changed", "organization_membership", planner.userId]);
  assert.deepEqual([event.metadata.organizationId, event.metadata.memberUserId, event.metadata.staffReason, event.metadata.before.role, event.metadata.after.role, event.metadata.agentAccountType], [a.organizationId, planner.userId, REASON, "planner", "team_manager", "admin"]);

  // A member who owns proposals can't become a Viewer.
  const viewer = await asStaff("PATCH", `${member("planner")}/role`, { role: "viewer", version: 2, reason: REASON });
  assert.deepEqual([viewer.status, viewer.body.code, viewer.body.ownedRfpCount], [409, "OWNER_HAS_RFPS", 3]);
  assert.match(viewer.body.message, /3 proposals/);
  // A demotion ends every session of the member at once.
  const demoted = await asStaff("PATCH", `${member("planner")}/role`, { role: "planner", version: 2, reason: REASON });
  assert.deepEqual([demoted.status, demoted.body.data.member.roles, demoted.body.data.version], [200, ["planner"], 3]);
  assert.equal(await sessionStatus(planner.sessionId), "revoked");
  // The same role again: nothing written to the member, one event.
  const same = await asStaff("PATCH", `${member("planner")}/role`, { role: "planner", version: 3, reason: REASON });
  assert.deepEqual([same.status, same.body.data.changed, same.body.data.version], [200, false, 3]);
  event = await lastStaffEvent();
  assert.deepEqual([event.decision, event.reason, event.metadata.changed], ["allowed", "role_unchanged", false]);

  const refusals: Array<[string, unknown, number, string]> = [
    [`${member("planner")}/role`, { role: "owner", version: 3, reason: REASON }, 409, "OWNERSHIP_TRANSFER_REQUIRED"],
    [`${member("owner")}/role`, { role: "organization_admin", version: 1, reason: REASON }, 409, "OWNERSHIP_TRANSFER_REQUIRED"],
    [`${member("planner")}/role`, { role: "viewer", version: 1, reason: REASON }, 409, "STALE_VERSION"],
    [`${member("planner")}/role`, { role: "dxg_admin", version: 3, reason: REASON }, 400, "INVALID_ROLE"],
    [`${member("planner")}/role`, { role: "viewer", reason: REASON }, 400, "VERSION_REQUIRED"],
    [`${member("planner")}/role`, { role: "viewer", version: 3 }, 400, "INVALID_REASON"],
    [`${member("planner")}/role`, { role: "viewer", version: 3, reason: "too short" }, 400, "INVALID_REASON"],
    [`${BASE}/${a.organizationId}/members/${b.members.planner.userId}/role`, { role: "viewer", version: 1, reason: REASON }, 404, "MEMBER_NOT_FOUND"],
  ];
  for (const [path, body, status, code] of refusals) {
    const res = await asStaff("PATCH", path, body, superToken);
    assert.deepEqual([res.status, res.body.code], [status, code], `${path} ${JSON.stringify(body)}: ${res.text}`);
    event = await lastStaffEvent();
    assert.deepEqual([String(event.organizationId), String(event.actorUserId), event.action, event.decision, event.reason], [String(dxg.org), String(dxg.superAdmin), STAFF_MEMBER_AUDIT.roleChanged, "denied", code.toLowerCase()]);
    if (code === "INVALID_REASON") assert.deepEqual(res.body.fields, { reason: "Give a reason of 10 to 500 characters." });
    if (code === "STALE_VERSION") assert.equal(res.body.currentVersion, 3);
  }
  row = await membership(aId, planner.userId);
  assert.deepEqual([row.roles, row.version], [["planner"], 3]);
  assert.deepEqual((await membership(aId, a.members.owner.userId)).roles, ["owner"]);
  assert.deepEqual((await membership(bId, b.members.planner.userId)).roles, ["planner"]);
  await noNewCustomerRows("role change");
});

test("deactivation needs the member's proposals reassigned first: inside the organization only, one staff-side event, no per-proposal customer event", async () => {
  const planner = a.members.planner;
  const reassign = `${member("planner")}/reassign-rfps`;
  const blocked = await asStaff("POST", `${member("planner")}/deactivate`, { version: 3, reason: REASON });
  assert.deepEqual([blocked.status, blocked.body.code, blocked.body.ownedRfpCount], [409, "OWNER_HAS_RFPS", 3]);
  assert.equal((await membership(aId, planner.userId)).status, "active");

  const refusals: Array<[unknown, number, string]> = [
    [{ toUserId: b.members.planner.userId, reason: REASON }, 404, "REASSIGN_TARGET_NOT_FOUND"],
    [{ toUserId: a.members.viewer.userId, reason: REASON }, 409, "REASSIGN_TARGET_INELIGIBLE"],
    [{ toUserId: String(suspendedMember), reason: REASON }, 409, "REASSIGN_TARGET_INELIGIBLE"],
    [{ toUserId: planner.userId, reason: REASON }, 400, "REASSIGN_TO_SELF"],
    [{ toUserId: a.members.organization_admin.userId, rfpIds: [bProposals[0]], reason: REASON }, 409, "RFPS_NOT_OWNED_BY_MEMBER"],
    [{ toUserId: a.members.organization_admin.userId, rfpIds: [], reason: REASON }, 400, "INVALID_RFP_SELECTION"],
    [{ toUserId: a.members.organization_admin.userId }, 400, "INVALID_REASON"],
  ];
  for (const [body, status, code] of refusals) {
    const res = await asStaff("POST", reassign, body);
    assert.deepEqual([res.status, res.body.code], [status, code], `${JSON.stringify(body)}: ${res.text}`);
    assert.doesNotMatch(res.body.message, /\bRFPs?\b/);
    assert.deepEqual([(await lastStaffEvent()).action, (await lastStaffEvent()).decision], [STAFF_MEMBER_AUDIT.proposalsReassigned, "denied"]);
  }
  const foreignMember = await asStaff("POST", `${BASE}/${a.organizationId}/members/${b.members.planner.userId}/reassign-rfps`, { toUserId: a.members.organization_admin.userId, reason: REASON });
  assert.deepEqual([foreignMember.status, foreignMember.body.code], [404, "MEMBER_NOT_FOUND"]);
  assert.deepEqual(Object.values(await proposalOwners(aId)), [planner.userId, planner.userId, planner.userId], "nothing moved by a refusal");

  const one = await asStaff("POST", reassign, { toUserId: a.members.organization_admin.userId, rfpIds: [aProposals[0]], reason: REASON });
  assert.equal(one.status, 200, one.text);
  assert.deepEqual(one.body.data, { organizationId: a.organizationId, reassignedCount: 1, rfpIds: [aProposals[0]] });
  const rest = await asStaff("POST", reassign, { toUserId: a.members.organization_admin.userId, reason: REASON });
  assert.equal(rest.status, 200, rest.text);
  assert.deepEqual([rest.body.data.reassignedCount, [...rest.body.data.rfpIds].sort()], [2, aProposals.slice(1).sort()]);
  const owners = await proposalOwners(aId);
  for (const id of aProposals) assert.equal(owners[id], a.members.organization_admin.userId);
  const event = await lastStaffEvent();
  assert.deepEqual([String(event.organizationId), event.action, event.decision, event.reason, event.targetId], [String(dxg.org), STAFF_MEMBER_AUDIT.proposalsReassigned, "allowed", "proposals_reassigned", planner.userId]);
  assert.deepEqual([event.metadata.organizationId, event.metadata.toUserId, event.metadata.reassignedCount, [...event.metadata.rfpIds].sort(), event.metadata.selection, event.metadata.staffReason],
    [a.organizationId, a.members.organization_admin.userId, 2, aProposals.slice(1).sort(), "all", REASON]);
  // The receiving member's membership is claimed, not changed: same version, same sessions.
  assert.equal((await membership(aId, a.members.organization_admin.userId)).version, 1);
  assert.equal(await sessionStatus(a.members.organization_admin.sessionId), "active");

  const done = await asStaff("POST", `${member("planner")}/deactivate`, { version: 3, reason: REASON });
  assert.deepEqual([done.status, done.body.data.changed, done.body.data.member.status, done.body.data.version], [200, true, "suspended", 4]);
  assert.equal((await membership(aId, planner.userId)).status, "suspended");
  const deactivated = await lastStaffEvent();
  assert.deepEqual([deactivated.action, deactivated.decision, deactivated.metadata.before.status, deactivated.metadata.after.status], [STAFF_MEMBER_AUDIT.deactivated, "allowed", "active", "suspended"]);

  // Deactivation ends every session of the member.
  assert.equal(await sessionStatus(a.members.viewer.sessionId), "active");
  const viewer = await asStaff("POST", `${member("viewer")}/deactivate`, { version: 1, reason: REASON });
  assert.equal(viewer.status, 200, viewer.text);
  assert.equal(await sessionStatus(a.members.viewer.sessionId), "revoked");

  // The Owner is never deactivated.
  const owner = await asStaff("POST", `${member("owner")}/deactivate`, { version: 1, reason: REASON });
  assert.deepEqual([owner.status, owner.body.code], [409, "LAST_OWNER"]);
  assert.equal((await membership(aId, a.members.owner.userId)).status, "active");
  assert.deepEqual(Object.values(await proposalOwners(bId)), [b.members.planner.userId, b.members.planner.userId]);
  await noNewCustomerRows("reassignment and deactivation");
});

test("reactivation: a deactivated member becomes active again; an active member is left as is", async () => {
  const again = await asStaff("POST", `${member("planner")}/reactivate`, { version: 4, reason: REASON });
  assert.deepEqual([again.status, again.body.data.changed, again.body.data.member.status, again.body.data.version], [200, true, "active", 5]);
  assert.equal((await membership(aId, a.members.planner.userId)).status, "active");
  const event = await lastStaffEvent();
  assert.deepEqual([event.action, event.decision, event.reason, event.metadata.before.status, event.metadata.after.status], [STAFF_MEMBER_AUDIT.reactivated, "allowed", "member_reactivated", "suspended", "active"]);
  const noop = await asStaff("POST", `${member("planner")}/reactivate`, { version: 5, reason: REASON });
  assert.deepEqual([noop.status, noop.body.data.changed, noop.body.data.version], [200, false, 5]);
  const stale = await asStaff("POST", `${BASE}/${a.organizationId}/members/${suspendedMember}/reactivate`, { version: 8, reason: REASON });
  assert.deepEqual([stale.status, stale.body.code, stale.body.currentVersion], [409, "STALE_VERSION", 1]);
  assert.equal((await membership(aId, suspendedMember)).status, "suspended");
  await noNewCustomerRows("reactivation");
});

test("ownership transfer: one step, the old Owner becomes an Admin, exactly one Owner afterwards; the Owner is otherwise untouchable", async () => {
  const transfer = `${BASE}/${a.organizationId}/ownership/transfer`;
  const oldOwner = a.members.owner;
  const next = a.members.team_manager;
  const refusals: Array<[unknown, number, string]> = [
    [{ toUserId: b.members.organization_admin.userId, version: 1, reason: REASON }, 404, "MEMBER_NOT_FOUND"],
    [{ toUserId: String(suspendedMember), version: 1, reason: REASON }, 409, "MEMBER_INACTIVE"],
    [{ toUserId: a.members.viewer.userId, version: 2, reason: REASON }, 409, "MEMBER_INACTIVE"],
    [{ toUserId: oldOwner.userId, version: 1, reason: REASON }, 400, "ALREADY_OWNER"],
    [{ toUserId: next.userId, version: 6, reason: REASON }, 409, "STALE_VERSION"],
    [{ toUserId: next.userId, reason: REASON }, 400, "VERSION_REQUIRED"],
    [{ toUserId: next.userId, version: 1 }, 400, "INVALID_REASON"],
    [{ version: 1, reason: REASON }, 400, "MEMBER_REQUIRED"],
  ];
  for (const [body, status, code] of refusals) {
    const res = await asStaff("POST", transfer, body, superToken);
    assert.deepEqual([res.status, res.body.code], [status, code], `${JSON.stringify(body)}: ${res.text}`);
    assert.deepEqual(await ownersOf(aId), [oldOwner.userId], code);
    assert.deepEqual([(await lastStaffEvent()).action, (await lastStaffEvent()).decision, (await lastStaffEvent()).reason], [STAFF_MEMBER_AUDIT.ownershipTransferred, "denied", code.toLowerCase()]);
  }
  assert.equal(await sessionStatus(oldOwner.sessionId), "active");

  const res = await asStaff("POST", transfer, { toUserId: next.userId, version: 1, reason: REASON });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.body.data).sort(), ["organizationId", "owner", "previousOwner"]);
  assert.deepEqual([res.body.data.owner.member.userId, res.body.data.owner.member.roles, res.body.data.owner.version], [next.userId, ["owner"], 2]);
  assert.deepEqual([res.body.data.previousOwner.member.userId, res.body.data.previousOwner.member.roles, res.body.data.previousOwner.version], [oldOwner.userId, ["organization_admin"], 2]);
  assert.deepEqual(await ownersOf(aId), [next.userId], "exactly one Owner");
  assert.deepEqual((await membership(aId, oldOwner.userId)).roles, ["organization_admin"]);
  assert.equal((await membership(aId, oldOwner.userId)).status, "active");
  // The previous Owner lost rights through someone else's action: signed out everywhere, now.
  assert.equal(await sessionStatus(oldOwner.sessionId), "revoked");
  assert.equal(await sessionStatus(next.sessionId), "active");
  assert.equal((await membership(aId, next.userId)).sessionRevocationPending, true);
  const event = await lastStaffEvent();
  assert.deepEqual([String(event.organizationId), String(event.actorUserId), event.action, event.decision, event.reason, event.targetId], [String(dxg.org), String(dxg.staff), STAFF_MEMBER_AUDIT.ownershipTransferred, "allowed", "ownership_transferred", next.userId]);
  assert.deepEqual([event.metadata.organizationId, event.metadata.previousOwnerUserId, event.metadata.before, event.metadata.after, event.metadata.staffReason], [
    a.organizationId, oldOwner.userId,
    { ownerUserId: oldOwner.userId, newOwnerRole: "team_manager", previousOwnerRole: "owner" },
    { ownerUserId: next.userId, newOwnerRole: "owner", previousOwnerRole: "organization_admin" }, REASON,
  ]);
  // No staff account became a member of A, and none holds a role in it.
  assert.equal(await OrganizationMembership.countDocuments({ organizationId: aId, userId: { $in: [dxg.staff, dxg.superAdmin] } }), 0);
  assert.equal(await OrganizationMembership.countDocuments({ organizationId: aId }), ROLES.length + 1);

  // The new Owner is as protected as the old one was.
  const demote = await asStaff("PATCH", `${member("team_manager")}/role`, { role: "planner", version: 2, reason: REASON });
  assert.deepEqual([demote.status, demote.body.code], [409, "OWNERSHIP_TRANSFER_REQUIRED"]);
  const deactivate = await asStaff("POST", `${member("team_manager")}/deactivate`, { version: 2, reason: REASON });
  assert.deepEqual([deactivate.status, deactivate.body.code], [409, "LAST_OWNER"]);
  assert.deepEqual(await ownersOf(aId), [next.userId]);
  assert.deepEqual(await ownersOf(bId), [b.members.owner.userId]);
  await noNewCustomerRows("ownership transfer");
});

test("RFPilot's own organization and a legacy holding tenant are refused (409), an unknown organization is 404; none is changed", async () => {
  const cases: Array<[mongoose.Types.ObjectId, mongoose.Types.ObjectId, number, string, string | null]> = [
    [dxg.org, dxg.impostor, 409, "ORGANIZATION_NOT_MANAGEABLE", "platform"],
    [holding.org, holding.member, 409, "ORGANIZATION_NOT_MANAGEABLE", "legacy_holding"],
    [oid(), oid(a.members.planner.userId), 404, "ORGANIZATION_NOT_FOUND", null],
  ];
  for (const [organization, user, status, code, standing] of cases) {
    const requests: Array<[string, string, unknown]> = [
      ["GET", `${BASE}/${organization}/members/${user}`, undefined],
      ["PATCH", `${BASE}/${organization}/members/${user}/role`, { role: "viewer", version: 1, reason: REASON }],
      ["POST", `${BASE}/${organization}/members/${user}/deactivate`, { version: 1, reason: REASON }],
      ["POST", `${BASE}/${organization}/ownership/transfer`, { toUserId: String(user), version: 1, reason: REASON }],
    ];
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

test("the change and its audit event commit together: when the event cannot be written, nothing is applied", async () => {
  // An event the audit collection refuses (no action), handed to each store write.
  const audit = { organizationId: String(dxg.org), actorUserId: String(dxg.staff), action: "", targetType: "organization_membership", targetId: a.members.planner.userId, reason: "x", correlationId: randomMongoId(), metadata: { agentAccountType: "admin", organizationId: a.organizationId } };
  const organizationId = a.organizationId;
  const admin = a.members.organization_admin.userId;
  const planner = a.members.planner.userId;
  const staffBefore = await eventCount(dxg.org);
  const membersBefore = JSON.stringify(await OrganizationMembership.find({ organizationId: aId }).sort({ userId: 1 }).select("userId roles status version").lean());
  const proposalsBefore = JSON.stringify(await proposalOwners(aId));
  await assert.rejects(mongoMembershipStore.setRoles({ organizationId, userId: planner, expectedVersion: 5, roles: ["team_manager"], audit }), /action/);
  await assert.rejects(mongoMembershipStore.setRoles({ organizationId, userId: planner, expectedVersion: 5, roles: ["viewer"], audit }), /action/);
  await assert.rejects(mongoMembershipStore.deactivate({ organizationId, userId: planner, expectedVersion: 5, now: new Date(), audit }), /action/);
  await assert.rejects(mongoMembershipStore.reactivate({ organizationId, userId: String(suspendedMember), expectedVersion: 1, audit }), /action/);
  await assert.rejects(mongoMembershipStore.transferOwnership({ organizationId, fromUserId: a.members.team_manager.userId, toUserId: admin, expectedTargetVersion: 1, audit }), /action/);
  await assert.rejects(mongoRfpReassignmentStore.reassign({ organizationId, fromUserId: admin, toUserId: planner, rfpIds: null, audit }), /action/);
  assert.equal(JSON.stringify(await OrganizationMembership.find({ organizationId: aId }).sort({ userId: 1 }).select("userId roles status version").lean()), membersBefore);
  assert.equal(JSON.stringify(await proposalOwners(aId)), proposalsBefore);
  assert.equal(await eventCount(dxg.org), staffBefore);
  // And with a writable event, the store puts it in the event's organization, not the member's.
  const written = await mongoMembershipStore.setRoles({ organizationId, userId: planner, expectedVersion: 5, roles: ["team_manager"], audit: { ...audit, action: STAFF_MEMBER_AUDIT.roleChanged, reason: "role_changed" } });
  assert.notEqual(written, "stale");
  staffRequests += 1; // one more staff-side event, written by this direct store call
  assert.equal(await eventCount(dxg.org), staffBefore + 1);
  await noNewCustomerRows("atomic audit");
});

test("audit: one event per staff request, all in the staff organization; A and B gained no row; no staff account was written into a customer organization", async () => {
  const events = await staffEvents();
  assert.equal(events.length, staffRequests, "exactly one event per request");
  assert.equal(await eventCount(dxg.org), baseline.staff + staffRequests, "and nothing else was written in the staff organization");
  for (const event of events) {
    assert.equal(String(event.organizationId), String(dxg.org));
    assert.ok([String(dxg.staff), String(dxg.superAdmin)].includes(String(event.actorUserId)));
    assert.match(event.action, /^platform\.organization_member\./);
    assert.ok(["allowed", "denied"].includes(event.decision));
    assert.equal(event.targetType, "organization_membership");
    assert.equal(event.metadata.agentAccountType, "admin");
    assert.equal(typeof event.metadata.organizationId, "string");
    if (event.metadata.staffReason !== undefined) assert.equal(event.metadata.staffReason, REASON);
  }
  for (const action of STAFF_ACTIONS) assert.ok(events.some((event) => event.action === action && event.decision === "allowed"), `${action} allowed`);
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

test("nothing changed in B", async () => {
  assert.equal(await snapshotB(), bBefore);
  for (const role of ROLES) {
    const row = await membership(bId, b.members[role].userId);
    assert.deepEqual([row.roles, row.status, row.version], [[role], "active", 1], role);
    assert.equal(await sessionStatus(b.members[role].sessionId), "active", role);
  }
  assert.deepEqual(Object.values(await proposalOwners(bId)), [b.members.planner.userId, b.members.planner.userId]);
});
