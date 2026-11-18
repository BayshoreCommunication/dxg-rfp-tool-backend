// Owner decision 2026-11-18 (docs/DECISIONS.md): RFPilot staff (an `admins` account holding an
// admin role) manage a customer organization's teams under the customer's own rules, and what
// they do is recorded on the RFPilot side only. The sibling of staff-member-management.test.ts.
// Through the real API on real MongoDB: two customer organizations (A and B), the staff
// organization and a legacy holding tenant. Every action end to end in A; every event lands in
// the staff organization; A and B gain no audit row; A's own audit endpoints (list, filters, CSV)
// show none of it; nothing changes in B; and the organization's own Admin still gets the usual rows.
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
import { mongoStaffMemberTeams } from "../src/modules/organizationMembers/infrastructure/mongoTeamDirectory";
import { STAFF_MEMBER_AUDIT, STAFF_TEAM_AUDIT } from "../src/modules/staffAccess/domain";
import { mongoTeamRepository } from "../src/modules/teams/infrastructure/mongoTeamRepository";
import { closePostgres } from "../config/postgres";
import { closeSecurityRateLimitRedis } from "../middleware/securityRateLimit";
import { closeSupportRedis } from "../src/modules/supportDesk/infrastructure/redis/supportRedis";
import { cleanupOrganizations, ROLES, seedOrganization, type Fixture } from "./memberFixtures";

const tag = randomMongoId().slice(0, 10);
const oid = (value?: string) => new mongoose.Types.ObjectId(value);
const BASE = "/api/v1/admin/organizations";
const AUDIT_LOG = "/api/v1/organization/audit-events";
const REASON = `Customer asked on the phone, ticket ${tag}`;
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
// RFPilot's own organization: four staff accounts (the write limit is 60 per account per 15
// minutes, so the requests of this suite are spread over them) and a `users` account holding a staff role.
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
// The teams a member is on, as stored.
const teamsOf = async (organizationId: mongoose.Types.ObjectId, userId: string) =>
  (await TeamMembership.collection.find({ organizationId, userId: oid(userId) }).sort({ teamId: 1 }).toArray()).map((row) => [String(row.teamId), row.isManager]);
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

