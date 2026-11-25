// Owner decision 2026-11-24 (docs/DECISIONS.md): RFPilot staff (an `admins` account holding an
// admin role) VIEW a customer organization's teams and change none of them. The sibling of
// staff-member-management.test.ts. Through the real API on real MongoDB: two customer
// organizations (A and B), the staff organization and a legacy holding tenant.
// - The read of one team works and is recorded in the staff organization only.
// - The seven staff team write routes are gone: 404 for everyone, nothing changed, nothing recorded.
// - A's own audit endpoints (list, filters, CSV) never show a staff team action, even a stored one.
// - The organization's own Admin still changes teams through the customer routes, with the usual rows.
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
import Team from "../modal/teamModel";
import TeamMembership from "../modal/teamMembershipModel";
import User from "../modal/userModel";
import { beginAuthenticatedSession } from "../src/modules/auth/composition";
import { STAFF_MEMBER_AUDIT, STAFF_TEAM_AUDIT } from "../src/modules/staffAccess/domain";
import { closePostgres } from "../config/postgres";
import { closeSecurityRateLimitRedis } from "../middleware/securityRateLimit";
import { closeSupportRedis } from "../src/modules/supportDesk/infrastructure/redis/supportRedis";
import { cleanupOrganizations, ROLES, seedOrganization, type Fixture } from "./memberFixtures";

const tag = randomMongoId().slice(0, 10);
const oid = (value?: string) => new mongoose.Types.ObjectId(value);
const BASE = "/api/v1/admin/organizations";
const AUDIT_LOG = "/api/v1/organization/audit-events";
const REASON = `Customer asked on the phone, ticket ${tag}`; // a body the removed write routes took; also text that must never show to a customer
const STAFF_ACTIONS: string[] = Object.values(STAFF_TEAM_AUDIT);
const CUSTOMER_TEAM_ACTIONS = ["team.created", "team.renamed", "team.archived", "team.member_added", "team.member_removed", "team.manager_changed", "organization.member.teams_changed"];
const MEMBER_KEYS = ["email", "joinedAt", "lastSignedInAt", "name", "roles", "status", "teams", "userId"];
const TEAM_KEYS = ["archived", "archivedAt", "createdAt", "id", "managers", "memberCount", "name"];

