// 2026-11-17: the two ungated staff proposal routes are gone and the staff client list keeps a
// per-account proposal count (owner decision of the same date: staff see account-level
// information and counts without a support grant, and no customer content). Through the real API
// on real MongoDB, with two organizations: the count for an account in the staff member's
// organization leaves out proposals the same account id owns in another organization, the list
// carries no proposal title or id, nothing is written to any audit log, and the removed paths
// answer 404 for staff and for customers.
import { TEST_MONGODB_DB_NAME } from "./env";
import { connectMongo, disconnectMongo, ensureMigrated, ensureServices, randomMongoId } from "./setup";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import http from "node:http";
import mongoose from "mongoose";
import app from "../server";
import Admin from "../modal/adminModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import Proposal from "../modal/proposalsModel";
import SecurityAuditEvent from "../modal/securityAuditEventModel";
import { beginAuthenticatedSession } from "../src/modules/auth/composition";
import { closePostgres } from "../config/postgres";
import { closeSecurityRateLimitRedis } from "../middleware/securityRateLimit";
import { closeSupportRedis } from "../src/modules/supportDesk/infrastructure/redis/supportRedis";
import { closeQueue } from "../src/modules/durableJobs/queue";
import { cleanupOrganizations, ROLES, seedOrganization, type Fixture } from "./memberFixtures";

const tag = randomMongoId().slice(0, 10);
const oid = (value?: string) => new mongoose.Types.ObjectId(value);
const CLIENTS = "/api/all-clients";
const CLIENT_FIELDS = ["id", "name", "email", "company", "joinDate", "isBlocked", "totalProposals", "totalEmailSent"];

let server: http.Server;
let baseUrl: string;
// The staff member's own organization, which also holds the accounts the client list shows.
let home: Fixture;
let other: Fixture;
let homeId: mongoose.Types.ObjectId;
let otherId: mongoose.Types.ObjectId;
let staffToken: string;
let superToken: string;
const staff = { admin: oid(), superAdmin: oid() };
let homeProposalIds: string[] = [];
let otherProposalIds: string[] = [];

const homeTitles = [`Home Gala ${tag}`, `Home Summit ${tag}`];
const otherTitles = [`Other Retreat A ${tag}`, `Other Retreat B ${tag}`, `Other Retreat C ${tag}`, `Other Owner Event A ${tag}`, `Other Owner Event B ${tag}`, `Other Owner Event C ${tag}`, `Other Owner Event D ${tag}`];

const request = async (token: string, method: string, path: string) => {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, any> };
};
const sessionFor = async (userId: mongoose.Types.ObjectId, organizationId: mongoose.Types.ObjectId) =>
  (await beginAuthenticatedSession({ userId: String(userId), organizationId: String(organizationId), correlationId: randomMongoId() })).accessToken;
const proposal = (organizationId: mongoose.Types.ObjectId, userId: string, eventName: string) => ({
  organizationId, userId: oid(userId), status: "unsubmitted", isDraft: true, isArchived: false,
  event: { eventName }, createdAt: new Date(), updatedAt: new Date(),
});
const auditEvents = () => SecurityAuditEvent.countDocuments({ organizationId: { $in: [homeId, otherId] } });

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);

  home = await seedOrganization(`Home Org ${tag}`);
  other = await seedOrganization(`Other Org ${tag}`);
  homeId = oid(home.organizationId);
  otherId = oid(other.organizationId);
  const planner = home.members.planner.userId;

  // The planner owns two proposals at home. The same account id also owns three in the other
  // organization (a row left behind by a move, or bad data): those must not be counted.
  const atHome = await Proposal.collection.insertMany(homeTitles.map((title) => proposal(homeId, planner, title)));
  const elsewhere = await Proposal.collection.insertMany([
    ...otherTitles.slice(0, 3).map((title) => proposal(otherId, planner, title)),
    ...otherTitles.slice(3).map((title) => proposal(otherId, other.members.owner.userId, title)),
  ]);
  homeProposalIds = Object.values(atHome.insertedIds).map(String);
  otherProposalIds = Object.values(elsewhere.insertedIds).map(String);

  await Admin.collection.insertOne({ _id: staff.admin, organizationId: homeId, name: "Staff Agent", email: `staff-${tag}@example.com`, password: "not-a-real-hash", role: "admin", isBlocked: false });
  await Admin.collection.insertOne({ _id: staff.superAdmin, organizationId: homeId, name: "Staff Lead", email: `lead-${tag}@example.com`, password: "not-a-real-hash", role: "super_admin", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: homeId, userId: staff.admin, roles: ["dxg_admin"], status: "active", version: 1 });
  await OrganizationMembership.collection.insertOne({ organizationId: homeId, userId: staff.superAdmin, roles: ["super_admin"], status: "active", version: 1 });
  staffToken = await sessionFor(staff.admin, homeId);
  superToken = await sessionFor(staff.superAdmin, homeId);

  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    // Raw collection: the audit model itself is append-only.
    if (homeId && otherId) await SecurityAuditEvent.collection.deleteMany({ organizationId: { $in: [homeId, otherId] } });
    await Admin.collection.deleteMany({ _id: { $in: [staff.admin, staff.superAdmin] } });
    await cleanupOrganizations();
  }
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
  await closeSupportRedis();
  await closeQueue();
});