test("trust boundary: no customer role, no `users` account holding a staff role and no anonymous caller can use any route; nothing changes and nothing is recorded", async () => {
  const planner = a.members.planner.userId;
  const routes: Array<[string, string, unknown]> = [
    ["POST", `${org()}/teams`, { name: "Intruder", reason: REASON }],
    ["GET", team(teams.aWest), undefined],
    ["PATCH", team(teams.aWest), { name: "Intruder", reason: REASON }],
    ["POST", `${team(teams.aWest)}/archive`, { reason: REASON }],
    ["POST", `${team(teams.aWest)}/members`, { userId: a.members.viewer.userId, reason: REASON }],
    ["PATCH", `${team(teams.aWest)}/members/${planner}`, { isManager: false, reason: REASON }],
    ["DELETE", `${team(teams.aWest)}/members/${planner}`, { reason: REASON }],
    ["PUT", `${org()}/members/${planner}/teams`, { teamIds: [], version: 1, reason: REASON }],
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

let created: string;

test("create and rename: under the customer's rules, with one staff-side event each; no creator is stored; names are unique in the organization only", async () => {
  const res = await asStaff("POST", `${org()}/teams`, { name: "  South  ", reason: `  ${REASON}  ` });
  assert.equal(res.status, 201, res.text);
  created = res.body.data.team.id;
  assert.deepEqual(Object.keys(res.body.data.team).sort(), TEAM_KEYS);
  assert.deepEqual([res.body.data.organizationId, res.body.data.team.name, res.body.data.team.archived, res.body.data.team.memberCount, res.body.data.members], [a.organizationId, "South", false, 0, []]);
  const row = (await teamDoc(created))!;
  assert.deepEqual([String(row.organizationId), row.name, row.archived, row.createdBy], [a.organizationId, "South", false, null], "the team is A's and no staff account is stored on it");
  let event = await lastStaffEvent();
  assert.deepEqual([String(event.organizationId), event.action, event.decision, event.reason, event.targetType, event.targetId], [String(dxg.org), STAFF_TEAM_AUDIT.created, "allowed", "team_created", "team", created]);
  assert.deepEqual([event.metadata.organizationId, event.metadata.teamId, event.metadata.changed, event.metadata.before, event.metadata.after, event.metadata.staffReason, event.metadata.agentAccountType], [a.organizationId, created, true, null, { name: "South" }, REASON, "admin"]);
  // B's team name is free in A: uniqueness is per organization.
  const north = await asStaff("POST", `${org()}/teams`, { name: "North", reason: REASON });
  assert.equal(north.status, 201, north.text);
  // An archived team's name is free too.
  const old = await asStaff("POST", `${org()}/teams`, { name: "old", reason: REASON });
  assert.equal(old.status, 201, old.text);

  const renamed = await asStaff("PATCH", team(created), { name: "South Coast", reason: REASON });
  assert.equal(renamed.status, 200, renamed.text);
  assert.deepEqual([renamed.body.data.team.id, renamed.body.data.team.name], [created, "South Coast"]);
  assert.equal((await teamDoc(created))!.name, "South Coast");
  event = await lastStaffEvent();
  assert.deepEqual([event.action, event.decision, event.reason, event.targetId, event.metadata.changed, event.metadata.before, event.metadata.after], [STAFF_TEAM_AUDIT.renamed, "allowed", "team_renamed", created, true, { name: "South" }, { name: "South Coast" }]);

  const refusals: Array<[string, string, unknown, number, string, string]> = [
    ["POST", `${org()}/teams`, { name: "WEST", reason: REASON }, 409, "TEAM_NAME_TAKEN", STAFF_TEAM_AUDIT.created],
    ["POST", `${org()}/teams`, { name: "   ", reason: REASON }, 400, "INVALID_TEAM_NAME", STAFF_TEAM_AUDIT.created],
    ["POST", `${org()}/teams`, { name: "x".repeat(121), reason: REASON }, 400, "INVALID_TEAM_NAME", STAFF_TEAM_AUDIT.created],
    ["POST", `${org()}/teams`, { name: "No reason" }, 400, "INVALID_REASON", STAFF_TEAM_AUDIT.created],
    ["POST", `${org()}/teams`, { name: "Short reason", reason: "too short" }, 400, "INVALID_REASON", STAFF_TEAM_AUDIT.created],
    ["PATCH", team(created), { name: "west", reason: REASON }, 409, "TEAM_NAME_TAKEN", STAFF_TEAM_AUDIT.renamed],
    ["PATCH", team(created), { reason: REASON }, 400, "INVALID_TEAM_NAME", STAFF_TEAM_AUDIT.renamed],
    ["PATCH", team(teams.aOld), { name: "Revived", reason: REASON }, 409, "TEAM_ARCHIVED", STAFF_TEAM_AUDIT.renamed],
    ["PATCH", team(teams.bNorth), { name: "Taken over", reason: REASON }, 404, "TEAM_NOT_FOUND", STAFF_TEAM_AUDIT.renamed],
    ["PATCH", team(oid()), { name: "Nothing", reason: REASON }, 404, "TEAM_NOT_FOUND", STAFF_TEAM_AUDIT.renamed],
  ];
  const beforeRefusals = JSON.stringify(await teamRows(aId));
  for (const [method, path, body, status, code, action] of refusals) {
    const refused = await asStaff(method, path, body);
    assert.deepEqual([refused.status, refused.body.code], [status, code], `${method} ${path} ${JSON.stringify(body).slice(0, 60)}: ${refused.text}`);
    event = await lastStaffEvent();
    assert.deepEqual([String(event.organizationId), event.action, event.decision, event.reason], [String(dxg.org), action, "denied", code.toLowerCase()]);
    if (code === "INVALID_REASON") assert.deepEqual(refused.body.fields, { reason: "Give a reason of 10 to 500 characters." });
  }
  assert.equal(JSON.stringify(await teamRows(aId)), beforeRefusals, "a refusal changes nothing");
  assert.equal((await teamDoc(teams.bNorth))!.name, "North");
  await noNewCustomerRows("create and rename");
});

test("team members: add, set and unset the manager, remove; managers must hold the Team Manager role and members must be active members of that organization", async () => {
  const manager = a.members.team_manager.userId;
  const viewer = a.members.viewer.userId;
  const added = await asStaff("POST", `${team(created)}/members`, { userId: manager, isManager: true, reason: REASON });
  assert.equal(added.status, 201, added.text);
  assert.deepEqual([added.body.data.team.memberCount, added.body.data.team.managers.map((m: any) => m.id), added.body.data.members.map((m: any) => [m.member.userId, m.isManager, m.version])], [1, [manager], [[manager, true, 1]]]);
  assert.deepEqual(Object.keys(added.body.data.members[0].member).sort(), MEMBER_KEYS);
  assert.deepEqual(await teamMemberRows(aId, created), [[created, manager, true]]);
  let event = await lastStaffEvent();
  assert.deepEqual([event.action, event.decision, event.reason, event.targetType, event.targetId, event.metadata.memberUserId, event.metadata.before, event.metadata.after, event.metadata.staffReason],
    [STAFF_TEAM_AUDIT.memberAdded, "allowed", "team_member_added", "team", created, manager, null, { userId: manager, isManager: true }, REASON]);
  assert.equal((await asStaff("POST", `${team(created)}/members`, { userId: viewer, reason: REASON })).status, 201);

  const unset = await asStaff("PATCH", `${team(created)}/members/${manager}`, { isManager: false, reason: REASON });
  assert.equal(unset.status, 200, unset.text);
  assert.deepEqual(unset.body.data.team.managers, []);
  event = await lastStaffEvent();
  assert.deepEqual([event.action, event.reason, event.metadata.changed, event.metadata.before, event.metadata.after], [STAFF_TEAM_AUDIT.managerChanged, "team_manager_changed", true, { isManager: true }, { isManager: false }]);
  const set = await asStaff("PATCH", `${team(created)}/members/${manager}`, { isManager: true, reason: REASON });
  assert.deepEqual([set.status, set.body.data.team.managers.map((m: any) => m.id)], [200, [manager]]);

  // A DELETE carries its reason in the JSON body.
  const removed = await asStaff("DELETE", `${team(created)}/members/${viewer}`, { reason: REASON });
  assert.equal(removed.status, 200, removed.text);
  assert.deepEqual(removed.body.data.members.map((m: any) => m.member.userId), [manager]);
  assert.deepEqual(await teamMemberRows(aId, created), [[created, manager, true]]);
  event = await lastStaffEvent();
  assert.deepEqual([event.action, event.reason, event.metadata.memberUserId, event.metadata.before, event.metadata.after], [STAFF_TEAM_AUDIT.memberRemoved, "team_member_removed", viewer, { userId: viewer, isManager: false }, null]);

  const refusals: Array<[string, string, unknown, number, string, string]> = [
    ["POST", `${team(created)}/members`, { userId: a.members.planner.userId, isManager: true, reason: REASON }, 422, "TEAM_MANAGER_ROLE_REQUIRED", STAFF_TEAM_AUDIT.memberAdded],
    ["POST", `${team(created)}/members`, { userId: a.members.organization_admin.userId, isManager: true, reason: REASON }, 422, "TEAM_MANAGER_ROLE_REQUIRED", STAFF_TEAM_AUDIT.memberAdded],
    ["POST", `${team(created)}/members`, { userId: manager, reason: REASON }, 409, "TEAM_MEMBER_EXISTS", STAFF_TEAM_AUDIT.memberAdded],
    // B's Team Manager is not a member of A, and B's team is not A's.
    ["POST", `${team(created)}/members`, { userId: b.members.team_manager.userId, isManager: true, reason: REASON }, 404, "MEMBER_NOT_FOUND", STAFF_TEAM_AUDIT.memberAdded],
    ["POST", `${team(created)}/members`, { userId: String(dxg.staff[0]), reason: REASON }, 404, "MEMBER_NOT_FOUND", STAFF_TEAM_AUDIT.memberAdded],
    ["POST", `${team(created)}/members`, { userId: "not-an-id", reason: REASON }, 404, "MEMBER_NOT_FOUND", STAFF_TEAM_AUDIT.memberAdded],
    ["POST", `${team(created)}/members`, { userId: viewer }, 400, "INVALID_REASON", STAFF_TEAM_AUDIT.memberAdded],
    ["POST", `${team(teams.bNorth)}/members`, { userId: viewer, reason: REASON }, 404, "TEAM_NOT_FOUND", STAFF_TEAM_AUDIT.memberAdded],
    ["POST", `${team(teams.aOld)}/members`, { userId: viewer, reason: REASON }, 409, "TEAM_ARCHIVED", STAFF_TEAM_AUDIT.memberAdded],
    ["PATCH", `${team(teams.aWest)}/members/${a.members.planner.userId}`, { isManager: true, reason: REASON }, 422, "TEAM_MANAGER_ROLE_REQUIRED", STAFF_TEAM_AUDIT.managerChanged],
    ["PATCH", `${team(created)}/members/${manager}`, { isManager: "yes", reason: REASON }, 400, "INVALID_TEAM_MANAGER", STAFF_TEAM_AUDIT.managerChanged],
    ["PATCH", `${team(created)}/members/${viewer}`, { isManager: false, reason: REASON }, 404, "TEAM_MEMBER_NOT_FOUND", STAFF_TEAM_AUDIT.managerChanged],
    ["PATCH", `${team(teams.bNorth)}/members/${b.members.team_manager.userId}`, { isManager: false, reason: REASON }, 404, "TEAM_NOT_FOUND", STAFF_TEAM_AUDIT.managerChanged],
    ["PATCH", `${team(created)}/members/${b.members.team_manager.userId}`, { isManager: true, reason: REASON }, 404, "MEMBER_NOT_FOUND", STAFF_TEAM_AUDIT.managerChanged],
    ["PATCH", `${team(created)}/members/not-an-id`, { isManager: false, reason: REASON }, 400, "INVALID_MEMBER_ID", STAFF_TEAM_AUDIT.managerChanged],
    ["DELETE", `${team(created)}/members/${viewer}`, { reason: REASON }, 404, "TEAM_MEMBER_NOT_FOUND", STAFF_TEAM_AUDIT.memberRemoved],
    ["DELETE", `${team(teams.bNorth)}/members/${b.members.planner.userId}`, { reason: REASON }, 404, "TEAM_NOT_FOUND", STAFF_TEAM_AUDIT.memberRemoved],
    ["DELETE", `${team(created)}/members/${b.members.planner.userId}`, { reason: REASON }, 404, "TEAM_MEMBER_NOT_FOUND", STAFF_TEAM_AUDIT.memberRemoved],
    ["DELETE", `${team(teams.aOld)}/members/${a.members.planner.userId}`, { reason: REASON }, 409, "TEAM_ARCHIVED", STAFF_TEAM_AUDIT.memberRemoved],
    ["DELETE", `${team(created)}/members/${manager}`, undefined, 400, "INVALID_REASON", STAFF_TEAM_AUDIT.memberRemoved],
    // A reason in the URL is not a reason.
    ["DELETE", `${team(created)}/members/${manager}?reason=${encodeURIComponent(REASON)}`, undefined, 400, "INVALID_REASON", STAFF_TEAM_AUDIT.memberRemoved],
  ];
  const beforeRefusals = JSON.stringify([await teamMemberRows(aId), await teamMemberRows(bId)]);
  for (const [method, path, body, status, code, action] of refusals) {
    const refused = await asStaff(method, path, body);
    assert.deepEqual([refused.status, refused.body.code], [status, code], `${method} ${path} ${JSON.stringify(body)}: ${refused.text}`);
    event = await lastStaffEvent();
    assert.deepEqual([String(event.organizationId), event.action, event.decision, event.reason, event.metadata.organizationId], [String(dxg.org), action, "denied", code.toLowerCase(), a.organizationId]);
    for (const hidden of [b.members.team_manager.email, b.members.planner.email, "North"]) assert.equal(refused.text.includes(hidden), false, hidden);
  }
  assert.equal(JSON.stringify([await teamMemberRows(aId), await teamMemberRows(bId)]), beforeRefusals, "a refusal changes nothing in A or B");
  // No staff account became a member of A or of a team of A.
  assert.equal(await TeamMembership.countDocuments({ userId: { $in: dxg.staff } }), 0);
  assert.equal(await OrganizationMembership.countDocuments({ organizationId: aId, userId: { $in: dxg.staff } }), 0);
  // None of this touched a session or a membership of A.
  for (const role of ROLES) {
    const row = await membership(aId, a.members[role].userId);
    assert.deepEqual([row.roles, row.status, row.version, row.sessionRevocationPending ?? false], [[role], "active", 1, false], role);
    assert.equal((await RefreshSession.findOne({ sessionId: a.members[role].sessionId }).lean())?.status, "active", role);
  }
  await noNewCustomerRows("team members");
});

test("set a member's teams: exactly the active teams listed, in the member's own organization, with the version checked and moved in the same commit", async () => {
  const planner = a.members.planner;
  const path = `${org()}/members/${planner.userId}/teams`;
  assert.deepEqual(await teamsOf(aId, planner.userId), [[String(teams.aWest), false], [String(teams.aOld), false]].sort());
  const res = await asStaff("PUT", path, { teamIds: [created, String(teams.aWest), created], version: 1, reason: REASON });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.body.data).sort(), ["changed", "member", "organizationId", "version"]);
  assert.deepEqual(Object.keys(res.body.data.member).sort(), MEMBER_KEYS);
  assert.deepEqual([res.body.data.organizationId, res.body.data.changed, res.body.data.member.userId, res.body.data.version], [a.organizationId, true, planner.userId, 2]);
  assert.deepEqual((await teamsOf(aId, planner.userId)).map(([id]) => id).sort(), [created, String(teams.aWest), String(teams.aOld)].sort(), "the archived team's membership is history and is kept");
  assert.equal((await membership(aId, planner.userId)).version, 2);
  let event = await lastStaffEvent();
  assert.deepEqual([String(event.organizationId), event.action, event.decision, event.reason, event.targetType, event.targetId], [String(dxg.org), STAFF_TEAM_AUDIT.memberTeamsChanged, "allowed", "teams_changed", "organization_membership", planner.userId]);
  assert.deepEqual([event.metadata.organizationId, event.metadata.memberUserId, event.metadata.changed, event.metadata.before, event.metadata.after, event.metadata.version, event.metadata.staffReason],
    [a.organizationId, planner.userId, true, { teamIds: [String(teams.aWest)] }, { teamIds: [created, String(teams.aWest)].sort() }, 2, REASON]);

  const refusals: Array<[string, unknown, number, string]> = [
    [path, { teamIds: [String(teams.bNorth)], version: 2, reason: REASON }, 400, "UNKNOWN_TEAMS"],
    [path, { teamIds: [created, String(teams.aOld)], version: 2, reason: REASON }, 400, "UNKNOWN_TEAMS"],
    [path, { teamIds: [String(oid())], version: 2, reason: REASON }, 400, "UNKNOWN_TEAMS"],
    [path, { teamIds: [created], version: 1, reason: REASON }, 409, "STALE_VERSION"],
    [path, { teamIds: [created], reason: REASON }, 400, "VERSION_REQUIRED"],
    [path, { teamIds: "all", version: 2, reason: REASON }, 400, "INVALID_TEAMS"],
    [path, { teamIds: [created.toUpperCase()], version: 2, reason: REASON }, 400, "INVALID_TEAMS"],
    [path, { teamIds: [created], version: 2 }, 400, "INVALID_REASON"],
    [`${org()}/members/${b.members.planner.userId}/teams`, { teamIds: [created], version: 1, reason: REASON }, 404, "MEMBER_NOT_FOUND"],
    [`${org()}/members/${dxg.staff[0]}/teams`, { teamIds: [created], version: 1, reason: REASON }, 404, "MEMBER_NOT_FOUND"],
    [`${org()}/members/not-an-id/teams`, { teamIds: [created], version: 1, reason: REASON }, 400, "INVALID_MEMBER_ID"],
  ];
  const beforeRefusals = JSON.stringify([await teamMemberRows(aId), await teamMemberRows(bId), (await membership(aId, planner.userId)).version, (await membership(bId, b.members.planner.userId)).version]);
  for (const [target, body, status, code] of refusals) {
    const refused = await asStaff("PUT", target, body);
    assert.deepEqual([refused.status, refused.body.code], [status, code], `${target} ${JSON.stringify(body)}: ${refused.text}`);
    event = await lastStaffEvent();
    assert.deepEqual([String(event.organizationId), event.action, event.decision, event.reason], [String(dxg.org), STAFF_TEAM_AUDIT.memberTeamsChanged, "denied", code.toLowerCase()]);
    if (code === "STALE_VERSION") assert.equal(refused.body.currentVersion, 2);
    assert.equal(refused.text.includes("North"), false);
  }
  // Only the ids the caller typed come back: B's team and a team that doesn't exist are told apart by nothing.
  const unknown = await asStaff("PUT", path, { teamIds: [String(teams.bNorth), created], version: 2, reason: REASON });
  assert.deepEqual([unknown.status, unknown.body.code, unknown.body.unknownTeamIds], [400, "UNKNOWN_TEAMS", [String(teams.bNorth)]]);
  assert.equal(JSON.stringify([await teamMemberRows(aId), await teamMemberRows(bId), (await membership(aId, planner.userId)).version, (await membership(bId, b.members.planner.userId)).version]), beforeRefusals, "a refusal changes nothing, not even the version");

  // Off every team; the planner is put back on West for what follows.
  const none = await asStaff("PUT", path, { teamIds: [], version: 2, reason: REASON });
  assert.deepEqual([none.status, none.body.data.changed, none.body.data.version], [200, true, 3]);
  assert.deepEqual((await teamsOf(aId, planner.userId)).map(([id]) => id), [String(teams.aOld)]);
  const back = await asStaff("PUT", path, { teamIds: [String(teams.aWest)], version: 3, reason: REASON });
  assert.deepEqual([back.status, back.body.data.version], [200, 4]);
  // The same list again: the version still moves, as on the customer route; the event says nothing changed.
  const same = await asStaff("PUT", path, { teamIds: [String(teams.aWest)], version: 4, reason: REASON });
  assert.deepEqual([same.status, same.body.data.changed, same.body.data.version, (await lastStaffEvent()).metadata.changed], [200, false, 5, false]);
  // No session of the member ended and none is pending: a change of teams ends no session, as in the customer flow.
  const row = await membership(aId, planner.userId);
  assert.deepEqual([row.roles, row.status, row.sessionRevocationPending ?? false], [["planner"], "active", false]);
  assert.equal((await RefreshSession.findOne({ sessionId: planner.sessionId }).lean())?.status, "active");
  await noNewCustomerRows("a member's teams");
});

test("archive: the team is archived with its memberships kept; a proposal on the team is NOT changed and keeps its team; an archived team can't be changed", async () => {
  // A proposal of A on the team, as the proposal routes would leave it.
  const proposal = await Proposal.create({ organizationId: aId, userId: a.members.organization_admin.userId, event: { eventName: `Team proposal ${tag}` } });
  await Proposal.collection.updateOne({ _id: proposal._id }, { $set: { teamId: oid(created) } });
  const proposalBefore = JSON.stringify(await Proposal.collection.findOne({ _id: proposal._id }));
  const membersBefore = await teamMemberRows(aId, created);

  const res = await asStaff("POST", `${team(created)}/archive`, { reason: REASON });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([res.body.data.team.id, res.body.data.team.archived, typeof res.body.data.team.archivedAt, res.body.data.team.memberCount], [created, true, "string", membersBefore.length]);
  const row = (await teamDoc(created))!;
  assert.deepEqual([row.archived, row.archivedAt instanceof Date], [true, true]);
  assert.deepEqual(await teamMemberRows(aId, created), membersBefore, "memberships are kept");
  const after = (await Proposal.collection.findOne({ _id: proposal._id })) as Record<string, any>;
  assert.equal(JSON.stringify(after), proposalBefore, "the proposal document is byte for byte what it was");
  assert.equal(String(after.teamId), created, "the proposal keeps its team");
  const event = await lastStaffEvent();
  assert.deepEqual([String(event.organizationId), event.action, event.decision, event.reason, event.targetId, event.metadata.changed, event.metadata.before.archived, event.metadata.after.archived, event.metadata.staffReason],
    [String(dxg.org), STAFF_TEAM_AUDIT.archived, "allowed", "team_archived", created, true, false, true, REASON]);

  const refusals: Array<[string, string, unknown, number, string]> = [
    ["POST", `${team(created)}/archive`, { reason: REASON }, 409, "TEAM_ARCHIVED"],
    ["PATCH", team(created), { name: "Back again", reason: REASON }, 409, "TEAM_ARCHIVED"],
    ["POST", `${team(created)}/members`, { userId: a.members.viewer.userId, reason: REASON }, 409, "TEAM_ARCHIVED"],
    ["POST", `${team(teams.bNorth)}/archive`, { reason: REASON }, 404, "TEAM_NOT_FOUND"],
    ["POST", `${team(teams.aWest)}/archive`, {}, 400, "INVALID_REASON"],
  ];
  for (const [method, path, body, status, code] of refusals) {
    const refused = await asStaff(method, path, body);
    assert.deepEqual([refused.status, refused.body.code], [status, code], `${method} ${path}: ${refused.text}`);
    assert.deepEqual([(await lastStaffEvent()).decision, (await lastStaffEvent()).reason], ["denied", code.toLowerCase()]);
  }
  assert.equal((await teamDoc(teams.bNorth))!.archived, false);
  assert.equal((await teamDoc(teams.aWest))!.archived, false);
  assert.equal(JSON.stringify(await Proposal.collection.findOne({ _id: proposal._id })), proposalBefore);
  await Proposal.collection.deleteOne({ _id: proposal._id });
  await noNewCustomerRows("archive");
});

test("RFPilot's own organization and a legacy holding tenant are refused (409), an unknown organization is 404; none is changed", async () => {
  const cases: Array<[mongoose.Types.ObjectId, mongoose.Types.ObjectId, mongoose.Types.ObjectId, number, string, string | null]> = [
    [dxg.org, dxg.team, dxg.impostor, 409, "ORGANIZATION_NOT_MANAGEABLE", "platform"],
    [holding.org, holding.team, holding.member, 409, "ORGANIZATION_NOT_MANAGEABLE", "legacy_holding"],
    [oid(), teams.aWest, oid(a.members.planner.userId), 404, "ORGANIZATION_NOT_FOUND", null],
  ];
  const before = JSON.stringify([await teamRows(dxg.org), await teamRows(holding.org), await teamMemberRows(dxg.org), await teamMemberRows(holding.org)]);
  for (const [organization, teamId, user, status, code, standing] of cases) {
    const requests: Array<[string, string, unknown]> = [
      ["GET", `${BASE}/${organization}/teams/${teamId}`, undefined],
      ["POST", `${BASE}/${organization}/teams`, { name: "Not here", reason: REASON }],
      ["PATCH", `${BASE}/${organization}/teams/${teamId}`, { name: "Not here", reason: REASON }],
      ["POST", `${BASE}/${organization}/teams/${teamId}/archive`, { reason: REASON }],
      ["POST", `${BASE}/${organization}/teams/${teamId}/members`, { userId: String(user), reason: REASON }],
      ["PATCH", `${BASE}/${organization}/teams/${teamId}/members/${user}`, { isManager: false, reason: REASON }],
      ["DELETE", `${BASE}/${organization}/teams/${teamId}/members/${user}`, { reason: REASON }],
      ["PUT", `${BASE}/${organization}/members/${user}/teams`, { teamIds: [String(teamId)], version: 1, reason: REASON }],
    ];
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

test("the change and its audit event commit together: when the event cannot be written, nothing is applied", async () => {
  // An event the audit collection refuses (no action), handed to each store write.
  const audit = { organizationId: String(dxg.org), actorUserId: String(dxg.staff[0]), action: "", targetType: "team", targetId: String(teams.aWest), reason: "x", correlationId: randomMongoId(), metadata: { agentAccountType: "admin", organizationId: a.organizationId } };
  const organizationId = a.organizationId;
  const west = String(teams.aWest);
  const planner = a.members.planner.userId;
  const manager = a.members.team_manager.userId;
  const staffBefore = await eventCount(dxg.org);
  const beforeA = await snapshot(aId);
  await assert.rejects(mongoTeamRepository.create({ organizationId, name: `Never ${tag}`, createdBy: null, audit }), /action/);
  await assert.rejects(mongoTeamRepository.rename({ organizationId, teamId: west, name: `Never renamed ${tag}`, audit }), /action/);
  await assert.rejects(mongoTeamRepository.archive({ organizationId, teamId: west, at: new Date(), audit }), /action/);
  await assert.rejects(mongoTeamRepository.addMember({ organizationId, teamId: west, userId: manager, isManager: true, audit }), /action/);
  await assert.rejects(mongoTeamRepository.setManager({ organizationId, teamId: west, userId: planner, isManager: true, audit }), /action/);
  await assert.rejects(mongoTeamRepository.removeMember({ organizationId, teamId: west, userId: planner, audit }), /action/);
  await assert.rejects(mongoStaffMemberTeams.setMemberTeams({ organizationId, userId: planner, teamIds: [], expectedVersion: 5, audit: { ...audit, targetType: "organization_membership", targetId: planner } }), /action/);
  assert.equal(await snapshot(aId), beforeA, "no team, no team member and no version changed");
  assert.equal(await eventCount(dxg.org), staffBefore);
  // And with a writable event, the store puts it in the event's organization, not the team's.
  const written = await mongoTeamRepository.rename({ organizationId, teamId: west, name: "West", audit: { ...audit, action: STAFF_TEAM_AUDIT.renamed, reason: "team_renamed" } });
  assert.ok(written && written !== "duplicate");
  staffRequests += 1; // one more staff-side event, written by this direct store call
  assert.equal(await eventCount(dxg.org), staffBefore + 1);
  const event = await lastStaffEvent();
  assert.deepEqual([String(event.organizationId), event.metadata.before, event.metadata.changed], [String(dxg.org), { name: "West" }, false]);
  // A store write without an event (the member path) writes no event anywhere.
  assert.equal(await mongoTeamRepository.setManager({ organizationId, teamId: west, userId: planner, isManager: false }), true);
  assert.equal(await eventCount(dxg.org), staffBefore + 1);
  // A write that names another organization's team or member changes nothing and records nothing, with or without an event.
  const live = { ...audit, action: STAFF_TEAM_AUDIT.renamed, reason: "team_renamed" };
  const beforeForeign = await snapshot(aId);
  assert.equal(await mongoTeamRepository.rename({ organizationId, teamId: String(teams.bNorth), name: "Taken over", audit: live }), null);
  assert.equal(await mongoTeamRepository.archive({ organizationId, teamId: String(teams.bNorth), at: new Date(), audit: live }), false);
  assert.equal(await mongoTeamRepository.removeMember({ organizationId, teamId: String(teams.bNorth), userId: b.members.planner.userId, audit: live }), false);
  assert.equal(await mongoTeamRepository.setManager({ organizationId, teamId: String(teams.bNorth), userId: b.members.planner.userId, isManager: true, audit: live }), false);
  assert.deepEqual(await mongoStaffMemberTeams.setMemberTeams({ organizationId, userId: planner, teamIds: [String(teams.bNorth)], expectedVersion: 5, audit: live }), { unknownTeamIds: [String(teams.bNorth)] });
  assert.equal(await mongoStaffMemberTeams.setMemberTeams({ organizationId, userId: b.members.planner.userId, teamIds: [], expectedVersion: 1, audit: live }), "stale");
  assert.equal(await eventCount(dxg.org), staffBefore + 1);
  assert.equal(await snapshot(aId), beforeForeign);
  await noNewCustomerRows("atomic audit");
});

test("audit: one event per staff request, all in the staff organization; A and B gained no row; no staff account was written into a customer organization", async () => {
  const events = await staffEvents();
  assert.equal(events.length, staffRequests, "exactly one event per request");
  assert.equal(await eventCount(dxg.org), baseline.staff + staffRequests, "and nothing else was written in the staff organization");
  for (const event of events) {
    assert.equal(String(event.organizationId), String(dxg.org));
    assert.ok(staffIds().includes(String(event.actorUserId)));
    assert.match(event.action, /^platform\.organization_(team\.[a-z_]+|member\.teams_changed)$/);
    assert.ok(["allowed", "denied"].includes(event.decision));
    assert.equal(event.targetType, event.action === STAFF_TEAM_AUDIT.memberTeamsChanged ? "organization_membership" : "team");
    assert.equal(event.metadata.agentAccountType, "admin");
    assert.equal(typeof event.metadata.organizationId, "string");
    if (event.metadata.staffReason !== undefined) assert.equal(event.metadata.staffReason, REASON);
  }
  for (const action of STAFF_ACTIONS) assert.ok(events.some((event) => event.action === action && event.decision === "allowed"), `${action} allowed`);
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
    // The customer's own team actions can be asked for, and there are none: staff changes wrote none.
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
const NO_TEAM_ROWS = Object.fromEntries(CUSTOMER_TEAM_ACTIONS.map((action) => [action, 0]));

test("side effects: a staff change of a team manager and a staff archive move the Team Manager's reach over the team's proposals exactly as the customer's would, and the member's own later requests leave no row", async () => {
  const c = await seedOrganization(`C Reach ${tag}`);
  const cId = oid(c.organizationId);
  const base = `${BASE}/${c.organizationId}`;
  const manager = c.members.team_manager;
  try {
    const before = await teamAuditView(c.members.owner.accessToken);
    const rowsBefore = await eventCount(cId);
    assert.deepEqual(before.byAction, NO_TEAM_ROWS);
    const made = await asStaff("POST", `${base}/teams`, { name: "Conferences", reason: REASON });
    assert.equal(made.status, 201, made.text);
    const teamId = made.body.data.team.id as string;
    const proposal = await Proposal.create({ organizationId: cId, userId: c.members.planner.userId, event: { eventName: `Reach proposal ${tag}` } });
    await Proposal.collection.updateOne({ _id: proposal._id }, { $set: { teamId: oid(teamId) } });
    const proposalBefore = JSON.stringify(await Proposal.collection.findOne({ _id: proposal._id }));
    const read = async () => (await call(manager.accessToken, "GET", `/api/proposals/${proposal._id}`)).status;

    assert.equal(await read(), 403, "not on the team yet");
    assert.equal((await asStaff("POST", `${base}/teams/${teamId}/members`, { userId: manager.userId, isManager: true, reason: REASON })).status, 201);
    assert.equal(await read(), 200, "a manager of the team reaches its proposals on the next request");
    assert.equal((await asStaff("PATCH", `${base}/teams/${teamId}/members/${manager.userId}`, { isManager: false, reason: REASON })).status, 200);
    assert.equal(await read(), 403, "no longer a manager");
    assert.equal((await asStaff("PATCH", `${base}/teams/${teamId}/members/${manager.userId}`, { isManager: true, reason: REASON })).status, 200);
    assert.equal(await read(), 200);
    assert.equal((await asStaff("POST", `${base}/teams/${teamId}/archive`, { reason: REASON })).status, 200);
    assert.equal(await read(), 403, "an archived team gives its managers no reach");
    // The Owner and the proposal's owner still reach it, and the proposal is what it was.
    assert.equal((await call(c.members.owner.accessToken, "GET", `/api/proposals/${proposal._id}`)).status, 200);
    assert.equal((await call(c.members.planner.accessToken, "GET", `/api/proposals/${proposal._id}`)).status, 200);
    assert.equal(JSON.stringify(await Proposal.collection.findOne({ _id: proposal._id })), proposalBefore);
    // The manager's session and membership were never touched: no sign-out, nothing pending.
    const row = await membership(cId, manager.userId);
    assert.deepEqual([row.version, row.sessionRevocationPending ?? false], [1, false]);
    assert.equal((await RefreshSession.findOne({ sessionId: manager.sessionId }).lean())?.status, "active");

    // The customer organization: not one new row of any action, from the staff changes or from the members' own requests after them.
    assert.equal(await eventCount(cId), rowsBefore);
    assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: cId, actorUserId: { $in: dxg.staff } }), 0);
    const after = await teamAuditView(c.members.owner.accessToken);
    assert.deepEqual(after.ids, before.ids);
    assert.deepEqual(after.byAction, NO_TEAM_ROWS);
    assert.equal(after.csvLines, before.csvLines);
    for (const hidden of ["platform.", "organization_team.", REASON, ...staffIds(), "Conferences"]) {
      assert.equal(after.text.includes(hidden), false, `list: ${hidden}`);
      assert.equal(after.csv.includes(hidden), false, `CSV: ${hidden}`);
    }
    await Proposal.collection.deleteOne({ _id: proposal._id });
  } finally {
    await SecurityAuditEvent.collection.deleteMany({ organizationId: cId });
  }
});

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
    // The customer's refusals are the ones staff got above.
    const refusals: Array<[string, string, unknown, number, string]> = [
      ["POST", "/api/v1/teams", { name: "conferences west" }, 409, "TEAM_NAME_TAKEN"],
      ["POST", `/api/v1/teams/${teamId}/members`, { userId: planner, isManager: true }, 409, "TEAM_MEMBER_EXISTS"],
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