let server: http.Server;
let baseUrl: string;
let a: Fixture;
let b: Fixture;
let aId: mongoose.Types.ObjectId;
let bId: mongoose.Types.ObjectId;
let staffTokens: string[];
let impostorToken: string;
let baseline: { a: number; b: number; staff: number };
let bBefore: string;
// Requests made as staff to the team routes: each must leave exactly one staff-side event.
let staffRequests = 0;
// RFPilot's own organization: four staff accounts (admins and super admins in turn) and a `users` account holding a staff role.
const dxg = { org: oid(), staff: [oid(), oid(), oid(), oid()], impostor: oid(), team: oid() };
const holding = { org: oid(), member: oid(), team: oid() };
// Teams seeded directly: two in A, one in B.
const teams = { aWest: oid(), aOld: oid(), bNorth: oid() };

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
// As one of the staff accounts, in turn.
const asStaff = async (method: string, path: string, body?: unknown) => {
  const token = staffTokens[staffRequests % staffTokens.length];
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
const teamDoc = async (teamId: string | mongoose.Types.ObjectId) => (await Team.collection.findOne({ _id: oid(String(teamId)) })) as Record<string, any> | null;
const teamRows = async (organizationId: mongoose.Types.ObjectId) =>
  (await Team.collection.find({ organizationId }).sort({ _id: 1 }).toArray()).map((row) => [String(row._id), row.name, row.archived, row.createdBy ? String(row.createdBy) : null]);
const teamMemberRows = async (organizationId: mongoose.Types.ObjectId, teamId?: string | mongoose.Types.ObjectId) =>
  (await TeamMembership.collection.find({ organizationId, ...(teamId ? { teamId: oid(String(teamId)) } : {}) }).sort({ teamId: 1, userId: 1 }).toArray())
    .map((row) => [String(row.teamId), String(row.userId), row.isManager]);
// Everything of an organization a staff team action could touch.
const snapshot = async (organizationId: mongoose.Types.ObjectId) => JSON.stringify({
  teams: (await Team.collection.find({ organizationId }).sort({ _id: 1 }).toArray()).map((row) => [String(row._id), row.name, row.archived, row.archivedAt ?? null, row.updatedAt ?? null]),
  teamMembers: await teamMemberRows(organizationId),
  members: (await OrganizationMembership.find({ organizationId }).sort({ userId: 1 }).lean()).map((row: any) => [String(row.userId), row.roles, row.status, row.version, row.sessionRevocationPending ?? false]),
  proposals: (await Proposal.collection.find({ organizationId }).sort({ _id: 1 }).toArray()).map((row) => JSON.stringify(row)),
  sessions: (await RefreshSession.find({ organizationId }).sort({ sessionId: 1 }).lean()).map((row: any) => [row.sessionId, row.status]),
  events: await eventCount(organizationId),
});
const noNewCustomerRows = async (label: string) => {
  assert.equal(await eventCount(aId), baseline.a, `${label}: no audit row was written in A`);
  assert.equal(await eventCount(bId), baseline.b, `${label}: no audit row was written in B`);
  assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: { $in: [aId, bId] }, action: { $in: [...STAFF_ACTIONS, ...CUSTOMER_TEAM_ACTIONS] } }), 0, label);
};
const org = () => `${BASE}/${a.organizationId}`;
const team = (teamId: string | mongoose.Types.ObjectId) => `${org()}/teams/${teamId}`;
const staffIds = () => dxg.staff.map(String);

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);

  a = await seedOrganization(`A Events ${tag}`);
  b = await seedOrganization(`B Company ${tag}`);
  aId = oid(a.organizationId);
  bId = oid(b.organizationId);
  const now = new Date();
  await Team.collection.insertMany([
    { _id: teams.aWest, organizationId: aId, name: "West", archived: false, archivedAt: null, createdBy: oid(a.members.owner.userId), createdAt: now, updatedAt: now },
    { _id: teams.aOld, organizationId: aId, name: "Old", archived: true, archivedAt: now, createdBy: oid(a.members.owner.userId), createdAt: now, updatedAt: now },
    { _id: teams.bNorth, organizationId: bId, name: "North", archived: false, archivedAt: null, createdBy: oid(b.members.owner.userId), createdAt: now, updatedAt: now },
    { _id: dxg.team, organizationId: dxg.org, name: "Staff team", archived: false, archivedAt: null, createdBy: null, createdAt: now, updatedAt: now },
    { _id: holding.team, organizationId: holding.org, name: "Holding team", archived: false, archivedAt: null, createdBy: null, createdAt: now, updatedAt: now },
  ]);
  await TeamMembership.collection.insertMany([
    { organizationId: aId, teamId: teams.aWest, userId: oid(a.members.planner.userId), isManager: false, createdAt: now, updatedAt: now },
    { organizationId: aId, teamId: teams.aOld, userId: oid(a.members.planner.userId), isManager: false, createdAt: now, updatedAt: now },
    { organizationId: bId, teamId: teams.bNorth, userId: oid(b.members.planner.userId), isManager: false, createdAt: now, updatedAt: now },
    { organizationId: bId, teamId: teams.bNorth, userId: oid(b.members.team_manager.userId), isManager: true, createdAt: now, updatedAt: now },
  ]);

  await Organization.collection.insertOne({ _id: dxg.org, name: `RFPilot ${tag}`, slug: `intg-teams-dxg-${tag}`, status: "active", kind: "customer", plan: "free_trial" });
  for (const [index, id] of dxg.staff.entries()) {
    const role = index % 2 === 0 ? "admin" : "super_admin";
    await Admin.collection.insertOne({ _id: id, organizationId: dxg.org, name: `Staff Person ${index}`, email: `staff${index}-teams-${tag}@example.com`, password: "not-a-real-hash", role, isBlocked: false });
    await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: id, roles: [role === "admin" ? "dxg_admin" : "super_admin"], status: "active", version: 1 });
  }
  // A `users` account that holds a staff membership role and an administrative account role.
  await User.collection.insertOne({ _id: dxg.impostor, organizationId: dxg.org, name: "Member With Staff Role", email: `impostor-teams-${tag}@example.com`, password: "not-a-real-hash", role: "admin", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: dxg.impostor, roles: ["dxg_admin"], status: "active", version: 1 });
  // A legacy holding tenant with one member and one team.
  await Organization.collection.insertOne({ _id: holding.org, name: `Holding ${tag}`, slug: `intg-teams-holding-${tag}`, status: "active", kind: "legacy_holding", plan: "free_trial" });
  await User.collection.insertOne({ _id: holding.member, organizationId: holding.org, name: "Legacy Person", email: `legacy-teams-${tag}@example.com`, password: "not-a-real-hash", role: "customer", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: holding.org, userId: holding.member, roles: ["planner"], status: "active", version: 1 });

  staffTokens = [];
  for (const id of dxg.staff) staffTokens.push(await sessionFor(id, dxg.org));
  impostorToken = await sessionFor(dxg.impostor, dxg.org);

  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  baseline = { a: await eventCount(aId), b: await eventCount(bId), staff: await eventCount(dxg.org) };
  bBefore = await snapshot(bId);
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    const orgIds = [dxg.org, holding.org, ...(aId ? [aId] : []), ...(bId ? [bId] : [])];
    await mongoose.connection.db!.collection("securityauditevents").deleteMany({ organizationId: { $in: orgIds } });
    await OrganizationMembership.collection.deleteMany({ organizationId: { $in: [dxg.org, holding.org] } });
    await Team.collection.deleteMany({ organizationId: { $in: [dxg.org, holding.org] } });
    await TeamMembership.collection.deleteMany({ organizationId: { $in: [dxg.org, holding.org] } });
    await RefreshSession.deleteMany({ organizationId: dxg.org });
    await User.collection.deleteMany({ organizationId: { $in: [dxg.org, holding.org] } });
    await Admin.collection.deleteMany({ _id: { $in: dxg.staff } });
    await Organization.collection.deleteMany({ _id: { $in: [dxg.org, holding.org] } });
    await cleanupOrganizations();
  }
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
  await closeSupportRedis();
});

