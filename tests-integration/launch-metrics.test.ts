// ORG-505: the launch metrics on real MongoDB and through the real API. The window metrics are
// computed over a window in the distant past that only this suite's rows fall in, so the numbers
// are exact; the as-of-now metrics are checked as the change this suite's rows make. The HTTP
// tests prove the boundary: DXG staff on an `admins` account read the numbers, no customer does.
import { TEST_MONGODB_DB_NAME } from "./env";
import { connectMongo, disconnectMongo, ensureMigrated, ensureServices, randomMongoId } from "./setup";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import http from "node:http";
import mongoose from "mongoose";
import app from "../server";
import Admin from "../modal/adminModel";
import Invitation from "../modal/invitationModel";
import Organization from "../modal/organizationModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import Proposal from "../modal/proposalsModel";
import RefreshSession from "../modal/refreshSessionModel";
import SecurityAuditEvent from "../modal/securityAuditEventModel";
import SupportAccessGrant from "../modal/supportAccessGrantModel";
import User from "../modal/userModel";
import { beginAuthenticatedSession } from "../src/modules/auth/composition";
import { closePostgres } from "../config/postgres";
import { closeSecurityRateLimitRedis } from "../middleware/securityRateLimit";
import { closeSupportRedis } from "../src/modules/supportDesk/infrastructure/redis/supportRedis";
import { launchMetricsReport, type LaunchMetricsReport } from "../src/modules/launchMetrics/domain";
import { mongoLaunchMetricsSource } from "../src/modules/launchMetrics/mongoLaunchMetricsSource";
import { createMongoInvitationAcceptance } from "../src/modules/invitations/infrastructure/mongoInvitationAcceptance";
import { cleanupOrganizations, createProposals, ROLES, seedOrganization, SLUG_PREFIX, type Fixture } from "./memberFixtures";

const tag = randomMongoId().slice(0, 10);
const oid = (value?: string) => new mongoose.Types.ObjectId(value);
const DAY = 24 * 60 * 60 * 1000;
const METRICS = "/api/v1/admin/launch-metrics";
// A 30-day window ending here holds only this run's rows.
const THEN = new Date(Date.UTC(1971 + Math.floor(Math.random() * 25), Math.floor(Math.random() * 12), 15, 12));
const then = (daysAgo: number, plusSeconds = 0) => new Date(THEN.getTime() - daysAgo * DAY + plusSeconds * 1000);

let server: http.Server;
let baseUrl: string;
let acme: Fixture;
let other: Fixture;
let acmeRfp: string;
let agentToken: string;
let impostorToken: string;
const dxg = { org: oid(), agent: oid(), impostor: oid() };
const extraOrganizations: mongoose.Types.ObjectId[] = [];
const seededUsers: mongoose.Types.ObjectId[] = [];