test("the client list counts an account's proposals in the staff organization only", async () => {
  // The data really is there to leak: five proposals carry the planner's id across both organizations.
  assert.equal(await Proposal.countDocuments({ organizationId: { $in: [homeId, otherId] }, userId: oid(home.members.planner.userId) }), 5);

  for (const token of [staffToken, superToken]) {
    const res = await request(token, "GET", CLIENTS);
    assert.equal(res.status, 200, res.text);
    const clients = res.body.data as Array<Record<string, unknown>>;
    assert.deepEqual(clients.map((client) => client.id).sort(), ROLES.map((role) => home.members[role].userId).sort());
    assert.equal(res.body.pagination.total, ROLES.length);
    for (const client of clients) {
      assert.deepEqual(Object.keys(client), CLIENT_FIELDS);
      assert.equal(typeof client.totalProposals, "number");
      assert.equal(typeof client.totalEmailSent, "number");
    }
    const counts = Object.fromEntries(clients.map((client) => [client.id, client.totalProposals]));
    // Two, not five: the three proposals in the other organization are not counted.
    assert.equal(counts[home.members.planner.userId], 2);
    for (const role of ROLES.filter((r) => r !== "planner")) assert.equal(counts[home.members[role].userId], 0, role);
  }
});

test("the client list carries no proposal title or id and nothing from the other organization", async () => {
  const res = await request(staffToken, "GET", `${CLIENTS}?search=person`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.data.length, ROLES.length);
  for (const leaked of [...homeTitles, ...otherTitles, ...homeProposalIds, ...otherProposalIds, other.organizationId, ...ROLES.flatMap((role) => [other.members[role].userId, other.members[role].email]), "not-a-real-hash"]) {
    assert.ok(!res.text.includes(leaked), leaked);
  }
});

test("reading the client list writes no audit event in either organization", async () => {
  const eventsBefore = await auditEvents();
  assert.equal((await request(staffToken, "GET", CLIENTS)).status, 200);
  assert.equal((await request(superToken, "GET", `${CLIENTS}?page=2`)).status, 200);
  assert.equal(await auditEvents(), eventsBefore);
});

test("customers are refused the client list", async () => {
  for (const member of [home.members.owner, home.members.planner, other.members.owner]) {
    const res = await request(member.accessToken, "GET", CLIENTS);
    assert.equal(res.status, 403, res.text);
    assert.ok(!res.text.includes("totalProposals"));
  }
});

test("the removed proposal routes answer 404 for staff and for customers", async () => {
  const callers: Array<[string, string]> = [
    ["staff", staffToken], ["super admin", superToken],
    ["home owner", home.members.owner.accessToken], ["home planner", home.members.planner.accessToken],
    ["other owner", other.members.owner.accessToken], ["no session", "not-a-token"],
  ];
  const paths = ["/api/admin/proposals", "/api/admin/proposals?view=published&search=Gala", `/api/admin/proposals/${homeProposalIds[0]}`, `/api/admin/proposals/${otherProposalIds[0]}`];
  for (const [caller, token] of callers) {
    for (const path of paths) {
      const res = await request(token, "GET", path);
      assert.equal(res.status, 404, `${caller} ${path}: ${res.text}`);
      assert.deepEqual(res.body, { success: false, message: "Route not found" }, `${caller} ${path}`);
    }
  }
  // The router is still there for what it kept.
  assert.equal((await request(staffToken, "GET", "/api/admin/overview")).status, 200);
});