test("trust boundary: no customer role, no `users` account holding a staff role and no anonymous caller can read a team; nothing changes and nothing is recorded", async () => {
  const routes: Array<[string, string, unknown]> = [
    ["GET", team(teams.aWest), undefined],
    ["GET", team(teams.aOld), undefined],
  ];
  const beforeA = await snapshot(aId);
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
  assert.equal(await snapshot(aId), beforeA);
  assert.equal(await eventCount(dxg.org), baseline.staff, "a refused caller leaves no staff-side event either");
  await noNewCustomerRows("refused callers");
});

test("team read: the team of the path's organization with its members and their versions, through the staff allowlists; another organization's team is 404", async () => {
  const res = await asStaff("GET", team(teams.aWest));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.body.data).sort(), ["members", "organizationId", "team"]);
  assert.deepEqual(Object.keys(res.body.data.team).sort(), TEAM_KEYS);
  assert.deepEqual([res.body.data.organizationId, res.body.data.team.id, res.body.data.team.name, res.body.data.team.archived, res.body.data.team.memberCount, res.body.data.team.managers], [a.organizationId, String(teams.aWest), "West", false, 1, []]);
  assert.equal(res.body.data.members.length, 1);
  assert.deepEqual(Object.keys(res.body.data.members[0]).sort(), ["isManager", "member", "version"]);
  assert.deepEqual(Object.keys(res.body.data.members[0].member).sort(), MEMBER_KEYS);
  assert.deepEqual([res.body.data.members[0].member.userId, res.body.data.members[0].member.email, res.body.data.members[0].version, res.body.data.members[0].isManager], [a.members.planner.userId, a.members.planner.email, 1, false]);
  for (const hidden of ["not-a-real-hash", "createdBy", "password", a.members.owner.userId]) assert.equal(res.text.includes(hidden), false, hidden);
  const event = await lastStaffEvent();
  assert.deepEqual([String(event.organizationId), event.action, event.decision, event.reason, event.targetType, event.targetId, event.metadata.organizationId, event.metadata.teamId], [String(dxg.org), STAFF_TEAM_AUDIT.read, "allowed", "team", "team", String(teams.aWest), a.organizationId, String(teams.aWest)]);
  assert.ok(staffIds().includes(String(event.actorUserId)));

  const foreign = await asStaff("GET", team(teams.bNorth));
  assert.deepEqual([foreign.status, foreign.body.code], [404, "TEAM_NOT_FOUND"]);
  for (const hidden of ["North", b.members.planner.email, b.members.planner.userId]) assert.equal(foreign.text.includes(hidden), false, hidden);
  assert.deepEqual([(await lastStaffEvent()).decision, (await lastStaffEvent()).reason], ["denied", "team_not_found"]);
  const missing = await asStaff("GET", team(oid()));
  assert.deepEqual([missing.status, missing.body.code, missing.body.message], [404, "TEAM_NOT_FOUND", foreign.body.message]);
  for (const [path, code] of [[`${BASE}/${a.organizationId.toUpperCase()}/teams/${teams.aWest}`, "INVALID_ORGANIZATION_ID"], [`${org()}/teams/not-an-id`, "INVALID_TEAM_ID"], [`${org()}/teams/${String(teams.aWest).toUpperCase()}`, "INVALID_TEAM_ID"]]) {
    const bad = await asStaff("GET", path);
    assert.deepEqual([bad.status, bad.body.code], [400, code]);
  }
  await noNewCustomerRows("team read");
});