const call = async (token: string | null, path: string) => {
  const res = await fetch(`${baseUrl}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const sessionFor = async (userId: mongoose.Types.ObjectId | string, organizationId: mongoose.Types.ObjectId | string) =>
  (await beginAuthenticatedSession({ userId: String(userId), organizationId: String(organizationId), correlationId: randomMongoId() })).accessToken;
const metrics = async (days?: number): Promise<LaunchMetricsReport> => {
  const res = await call(agentToken, days ? `${METRICS}?days=${days}` : METRICS);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};

const addOrganization = async (fields: Record<string, unknown> = {}) => {
  const _id = oid();
  await Organization.collection.insertOne({ _id, name: `Metrics ${randomMongoId().slice(0, 6)}`, slug: `${SLUG_PREFIX}${randomMongoId().slice(0, 12)}`, status: "active", kind: "customer", plan: "free_trial", ...fields });
  extraOrganizations.push(_id);
  return _id;
};
const addMember = async (organizationId: mongoose.Types.ObjectId, role = "planner", fields: Record<string, unknown> = {}) => {
  const userId = oid();
  await User.collection.insertOne({ _id: userId, organizationId, name: "Metrics member", email: `metrics-${randomMongoId().slice(0, 10)}@example.com`, password: "not-a-real-hash", role: "customer", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId, userId, roles: [role], status: "active", version: 1, ...fields });
  seededUsers.push(userId);
  return userId;
};
const invite = async (organizationId: string | mongoose.Types.ObjectId, fields: Record<string, unknown>) =>
  Invitation.collection.insertOne({
    organizationId: oid(String(organizationId)), email: `invitee-${randomMongoId().slice(0, 10)}@example.com`, role: "planner", teamId: null,
    invitedBy: oid(acme.members.owner.userId), status: "pending", tokenHash: null, previousTokenHashes: [], expiresAt: new Date(Date.now() + 7 * DAY),
    acceptedAt: null, acceptedBy: null, createdAt: new Date(), updatedAt: new Date(), ...fields,
  });

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);

  acme = await seedOrganization("Acme Events");
  other = await seedOrganization("Other Co");
  [acmeRfp] = await createProposals(acme.organizationId, acme.members.planner.userId, 1);

  await Organization.collection.insertOne({ _id: dxg.org, name: "DXG", slug: `${SLUG_PREFIX}dxg-${tag}`, status: "active", kind: "customer", plan: "free_trial" });
  await Admin.collection.insertOne({ _id: dxg.agent, organizationId: dxg.org, name: "Staff Agent", email: `agent-${tag}@example.com`, password: "not-a-real-hash", role: "admin", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: dxg.agent, roles: ["dxg_admin"], status: "active", version: 1 });
  // A customer account that still holds a legacy staff role: passes the role check, not the account check.
  await User.collection.insertOne({ _id: dxg.impostor, organizationId: dxg.org, name: "Member With Staff Role", email: `impostor-${tag}@example.com`, password: "not-a-real-hash", role: "customer", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: dxg.impostor, roles: ["dxg_admin"], status: "active", version: 1 });
  agentToken = await sessionFor(dxg.agent, dxg.org);
  impostorToken = await sessionFor(dxg.impostor, dxg.org);

  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    const orgIds = [dxg.org, ...extraOrganizations, ...[acme, other].filter(Boolean).map((fixture) => oid(fixture.organizationId))];
    const db = mongoose.connection.db!;
    for (const name of ["invitations", "supportaccessgrants", "securityauditevents", "organizationmemberships", "refreshsessions", "proposals"]) {
      await db.collection(name).deleteMany({ organizationId: { $in: orgIds } });
    }
    await User.collection.deleteMany({ _id: { $in: [...seededUsers, dxg.impostor] } });
    await Admin.collection.deleteOne({ _id: dxg.agent });
    await cleanupOrganizations();
  }
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
  await closeSupportRedis();
});

test("no customer session reaches the launch metrics, and a refusal carries no numbers", async () => {
  const anonymous = await call(null, METRICS);
  assert.equal(anonymous.status, 401);
  for (const fixture of [acme, other]) {
    for (const role of ROLES) {
      const res = await call(fixture.members[role].accessToken, METRICS);
      assert.equal(res.status, 403, role);
      assert.equal(res.body.data, undefined, role);
      assert.equal(res.body.success, false, role);
    }
  }
  const impostor = await call(impostorToken, METRICS);
  assert.equal(impostor.status, 403);
  assert.deepEqual(impostor.body, { success: false, code: "LAUNCH_METRICS_FORBIDDEN", message: "Only RFPilot staff can read launch metrics." });
  // Refused reads leave no audit event and run no query.
  assert.equal(await SecurityAuditEvent.countDocuments({ action: "platform.launch_metrics.read", organizationId: { $in: [dxg.org, acme.organizationId, other.organizationId] } }), 0);
});

test("staff on an admins account read counts and rates only, and the read is audited in the staff organization", async () => {
  const report = await metrics();
  assert.deepEqual(Object.keys(report).sort(), ["generatedAt", "inviteAcceptance", "organizationsWithTwoOrMoreActiveUsers", "orphanedRfps", "supportAccessUnderGrant", "timeToFirstRfpOpened", "window"]);
  assert.equal(report.window.days, 30);
  const text = JSON.stringify(report);
  for (const secret of ["Acme", "Other Co", "@example.com", acme.organizationId, other.organizationId, acme.members.owner.userId, acmeRfp]) {
    assert.ok(!text.includes(secret), secret);
  }
  const bad = await call(agentToken, `${METRICS}?days=0`);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "INVALID_WINDOW");

  const reads = await SecurityAuditEvent.find({ action: "platform.launch_metrics.read", organizationId: dxg.org }).lean();
  assert.equal(reads.length, 1);
  assert.equal(String(reads[0].actorUserId), String(dxg.agent));
  assert.deepEqual(reads[0].metadata, { days: 30, agentAccountType: "admin" });
  assert.equal(await SecurityAuditEvent.countDocuments({ action: "platform.launch_metrics.read", organizationId: { $in: [acme.organizationId, other.organizationId] } }), 0);
});

test("invite acceptance and time to first RFP opened are exact over a window", async () => {
  const fast = await addMember(oid(acme.organizationId), "planner", { firstRfpOpenedAt: then(18, 120) });
  const slow = await addMember(oid(other.organizationId), "viewer", { firstRfpOpenedAt: then(15, 600) });
  const never = await addMember(oid(acme.organizationId), "planner");
  const rejoined = await addMember(oid(acme.organizationId), "planner", { firstRfpOpenedAt: then(400) });

  await invite(acme.organizationId, { createdAt: then(20), status: "accepted", acceptedAt: then(18), acceptedBy: fast });           // 2 days
  await invite(other.organizationId, { createdAt: then(25), status: "accepted", acceptedAt: then(15), acceptedBy: slow });         // 10 days: late
  await invite(acme.organizationId, { createdAt: then(12), status: "accepted", acceptedAt: then(11), acceptedBy: never });
  // Removed and invited again: two acceptances, one membership whose first open predates both.
  await invite(acme.organizationId, { createdAt: then(29), status: "accepted", acceptedAt: then(28), acceptedBy: rejoined });
  await invite(acme.organizationId, { createdAt: then(10), status: "accepted", acceptedAt: then(9), acceptedBy: rejoined });
  await invite(acme.organizationId, { createdAt: then(14), status: "revoked" });
  await invite(other.organizationId, { createdAt: then(9), status: "expired" });
  await invite(acme.organizationId, { createdAt: then(3), status: "pending" });                                                     // too recent to judge
  await invite(acme.organizationId, { createdAt: then(40), status: "accepted", acceptedAt: then(39), acceptedBy: oid() });         // before both windows

  const report = await launchMetricsReport(mongoLaunchMetricsSource, { days: 30, now: THEN });
  // The cohort is invitations created 37 to 7 days before: the one from 3 days before isn't in it yet.
  assert.deepEqual(report.inviteAcceptance, { sent: 7, atLeast7DaysOld: 7, acceptedWithin7Days: 4, acceptedLater: 1, rate: 0.5714, target: 0.6 });
  assert.deepEqual(report.timeToFirstRfpOpened, {
    accepted: 4, opened: 2, notYetOpened: 1, excludedOpenedBeforeAccepting: 1, excludedAcceptedBeforeTracking: 0,
    medianSeconds: 360, openedWithin5Minutes: 1, targetMedianSeconds: 300,
  });
});

test("support reads are checked against the grant each one names", async () => {
  const acmeId = oid(acme.organizationId);
  const otherId = oid(other.organizationId);
  const grant = async (organizationId: mongoose.Types.ObjectId, fields: Record<string, unknown> = {}) =>
    (await SupportAccessGrant.collection.insertOne({ organizationId, proposalId: null, grantedBy: oid(acme.members.owner.userId), reason: null, createdAt: then(10), updatedAt: then(10), expiresAt: then(3), revokedAt: null, revokedBy: null, ...fields })).insertedId;
  const active = await grant(acmeId);
  const revoked = await grant(acmeId, { revokedAt: then(8), revokedBy: oid(acme.members.owner.userId) });
  const foreign = await grant(otherId);
  const rfpId = oid();
  const forOneRfp = await grant(acmeId, { proposalId: rfpId });
  const event = (organizationId: mongoose.Types.ObjectId, action: string, at: Date, metadata: Record<string, unknown>, reason = "rfp.read", target: { type: string; id: string } = { type: "organization", id: String(organizationId) }) =>
    SecurityAuditEvent.collection.insertOne({ organizationId, actorUserId: dxg.agent, action, targetType: target.type, targetId: target.id, decision: action.endsWith("used") ? "allowed" : "denied", reason, correlationId: randomMongoId(), metadata, createdAt: at });

  await event(acmeId, "support_access.used", then(9), { grantId: String(active) });
  await event(acmeId, "support_access.used", then(5), { grantId: String(active) });
  await event(acmeId, "support_access.used", then(2), { grantId: String(active) });        // after it expired
  await event(acmeId, "support_access.used", then(7), { grantId: String(revoked) });       // after it was revoked
  await event(acmeId, "support_access.used", then(6), { grantId: String(foreign) });       // another organization's grant
  await event(acmeId, "support_access.used", then(6), {});                                 // names no grant
  await event(acmeId, "support_access.used", then(6), { grantId: "not-an-id" });
  await event(acmeId, "support_access.used", then(45), { grantId: String(active) });       // before the window
  await event(acmeId, "support_access.used", then(6), { grantId: String(forOneRfp) }, "rfp.read", { type: "proposal", id: String(rfpId) });
  await event(acmeId, "support_access.used", then(6), { grantId: String(forOneRfp) }, "rfp.read", { type: "proposal", id: String(oid()) });   // a grant for a different RFP
  await event(acmeId, "support_access.denied", then(4), { operation: "rfp.list" }, "no_active_grant");
  await event(otherId, "support_access.denied", then(4), { operation: "rfp.list" }, "no_active_grant");

  const report = await launchMetricsReport(mongoLaunchMetricsSource, { days: 30, now: THEN });
  assert.deepEqual(report.supportAccessUnderGrant, { reads: 9, underActiveGrant: 3, withoutActiveGrant: 6, refusedWithoutGrant: 2, rate: 0.3333, target: 1 });
});

test("organizations with 2+ active users leaves out holding tenants, inactive organizations and staff", async () => {
  const before = (await metrics()).organizationsWithTwoOrMoreActiveUsers;

  const solo = await addOrganization();
  await addMember(solo, "owner");
  await addMember(solo, "planner", { status: "suspended" });
  await addMember(solo, "planner", { status: "invited" });
  const pair = await addOrganization();
  await addMember(pair, "owner");
  await addMember(pair, "viewer");
  const holding = await addOrganization({ kind: "legacy_holding" });
  await addMember(holding, "owner");
  await addMember(holding, "planner");
  const inactive = await addOrganization({ status: "inactive" });
  await addMember(inactive, "owner");
  await addMember(inactive, "planner");
  const staffOnly = await addOrganization();
  await addMember(staffOnly, "dxg_admin");
  await addMember(staffOnly, "super_admin");

  const after = (await metrics()).organizationsWithTwoOrMoreActiveUsers;
  assert.equal(after.organizations - before.organizations, 2);
  assert.equal(after.withTwoOrMoreActiveUsers - before.withTwoOrMoreActiveUsers, 1);
  assert.equal(after.rate, Math.round((after.withTwoOrMoreActiveUsers / after.organizations) * 10_000) / 10_000);
});

test("orphaned RFPs are counted by the same check the nightly job runs", async () => {
  const before = (await metrics()).orphanedRfps;
  const organization = await addOrganization();
  const owner = await addMember(organization, "owner");
  const leaver = await addMember(organization, "planner", { status: "removed" });
  await createProposals(String(organization), String(owner), 1);
  await createProposals(String(organization), String(leaver), 2);
  const after = (await metrics()).orphanedRfps;
  assert.equal(after.total - before.total, 2);
  assert.equal(after.organizations - before.organizations, 1);
  assert.equal(after.target, 0);
});

test("a member opening an RFP is stamped once, and it reaches the metric", async () => {
  const organizationId = oid(acme.organizationId);
  const before = (await metrics()).timeToFirstRfpOpened;
  const invitee = await addMember(organizationId, "planner");
  const acceptedAt = new Date(Date.now() - 90_000);
  await invite(organizationId, { createdAt: new Date(Date.now() - DAY), status: "accepted", acceptedAt, acceptedBy: invitee });
  const [rfp] = await createProposals(acme.organizationId, String(invitee), 1);
  const token = await sessionFor(invitee, organizationId);
  const membership = () => OrganizationMembership.findOne({ organizationId, userId: invitee }).lean();

  // An RFP in another organization reads as missing and is not an "open".
  const [foreignRfp] = await createProposals(other.organizationId, other.members.planner.userId, 1);
  assert.equal((await call(token, `/api/proposals/${foreignRfp}`)).status, 404);
  assert.equal((await membership())!.firstRfpOpenedAt ?? null, null);

  const started = Date.now();
  assert.equal((await call(token, `/api/proposals/${rfp}`)).status, 200);
  let stamped = await membership();
  for (let attempt = 0; attempt < 40 && !stamped?.firstRfpOpenedAt; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    stamped = await membership();
  }
  const first = stamped!.firstRfpOpenedAt!;
  assert.ok(first.getTime() >= started - 1000 && first.getTime() <= Date.now() + 1000);
  assert.equal(stamped!.version, 1);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await call(token, `/api/proposals/${rfp}`)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await membership())!.firstRfpOpenedAt!.getTime(), first.getTime());

  const after = (await metrics()).timeToFirstRfpOpened;
  assert.equal(after.accepted - before.accepted, 1);
  assert.equal(after.opened - before.opened, 1);
  assert.equal(after.notYetOpened - before.notYetOpened, 0);
  assert.equal(after.openedWithin5Minutes - before.openedWithin5Minutes, 1);
});

test("a removed member who is invited back is timed from the new acceptance", async () => {
  const organizationId = oid(acme.organizationId);
  const longAgo = new Date(Date.now() - 200 * DAY);
  const returning = await addMember(organizationId, "planner", { status: "removed", removedAt: new Date(Date.now() - DAY), firstRfpOpenedAt: longAgo });
  const email = (await User.findById(returning).select("email").lean())!.email;
  const tokenHash = `metrics-${randomMongoId()}`;
  const { insertedId } = await invite(organizationId, { email, tokenHash });

  const now = new Date();
  const joined = await createMongoInvitationAcceptance().joinExistingAccount({ invitationId: String(insertedId), tokenHash, userId: String(returning), now });
  assert.deepEqual(joined, { kind: "joined", userId: String(returning), placedInTeam: false });
  const membership = () => OrganizationMembership.findOne({ organizationId, userId: returning }).lean();
  const rejoined = await membership();
  assert.equal(rejoined!.status, "active");
  assert.equal(rejoined!.firstRfpOpenedAt, null);

  const [rfp] = await createProposals(acme.organizationId, String(returning), 1);
  assert.equal((await call(await sessionFor(returning, organizationId), `/api/proposals/${rfp}`)).status, 200);
  let stamped = await membership();
  for (let attempt = 0; attempt < 40 && !stamped?.firstRfpOpenedAt; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    stamped = await membership();
  }
  assert.ok(stamped!.firstRfpOpenedAt!.getTime() >= now.getTime() - 1000, "the first open after rejoining is recorded");
});