test("the seven staff team write routes are gone: 404 for a staff admin, a super admin and everyone else, with nothing changed and nothing recorded anywhere", async () => {
  const planner = a.members.planner.userId;
  const removed: Array<[string, string, unknown]> = [
    ["POST", `${org()}/teams`, { name: "Intruder", reason: REASON }],
    ["PATCH", team(teams.aWest), { name: "Intruder", reason: REASON }],
    ["POST", `${team(teams.aWest)}/archive`, { reason: REASON }],
    ["POST", `${team(teams.aWest)}/members`, { userId: a.members.viewer.userId, reason: REASON }],
    ["PATCH", `${team(teams.aWest)}/members/${planner}`, { isManager: true, reason: REASON }],
    ["DELETE", `${team(teams.aWest)}/members/${planner}`, { reason: REASON }],
    ["PUT", `${org()}/members/${planner}/teams`, { teamIds: [], version: 1, reason: REASON }],
  ];
  const beforeA = await snapshot(aId);
  const staffRowsBefore = await eventCount(dxg.org);
  // The route does not exist, so the answer is the application's plain 404 for every caller: an
  // RFPilot admin (staffTokens[0]), a super admin (staffTokens[1]), an anonymous caller, the
  // organization's own Owner and Admin, and a `users` account holding a staff role.
  const callers: Array<[string, string | null]> = [
    ["staff admin", staffTokens[0]], ["super admin", staffTokens[1]], ["anonymous", null], ["A's Owner", a.members.owner.accessToken],
    ["A's Admin", a.members.organization_admin.accessToken], ["B's Owner", b.members.owner.accessToken], ["a users account with a staff role", impostorToken],
  ];
  for (const [method, path, body] of removed) {
    for (const [label, token] of callers) {
      const res = await call(token, method, path, body);
      assert.equal(res.status, 404, `${method} ${path} as ${label}: ${res.text}`);
      assert.deepEqual(res.body, { success: false, message: "Route not found" }, `${method} ${path} as ${label}`);
    }
  }
  assert.equal(await snapshot(aId), beforeA, "no team, team member, member, proposal or session of A changed");
  assert.deepEqual(await teamRows(aId), [[String(teams.aWest), "West", false, a.members.owner.userId], [String(teams.aOld), "Old", true, a.members.owner.userId]].sort());
  assert.deepEqual(await teamMemberRows(aId), [[String(teams.aWest), planner, false], [String(teams.aOld), planner, false]].sort());
  assert.equal((await membership(aId, planner)).version, 1);
  assert.equal(await eventCount(dxg.org), staffRowsBefore, "nothing was recorded in the staff organization");
  await noNewCustomerRows("removed routes");
  // The read beside them still answers (the teams and members lists: staff-organization-content.test.ts).
  assert.equal((await asStaff("GET", team(teams.aWest))).status, 200);
});

test("RFPilot's own organization and a legacy holding tenant are refused (409), an unknown organization is 404; none is changed", async () => {
  const cases: Array<[mongoose.Types.ObjectId, mongoose.Types.ObjectId, mongoose.Types.ObjectId, number, string, string | null]> = [
    [dxg.org, dxg.team, dxg.impostor, 409, "ORGANIZATION_NOT_MANAGEABLE", "platform"],
    [holding.org, holding.team, holding.member, 409, "ORGANIZATION_NOT_MANAGEABLE", "legacy_holding"],
    [oid(), teams.aWest, oid(a.members.planner.userId), 404, "ORGANIZATION_NOT_FOUND", null],
  ];
  const before = JSON.stringify([await teamRows(dxg.org), await teamRows(holding.org), await teamMemberRows(dxg.org), await teamMemberRows(holding.org)]);
  for (const [organization, teamId, , status, code, standing] of cases) {
    const requests: Array<[string, string, unknown]> = [["GET", `${BASE}/${organization}/teams/${teamId}`, undefined]];
    for (const [method, path, body] of requests) {
      const res = await asStaff(method, path, body);
      assert.deepEqual([res.status, res.body.code], [status, code], `${method} ${path}: ${res.text}`);
      const event = await lastStaffEvent();
      assert.deepEqual([String(event.organizationId), event.decision, event.reason, event.metadata.organizationId, event.metadata.standing ?? null], [String(dxg.org), "denied", code.toLowerCase(), String(organization), standing]);
    }
  }
  assert.equal(JSON.stringify([await teamRows(dxg.org), await teamRows(holding.org), await teamMemberRows(dxg.org), await teamMemberRows(holding.org)]), before);
  assert.equal(await eventCount(holding.org), 0);
  await noNewCustomerRows("refused organizations");
});

test("audit: one event per staff request, all in the staff organization; A and B gained no row; no staff account was written into a customer organization", async () => {
  const events = await staffEvents();
  assert.equal(events.length, staffRequests, "exactly one event per request");
  assert.equal(await eventCount(dxg.org), baseline.staff + staffRequests, "and nothing else was written in the staff organization");
  for (const event of events) {
    assert.equal(String(event.organizationId), String(dxg.org));
    assert.ok(staffIds().includes(String(event.actorUserId)));
    assert.equal(event.action, STAFF_TEAM_AUDIT.read, "the read is the only staff team action written");
    assert.ok(["allowed", "denied"].includes(event.decision));
    assert.equal(event.targetType, "team");
    assert.equal(event.metadata.agentAccountType, "admin");
    assert.equal(typeof event.metadata.organizationId, "string");
    assert.equal(event.metadata.staffReason, undefined);
  }
  assert.ok(events.some((event) => event.decision === "allowed"), "a read that returned a team");
  assert.ok(events.some((event) => event.decision === "denied"), "a refused read");
  assert.equal(JSON.stringify(events).includes(REASON), false, "the body of a removed route was never read");
  await noNewCustomerRows("the whole run");
  assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: { $nin: [dxg.org] }, action: { $in: STAFF_ACTIONS } }), 0, "no staff team event outside the staff organization");
  assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: { $in: [aId, bId] }, actorUserId: { $in: dxg.staff } }), 0);
  assert.equal(await OrganizationMembership.countDocuments({ organizationId: { $in: [aId, bId, holding.org] }, userId: { $in: dxg.staff } }), 0);
  assert.equal(await TeamMembership.countDocuments({ userId: { $in: dxg.staff } }), 0);
  assert.equal(await Team.countDocuments({ createdBy: { $in: dxg.staff } }), 0);
  // The member actions of the sibling change were not written by any of this.
  assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: dxg.org, action: { $in: Object.values(STAFF_MEMBER_AUDIT) } }), 0);
});

test("A's customer audit endpoints (list, filters, CSV) show none of the staff actions, by default, by action, by category or by actor, even if such rows were stored in A", async () => {
  // Rows that the service never writes: the staff actions stored in A itself. Still never returned.
  const planted = await SecurityAuditEvent.insertMany(STAFF_ACTIONS.map((action) => ({
    organizationId: aId, actorUserId: dxg.staff[0], action, targetType: "team", targetId: String(teams.aWest),
    decision: "allowed", reason: "team_renamed", correlationId: randomMongoId(), metadata: { staffReason: `planted-${tag}`, name: "West", previousName: "East", userId: a.members.planner.userId, isManager: true },
  })));
  try {
    // The Admin of A was never touched by a staff action, so the session is intact.
    const admin = a.members.organization_admin.accessToken;
    const hiddenText = ["platform.", "organization_team.", "organization_member.", `planted-${tag}`, REASON, ...staffIds(), "Staff Person"];
    for (const query of ["?limit=100", "?category=teams&limit=100", "?category=members&limit=100", `?actor=${dxg.staff[0]}`, `?actor=${dxg.staff[1]}`, "?actor=support"]) {
      const res = await call(admin, "GET", `${AUDIT_LOG}${query}`);
      assert.equal(res.status, 200, `${query}: ${res.text}`);
      for (const row of planted) assert.equal(res.text.includes(String(row._id)), false, `${query} returned ${row.action}`);
      for (const text of hiddenText) assert.equal(res.text.includes(text), false, `${query}: ${text}`);
      if (query.startsWith("?actor=") || query.startsWith("?category=teams")) assert.deepEqual(res.body.data.events, [], query);
      // Nothing a staff action would have written customer-side is there either.
      for (const event of res.body.data.events) assert.equal(CUSTOMER_TEAM_ACTIONS.includes(event.action), false, `${query}: ${event.action}`);
    }
    for (const action of STAFF_ACTIONS) {
      const res = await call(admin, "GET", `${AUDIT_LOG}?action=${action}`);
      assert.deepEqual([res.status, res.body.code], [400, "AUDIT_FILTER_INVALID"], action);
    }
    // The customer's own team actions can be asked for, and there are none: nobody changed A's teams.
    for (const action of CUSTOMER_TEAM_ACTIONS) {
      const res = await call(admin, "GET", `${AUDIT_LOG}?action=${action}`);
      assert.deepEqual([res.status, res.body.data.events], [200, []], action);
    }
    // The export is limited to 20 per user per 15 minutes: six calls here.
    for (const query of ["", "?category=teams", "?category=members", `?actor=${dxg.staff[0]}`]) {
      const res = await call(admin, "GET", `${AUDIT_LOG}/export${query}`);
      assert.equal(res.status, 200, `export${query}: ${res.text.slice(0, 200)}`);
      for (const row of planted) assert.equal(res.text.includes(String(row._id)), false, `export${query} returned ${row.action}`);
      for (const text of hiddenText) assert.equal(res.text.includes(text), false, `export${query}: ${text}`);
      for (const action of CUSTOMER_TEAM_ACTIONS) assert.equal(res.text.includes(action), false);
      for (const label of ["Team created", "Team renamed", "Team archived", "Team member added", "Team member removed", "Team manager changed", "Teams changed"]) assert.equal(res.text.includes(label), false, `export${query}: ${label}`);
    }
    for (const action of [STAFF_TEAM_AUDIT.created, STAFF_TEAM_AUDIT.memberTeamsChanged]) {
      const res = await call(admin, "GET", `${AUDIT_LOG}/export?action=${action}`);
      assert.equal(res.status, 400, action);
    }
    const filters = await call(admin, "GET", `${AUDIT_LOG}/filters`);
    assert.equal(filters.status, 200);
    for (const text of ["platform", "organization_team.", "organization_member.", "RFPilot"]) assert.equal(filters.text.includes(text), false, text);
    // The log still works for A: the Admin's own sign-in is there.
    const own = await call(admin, "GET", `${AUDIT_LOG}?action=auth.session.created&actor=${a.members.organization_admin.userId}`);
    assert.equal(own.status, 200);
    assert.ok(own.body.data.events.length >= 1);
  } finally {
    await SecurityAuditEvent.collection.deleteMany({ _id: { $in: planted.map((row) => row._id) } });
  }
});

// The customer's own audit view of team changes: the list by category, each action, and the CSV.
const teamAuditView = async (token: string) => {
  const list = await call(token, "GET", `${AUDIT_LOG}?limit=100`);
  assert.equal(list.status, 200, list.text);
  const byAction: Record<string, number> = {};
  for (const action of CUSTOMER_TEAM_ACTIONS) {
    const res = await call(token, "GET", `${AUDIT_LOG}?action=${action}&limit=100`);
    assert.equal(res.status, 200, `${action}: ${res.text}`);
    byAction[action] = res.body.data.events.length;
  }
  // One export per call of this helper (the limit is 20 per user per 15 minutes).
  const csv = await call(token, "GET", `${AUDIT_LOG}/export`);
  assert.equal(csv.status, 200, csv.text.slice(0, 200));
  return { ids: (list.body.data.events as Array<Record<string, any>>).map((event) => event.id).sort(), byAction, text: list.text, csv: csv.text, csvLines: csv.text.trim().split("\n").length };
};

test("control: the same changes made by the organization's Admin through the customer routes still write the usual rows, and nothing on the staff side", async () => {
  const d = await seedOrganization(`D Control ${tag}`);
  const dId = oid(d.organizationId);
  const admin = d.members.organization_admin;
  const manager = d.members.team_manager.userId;
  const planner = d.members.planner.userId;
  try {
    const staffRowsBefore = await eventCount(dxg.org);
    const made = await call(admin.accessToken, "POST", "/api/v1/teams", { name: "Conferences" });
    assert.equal(made.status, 201, made.text);
    const teamId = made.body.data.id as string;
    assert.equal(String((await teamDoc(teamId))!.createdBy), admin.userId, "a member's team still stores its creator");
    assert.equal((await call(admin.accessToken, "PATCH", `/api/v1/teams/${teamId}`, { name: "Conferences West" })).status, 200);
    assert.equal((await call(admin.accessToken, "POST", `/api/v1/teams/${teamId}/members`, { userId: manager, isManager: true })).status, 201);
    assert.equal((await call(admin.accessToken, "POST", `/api/v1/teams/${teamId}/members`, { userId: planner })).status, 201);
    assert.equal((await call(admin.accessToken, "PATCH", `/api/v1/teams/${teamId}/members/${manager}`, { isManager: false })).status, 200);
    assert.equal((await call(admin.accessToken, "DELETE", `/api/v1/teams/${teamId}/members/${planner}`)).status, 200);
    const changed = await call(admin.accessToken, "PUT", `/api/organization/members/${planner}/teams`, { teamIds: [teamId], version: 1 });
    assert.equal(changed.status, 200, changed.text);
    assert.equal((await membership(dId, planner)).version, 2);
    // The customer's own refusals.
    const refusals: Array<[string, string, unknown, number, string]> = [
      ["POST", "/api/v1/teams", { name: "conferences west" }, 409, "TEAM_NAME_TAKEN"],
      ["POST", `/api/v1/teams/${teamId}/members`, { userId: planner }, 409, "TEAM_MEMBER_EXISTS"],
      ["PATCH", `/api/v1/teams/${teamId}/members/${planner}`, { isManager: true }, 422, "TEAM_MANAGER_ROLE_REQUIRED"],
      ["PATCH", `/api/v1/teams/${teams.bNorth}`, { name: "Taken over" }, 404, "TEAM_NOT_FOUND"],
      ["PUT", `/api/organization/members/${planner}/teams`, { teamIds: [String(teams.bNorth)], version: 2 }, 400, "UNKNOWN_TEAMS"],
    ];
    for (const [method, path, body, status, code] of refusals) {
      const res = await call(admin.accessToken, method, path, body);
      assert.deepEqual([res.status, res.body.code], [status, code], `${method} ${path}: ${res.text}`);
    }
    assert.equal((await call(admin.accessToken, "POST", `/api/v1/teams/${teamId}/archive`)).status, 200);

    // The usual rows, in the organization, in order, by the Admin.
    const rows = (await SecurityAuditEvent.find({ organizationId: dId, action: { $in: CUSTOMER_TEAM_ACTIONS } }).sort({ createdAt: 1, _id: 1 }).lean()) as Array<Record<string, any>>;
    assert.deepEqual(rows.map((row) => [row.action, row.decision, String(row.actorUserId)]), [
      ["team.created", "created", admin.userId], ["team.renamed", "allowed", admin.userId], ["team.member_added", "created", admin.userId], ["team.member_added", "created", admin.userId],
      ["team.manager_changed", "revoked", admin.userId], ["team.member_removed", "revoked", admin.userId], ["organization.member.teams_changed", "allowed", admin.userId], ["team.archived", "revoked", admin.userId],
    ]);
    // And the organization's audit list and CSV show them.
    const view = await teamAuditView(admin.accessToken);
    assert.deepEqual(view.byAction, { "team.created": 1, "team.renamed": 1, "team.archived": 1, "team.member_added": 2, "team.member_removed": 1, "team.manager_changed": 1, "organization.member.teams_changed": 1 });
    for (const label of ["Team created", "Team renamed", "Team archived", "Team member added", "Team member removed", "Team manager changed", "Teams changed"]) assert.ok(view.csv.includes(label), `CSV: ${label}`);
    // Nothing on the staff side, and no `platform.` row in the organization.
    assert.equal(await eventCount(dxg.org), staffRowsBefore);
    assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: dId, action: /^platform\./ }), 0);
  } finally {
    await SecurityAuditEvent.collection.deleteMany({ organizationId: dId });
  }
});

test("nothing changed in B", async () => {
  assert.equal(await snapshot(bId), bBefore);
  assert.deepEqual(await teamRows(bId), [[String(teams.bNorth), "North", false, b.members.owner.userId]]);
  assert.deepEqual(await teamMemberRows(bId), [[String(teams.bNorth), b.members.planner.userId, false], [String(teams.bNorth), b.members.team_manager.userId, true]].sort());
  for (const role of ROLES) {
    const row = await membership(bId, b.members[role].userId);
    assert.deepEqual([row.roles, row.status, row.version], [[role], "active", 1], role);
    assert.equal((await RefreshSession.findOne({ sessionId: b.members[role].sessionId }).lean())?.status, "active", role);
  }
});
