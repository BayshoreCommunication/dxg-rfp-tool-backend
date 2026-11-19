// Fix round on the staff organization block (PR #151). Through the real API on real MongoDB.
//
// Two customer organizations with the same name, C and D, each with its own DNS-verified domain.
// The same dead credentials are prepared in both, then staff block C. D is the control: what C
// answers to a dead credential, and to a sign-up on its domain, must be what D answers.
//
// F5: a dead credential (removed member, logged-out session, consumed refresh token) gets from C
//     what it gets from D and does not learn of the block; a live member is told.
// F6: C's domain still matches (verify-otp, register); an access request waits as pending with no
//     invitation and no notification, and is listed and approved after the reactivation.
// F9: an organization that carries the marker is reactivated after it stopped being manageable.
// F2: the three limited sweeps leave out a blocked organization's rows in the query.
// F8: the dispatcher's reconcile query leaves out the queued jobs of the organizations it is given.
import { TEST_MONGODB_DB_NAME } from "./env";
import { connectMongo, disconnectMongo, ensureMigrated, ensureServices, randomMongoId, seedTenant } from "./setup";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import http from "node:http";
import mongoose from "mongoose";
import app from "../server";
import AccessRequest from "../modal/accessRequestModel";
import Admin from "../modal/adminModel";
import Invitation from "../modal/invitationModel";
import Notification from "../modal/notificationModel";
import Organization from "../modal/organizationModel";
import OrganizationDomain from "../modal/organizationDomainModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import Otp from "../modal/otpModel";
import RefreshSession from "../modal/refreshSessionModel";
import SecurityAuditEvent from "../modal/securityAuditEventModel";
import SupportTicket from "../modal/supportTicketModel";
import User from "../modal/userModel";
import VendorSubmissionDraft from "../modal/vendorSubmissionDraftModel";
import { authenticationSessions, beginAuthenticatedSession } from "../src/modules/auth/composition";
import { durableJobRepository } from "../src/modules/durableJobs/composition";
import { closeQueue } from "../src/modules/durableJobs/queue";
import { contextInput } from "../src/modules/proposalContext/domain";
import { proposalContextRepository } from "../src/modules/proposalContext/postgresProposalContextRepository";
import { hmacOtpCodeHasher } from "../src/modules/auth/infrastructure/security/hmacOtpCodeHasher";
import { mongoDomainRepository } from "../src/modules/domainVerification/infrastructure/mongo/mongoDomainRepository";
import { ORGANIZATION_BLOCK_REVOKE_REASON, isOrganizationBlocked } from "../src/modules/organizationBlock/domain";
import { blockedOrganizationIds } from "../src/modules/organizationBlock/organizationBlockGate";
import { mongoSupportDeskRepository } from "../src/modules/supportDesk/infrastructure/mongo/mongoSupportDeskRepository";
import { mongoVendorSubmissionDraftRepository } from "../src/modules/vendorResponses/infrastructure/mongo/mongoVendorSubmissionDraftRepository";
import { closePostgres } from "../config/postgres";
import { closeSecurityRateLimitRedis } from "../middleware/securityRateLimit";
import { closeSupportRedis } from "../src/modules/supportDesk/infrastructure/redis/supportRedis";
import { cleanupOrganizations, seedOrganization, signIn, type Fixture, type Role } from "./memberFixtures";

const tag = randomMongoId().slice(0, 8);
const oid = (value?: string) => new mongoose.Types.ObjectId(value);
const BASE = "/api/v1/admin/organizations";
const REASON = `Fix round, ticket ${tag}`;
const REFRESH_COOKIE = "rfpilot_refresh";
const NAME = `Twin Events ${tag}`;
const domains = { c: `blkc${tag}.example.org`, d: `blkd${tag}.example.org` };

let server: http.Server;
let baseUrl: string;
let c: Fixture;
let d: Fixture;
let e: Fixture;
let f: Fixture;
let staffToken: string;
let blockedAt: Date;
const dxg = { org: oid(), staff: oid() };
const lateAdmin = oid();
const emails: string[] = [];
const consumed: Record<"c" | "d", string> = { c: "", d: "" };
const rawOrganizations = [oid(), oid()];

type Answer = { status: number; body: Record<string, any>; text: string };
const send = async (method: string, path: string, options: { token?: string; body?: unknown; cookie?: string } = {}): Promise<Answer> => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
  });
  const text = await res.text();
  let body: Record<string, any> = {};
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body, text };
};
const asStaff = async (method: string, path: string, body?: unknown) => {
  const res = await send(method, path, { token: staffToken, body });
  assert.notEqual(res.status, 429, `rate limited: ${method} ${path}`);
  return res;
};
const me = (token: string) => send("GET", "/api/auth/me", { token });
const refresh = (refreshToken: string) => send("POST", "/api/auth/refresh", { cookie: `${REFRESH_COOKIE}=${encodeURIComponent(refreshToken)}` });
const address = (local: string, which: "c" | "d") => {
  const email = `${local}-${randomMongoId().slice(0, 6)}@${domains[which]}`;
  emails.push(email);
  return email;
};
// What the signup code step leaves behind.
const verifiedSignupEmail = (email: string) =>
  Otp.create({ email, type: "signup", codeHash: "x".repeat(64), verified: true, attempts: 0, maxAttempts: 5, expiresAt: new Date(Date.now() + 600_000) });
// The customer audit rows of an organization written since staff blocked C, by action.
const rowsSince = async (organizationId: string) =>
  (await SecurityAuditEvent.find({ organizationId: oid(organizationId), createdAt: { $gte: blockedAt } }).lean()).map((row: any) => String(row.action)).sort();
const marker = async (organizationId: string) => (await Organization.collection.findOne({ _id: oid(organizationId) })) as Record<string, any>;

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  await Promise.all([User.init(), Organization.init(), OrganizationMembership.init(), Invitation.init(), AccessRequest.init(), Otp.init()]);

  c = await seedOrganization(NAME);
  d = await seedOrganization(NAME);
  e = await seedOrganization(`Became Holding ${tag}`);
  f = await seedOrganization(`Got Staff Account ${tag}`);
  await Organization.updateOne({ _id: c.organizationId }, { $set: { verifiedDomains: [domains.c], autoApproveDomain: true } });
  await Organization.updateOne({ _id: d.organizationId }, { $set: { verifiedDomains: [domains.d], autoApproveDomain: true } });

  await Organization.collection.insertOne({ _id: dxg.org, name: `RFPilot ${tag}`, slug: `intg-members-dxg-${tag}`, status: "active", kind: "customer", plan: "free_trial" });
  await Admin.collection.insertOne({ _id: dxg.staff, organizationId: dxg.org, name: "Dana Staff", email: `admin-fix-${tag}@example.com`, password: "not-a-real-hash", role: "admin", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: dxg.staff, roles: ["dxg_admin"], status: "active", version: 1 });
  staffToken = (await beginAuthenticatedSession({ userId: String(dxg.staff), organizationId: String(dxg.org), correlationId: randomMongoId() })).accessToken;

  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    const fixtures = [c, d, e, f].filter(Boolean).map((fixture) => oid(fixture.organizationId));
    const orgIds = [dxg.org, ...fixtures, ...rawOrganizations];
    await mongoose.connection.db!.collection("securityauditevents").deleteMany({ organizationId: { $in: orgIds } });
    await Promise.all([
      AccessRequest.deleteMany({ organizationId: { $in: orgIds } }),
      Invitation.deleteMany({ organizationId: { $in: orgIds } }),
      Notification.deleteMany({ type: "access_request", "metadata.organizationId": { $in: fixtures.map(String) } }),
      Otp.deleteMany({ email: { $in: emails } }),
      RefreshSession.deleteMany({ organizationId: { $in: orgIds } }),
      OrganizationDomain.collection.deleteMany({ organizationId: { $in: rawOrganizations } }),
      SupportTicket.collection.deleteMany({ organizationId: { $in: rawOrganizations } }),
      VendorSubmissionDraft.collection.deleteMany({ organizationId: { $in: rawOrganizations } }),
    ]);
    const created = await User.find({ email: { $in: emails } }).select("organizationId").lean();
    await OrganizationMembership.collection.deleteMany({ organizationId: { $in: [dxg.org, ...created.map((user) => user.organizationId)] } });
    await Organization.deleteMany({ _id: { $in: created.map((user) => user.organizationId) }, slug: { $not: /^intg-members-/ } });
    await User.deleteMany({ email: { $in: emails } });
    await Admin.collection.deleteMany({ _id: { $in: [dxg.staff, lateAdmin] } });
    await Organization.collection.deleteMany({ _id: dxg.org });
    // E was turned into a holding tenant; it keeps the fixture slug, so the shared cleanup removes it.
    await cleanupOrganizations();
  }
  await disconnectMongo();
  await closeQueue();
  await closePostgres();
  await closeSecurityRateLimitRedis();
  await closeSupportRedis();
});

test("set-up: the same dead credentials in C and in D, then staff block C", async () => {
  for (const [which, fixture] of [["c", c], ["d", d]] as const) {
    // A consumed refresh token: the team manager's session rotated once.
    const rotated = await refresh(fixture.members.team_manager.refreshToken);
    assert.equal(rotated.status, 200, rotated.text);
    consumed[which] = fixture.members.team_manager.refreshToken;
    // A logged-out session: the planner's.
    await authenticationSessions.revokeSession({ userId: fixture.members.planner.userId, organizationId: fixture.organizationId, sessionId: fixture.members.planner.sessionId, correlationId: randomMongoId() });
    // A removed member who still holds an unexpired access token: the viewer.
    await OrganizationMembership.deleteOne({ organizationId: fixture.organizationId, userId: fixture.members.viewer.userId });
  }
  const blocked = await asStaff("POST", `${BASE}/${c.organizationId}/block`, { reason: REASON });
  assert.equal(blocked.status, 200, blocked.text);
  blockedAt = new Date(blocked.body.data.blockedAt);
  assert.equal(isOrganizationBlocked(await marker(c.organizationId)), true);
  assert.equal(isOrganizationBlocked(await marker(d.organizationId)), false);
});

test("F5: a dead credential gets from blocked C exactly what it gets from D, and C's audit trail gets no row D's does not", async () => {
  const dead: Array<[string, (fixture: Fixture, which: "c" | "d") => Promise<Answer>]> = [
    ["a removed member's access token", (fixture) => me(fixture.members.viewer.accessToken)],
    ["a logged-out session's access token", (fixture) => me(fixture.members.planner.accessToken)],
    ["a logged-out session's refresh token", (fixture) => refresh(fixture.members.planner.refreshToken)],
    ["a consumed refresh token", (_fixture, which) => refresh(consumed[which])],
    ["a refresh token that was never issued", () => refresh("never-issued-token")],
  ];
  const expected: Record<string, [number, string]> = {
    "a removed member's access token": [401, "MEMBERSHIP_INACTIVE"],
    "a logged-out session's access token": [403, "Active organization membership required"],
    "a logged-out session's refresh token": [401, "reuse_detected"],
    "a consumed refresh token": [401, "reuse_detected"],
    "a refresh token that was never issued": [401, "invalid"],
  };
  for (const [name, present] of dead) {
    const fromC = await present(c, "c");
    const fromD = await present(d, "d");
    assert.deepEqual([fromC.status, fromC.body], [fromD.status, fromD.body], `${name}: status and body are D's`);
    assert.deepEqual([fromC.status, fromC.body.reason ?? fromC.body.code ?? fromC.body.message], expected[name], name);
    assert.doesNotMatch(fromC.text, /ORGANIZATION_BLOCKED|organization_blocked|paused/, `${name} does not learn of the block`);
  }
  // Customer audit rows written by those requests. Every row in C is one D got too (the reuse of
  // a logged-out and of a consumed token, as on main). D has one more: the removed member's
  // still-live session being ended. In C the block had already ended it, so there is nothing to
  // end and no row. The block caused no row in C.
  const inC = await rowsSince(c.organizationId);
  const inD = await rowsSince(d.organizationId);
  assert.deepEqual(inC, ["auth.refresh.reuse_detected", "auth.refresh.reuse_detected"]);
  assert.deepEqual(inD, ["auth.refresh.reuse_detected", "auth.refresh.reuse_detected", "auth.sessions.revoked_all"]);
  // The block's reason on the sessions it ended is not overwritten by the dead credentials.
  assert.equal((await RefreshSession.findOne({ sessionId: c.members.viewer.sessionId }).lean())?.revokeReason, ORGANIZATION_BLOCK_REVOKE_REASON);
});

test("F5: a live member of blocked C is told, on a request and on refresh, and no row is written in C", async () => {
  const before_ = await rowsSince(c.organizationId);
  for (const role of ["owner", "organization_admin"] as const) {
    const refused = await me(c.members[role].accessToken);
    assert.deepEqual([refused.status, refused.body.code], [401, "ORGANIZATION_BLOCKED"], `${role}: ${refused.text}`);
    const refreshed = await refresh(c.members[role].refreshToken);
    assert.deepEqual([refreshed.status, refreshed.body.reason], [401, "organization_blocked"], `${role}: ${refreshed.text}`);
  }
  assert.deepEqual(await rowsSince(c.organizationId), before_);
  assert.equal((await me(d.members.owner.accessToken)).status, 200);
});

test("F6: blocked C's domain matches exactly as D's does at verify-otp and register; choosing a separate organization still works", async () => {
  const codeFor = async (email: string) => {
    await Otp.create({ email, type: "signup", codeHash: hmacOtpCodeHasher.hash("482913"), verified: false, attempts: 0, maxAttempts: 5, expiresAt: new Date(Date.now() + 600_000) });
    return send("POST", "/api/auth/verify-otp", { body: { email, otp: "482913" } });
  };
  const [matchC, matchD] = [await codeFor(address("code", "c")), await codeFor(address("code", "d"))];
  assert.deepEqual([matchC.status, matchC.body], [matchD.status, matchD.body]);
  assert.deepEqual([matchC.status, matchC.body.organizationMatch], [200, { name: NAME }]);

  const register = async (which: "c" | "d", extra: Record<string, unknown> = {}) => {
    const email = address("signup", which);
    await verifiedSignupEmail(email);
    return { email, answer: await send("POST", "/api/auth/register", { body: { name: "New Person", email, password: "long-enough-pass", ...extra } }) };
  };
  const [refusedC, refusedD] = [await register("c"), await register("d")];
  assert.deepEqual([refusedC.answer.status, refusedC.answer.body], [refusedD.answer.status, refusedD.answer.body]);
  assert.deepEqual([refusedC.answer.status, refusedC.answer.body.code, refusedC.answer.body.organizationName], [409, "ORGANIZATION_DOMAIN_MATCH", NAME]);
  assert.equal(await User.exists({ email: refusedC.email }), null, "no account and no separate organization was created");
  assert.doesNotMatch(`${matchC.text}${refusedC.answer.text}`, /block|paus/i);

  // The person's own explicit choice stays available, as it is without a block.
  const separate = await register("c", { separateOrganization: true });
  assert.equal(separate.answer.status, 201, separate.answer.text);
  const created = await User.findOne({ email: separate.email }).lean();
  assert.ok(created?.organizationId);
  assert.notEqual(String(created?.organizationId), c.organizationId, "their own organization, not the blocked one");
  assert.equal(isOrganizationBlocked(await marker(String(created?.organizationId))), false);
});

test("F6: an access request for blocked C answers 201 pending, creates no invitation even with auto-approve on, and notifies nobody; D answers as always", async () => {
  const eventsBefore = await rowsSince(c.organizationId);
  const request = async (which: "c" | "d") => {
    const email = address("request", which);
    await verifiedSignupEmail(email);
    return { email, answer: await send("POST", "/api/auth/access-requests", { body: { email, name: "Asking Person" } }) };
  };
  // Auto-approve is on in both: the one accepted difference, `pending` in place of `invited`.
  const [autoC, autoD] = [await request("c"), await request("d")];
  assert.deepEqual([autoC.answer.status, autoC.answer.body], [201, { success: true, status: "pending", organizationName: NAME }]);
  assert.deepEqual([autoD.answer.status, autoD.answer.body], [201, { success: true, status: "invited", organizationName: NAME }]);
  assert.equal(await Invitation.exists({ organizationId: c.organizationId }), null, "nothing was created in, or sent into, the blocked organization");
  assert.notEqual(await Invitation.exists({ organizationId: d.organizationId, email: autoD.email }), null);

  // Auto-approve off in both: status and body are identical.
  await Organization.updateMany({ _id: { $in: [c.organizationId, d.organizationId] } }, { $set: { autoApproveDomain: false } });
  const [manualC, manualD] = [await request("c"), await request("d")];
  assert.deepEqual([manualC.answer.status, manualC.answer.body], [manualD.answer.status, manualD.answer.body]);
  assert.deepEqual([manualC.answer.status, manualC.answer.body.status], [201, "pending"]);
  await Organization.updateMany({ _id: { $in: [c.organizationId, d.organizationId] } }, { $set: { autoApproveDomain: true } });

  assert.deepEqual((await AccessRequest.find({ organizationId: c.organizationId }).sort({ createdAt: 1 }).lean()).map((row) => [row.email, row.status, row.autoApproved === true]), [[autoC.email, "pending", false], [manualC.email, "pending", false]]);
  assert.equal(await Invitation.exists({ organizationId: c.organizationId }), null);
  assert.equal(await Notification.countDocuments({ type: "access_request", "metadata.organizationId": c.organizationId }), 0, "C's Owners and Admins get no notification while it is blocked");
  assert.ok((await Notification.countDocuments({ type: "access_request", "metadata.organizationId": d.organizationId })) >= 2, "D's Owner and Admin were notified of the request they must decide");
  assert.equal(await User.exists({ email: { $in: [autoC.email, manualC.email] } }), null);
  // The only rows in C are the requesters' own, the ones main writes for a pending request.
  assert.deepEqual((await rowsSince(c.organizationId)).filter((action) => !eventsBefore.includes(action)), ["organization.access_request.created", "organization.access_request.created"]);
  assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: oid(c.organizationId), action: { $regex: /^platform\./ } }), 0);
});

test("F6: after the reactivation the requests are in C's list and are approved by an Owner; no late notification, no late auto-approve", async () => {
  const reactivated = await asStaff("POST", `${BASE}/${c.organizationId}/reactivate`, { reason: REASON });
  assert.deepEqual([reactivated.status, reactivated.body.data.changed, reactivated.body.data.blocked], [200, true, false]);
  const owner = await signIn(c.organizationId, c.members.owner.userId, c.members.owner.email);
  const listed = await send("GET", "/api/v1/organization/access-requests", { token: owner.accessToken });
  assert.equal(listed.status, 200, listed.text);
  const pending = listed.body.data as Array<{ id: string; email: string; status: string }>;
  assert.equal(pending.length, 2);
  assert.ok(pending.every((row) => row.status === "pending" && row.email.endsWith(`@${domains.c}`)));
  assert.equal(await Notification.countDocuments({ type: "access_request", "metadata.organizationId": c.organizationId }), 0, "it appears in the list; no notification is sent late");
  assert.equal(await Invitation.exists({ organizationId: c.organizationId }), null, "auto-approve is not applied afterwards: an Owner or Admin decides");

  const approved = await send("POST", `/api/v1/organization/access-requests/${pending[0].id}/approve`, { token: owner.accessToken, body: {} });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.body.data.status, "approved");
  assert.equal((await Invitation.findOne({ organizationId: c.organizationId, email: pending[0].email }).lean())?.status, "pending");
  const denied = await send("POST", `/api/v1/organization/access-requests/${pending[1].id}/deny`, { token: owner.accessToken, body: {} });
  assert.deepEqual([denied.status, denied.body.data.status], [200, "denied"]);
});

test("F9: an organization blocked as a customer organization and made unmanageable since is reactivated through the route; it cannot be blocked again", async () => {
  for (const fixture of [e, f]) {
    const blocked = await asStaff("POST", `${BASE}/${fixture.organizationId}/block`, { reason: REASON });
    assert.equal(blocked.status, 200, blocked.text);
  }
  // E changes kind; F gets an `admins` account.
  await Organization.collection.updateOne({ _id: oid(e.organizationId) }, { $set: { kind: "legacy_holding" } });
  await Admin.collection.insertOne({ _id: lateAdmin, organizationId: oid(f.organizationId), name: "Late Staff", email: `late-admin-${tag}@example.com`, password: "not-a-real-hash", role: "admin", isBlocked: false });

  for (const [fixture, standing] of [[e, "legacy_holding"], [f, "platform"]] as const) {
    assert.equal(isOrganizationBlocked(await marker(fixture.organizationId)), true);
    // Still a reason, still staff only.
    assert.equal((await asStaff("POST", `${BASE}/${fixture.organizationId}/reactivate`, {})).body.code, "INVALID_REASON");
    assert.equal((await send("POST", `${BASE}/${fixture.organizationId}/reactivate`, { token: d.members.owner.accessToken, body: { reason: REASON } })).status, 403);
    assert.equal(isOrganizationBlocked(await marker(fixture.organizationId)), true);

    const reactivated = await asStaff("POST", `${BASE}/${fixture.organizationId}/reactivate`, { reason: REASON });
    assert.equal(reactivated.status, 200, reactivated.text);
    assert.deepEqual(reactivated.body.data, { organizationId: fixture.organizationId, changed: true, blocked: false, blockedAt: null });
    assert.equal("blocked" in (await marker(fixture.organizationId)), false, "the marker is removed");
    const event = await SecurityAuditEvent.findOne({ organizationId: dxg.org, action: "platform.organization.reactivated", targetId: fixture.organizationId, decision: "allowed" }).lean() as Record<string, any> | null;
    assert.deepEqual([event?.reason, event?.metadata?.staffReason, event?.metadata?.standing], ["organization_reactivated", REASON, standing], "recorded on the staff side, with the standing");
    assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: oid(fixture.organizationId), action: { $regex: /^platform\./ } }), 0);

    // With the marker gone the full rule applies to both writes again.
    for (const action of ["block", "reactivate"]) {
      const refused = await asStaff("POST", `${BASE}/${fixture.organizationId}/${action}`, { reason: REASON });
      assert.deepEqual([refused.status, refused.body.code, refused.body.standing], [409, "ORGANIZATION_NOT_MANAGEABLE", standing], `${action}: ${refused.text}`);
    }
    assert.equal("blocked" in (await marker(fixture.organizationId)), false);
  }
  assert.equal((await blockedOrganizationIds()).has(e.organizationId), false);
});

test("F2: each limited sweep query leaves out a blocked organization's rows, so a batch full of them does not hide another organization's row", async () => {
  const LIMIT = 3;
  const [held, other] = rawOrganizations;
  const now = new Date(10_000);
  const at = (index: number) => new Date(1_000 + index);
  // In every collection: LIMIT rows of the held organization, older than one row of the other.
  await OrganizationDomain.collection.insertMany([
    ...Array.from({ length: LIMIT }, (_, i) => ({ organizationId: held, domain: `held${i}-${tag}.example.org`, status: "pending", verificationToken: "t", nextCheckAt: at(i), createdAt: at(i) })),
    { organizationId: other, domain: `other-${tag}.example.org`, status: "pending", verificationToken: "t", nextCheckAt: at(LIMIT), createdAt: at(LIMIT) },
  ]);
  const ticket = (organizationId: mongoose.Types.ObjectId, i: number, status: string, extra: Record<string, unknown>) =>
    ({ organizationId, ticketNumber: i + 1, requesterUserId: oid(), subject: "Help", category: "other", priority: "normal", status, createdAt: at(i), updatedAt: at(i), ...extra });
  await SupportTicket.collection.insertMany([
    ...Array.from({ length: LIMIT }, (_, i) => ticket(held, i, "waiting_on_customer", { waitingSince: at(i), autoCloseReminderSentAt: null })),
    ticket(other, LIMIT, "waiting_on_customer", { waitingSince: at(LIMIT), autoCloseReminderSentAt: null }),
    ...Array.from({ length: LIMIT }, (_, i) => ticket(held, 10 + i, "waiting_on_customer", { waitingSince: at(i), autoCloseReminderSentAt: at(i) })),
    ticket(other, 10 + LIMIT, "waiting_on_customer", { waitingSince: at(LIMIT), autoCloseReminderSentAt: at(LIMIT) }),
    ...Array.from({ length: LIMIT }, (_, i) => ticket(held, 20 + i, "resolved", { resolvedAt: at(i) })),
    ticket(other, 20 + LIMIT, "resolved", { resolvedAt: at(LIMIT) }),
  ]);
  const draft = (organizationId: mongoose.Types.ObjectId, i: number) =>
    ({ organizationId, proposalId: oid(), grantId: oid(), grantSubjectHash: "h".repeat(64), documents: [], draftRevision: 1, status: "abandoned", cleanupCompletedAt: null, lastSavedAt: at(i), expiresAt: at(i), createdAt: at(i), updatedAt: at(i) });
  await VendorSubmissionDraft.collection.insertMany([...Array.from({ length: LIMIT }, (_, i) => draft(held, i)), draft(other, LIMIT)]);

  const except = [String(held)];
  const sweeps: Array<[string, (exceptOrganizationIds?: string[]) => Promise<Array<{ organizationId: string }>>]> = [
    ["domain re-check", (ids) => mongoDomainRepository.due(now, LIMIT, ids)],
    ["support close reminder", (ids) => mongoSupportDeskRepository.listNeedingCloseReminder(now, LIMIT, ids)],
    ["support auto-resolve", (ids) => mongoSupportDeskRepository.listDueToAutoResolve(now, now, LIMIT, ids)],
    ["support close", (ids) => mongoSupportDeskRepository.listResolvedBefore(now, LIMIT, ids)],
    ["vendor draft cleanup", (ids) => mongoVendorSubmissionDraftRepository.listCleanupCandidates(now, LIMIT, ids)],
  ];
  for (const [name, list] of sweeps) {
    // Without the exclusion the oldest-first batch is the held organization's rows and nothing else.
    const starved = await list();
    assert.deepEqual(starved.map((row) => row.organizationId), Array(LIMIT).fill(String(held)), `${name}: the batch is full of the held organization's rows`);
    const reached = await list(except);
    assert.equal(reached.some((row) => row.organizationId === String(held)), false, `${name}: none of the held organization's rows`);
    assert.equal(reached[0]?.organizationId, String(other), `${name}: the other organization's row is reached`);
  }
});

test("F8: reconcile on real PostgreSQL leaves out the queued jobs of the organizations it is told to, and only those", async () => {
  const [held, other] = [await seedTenant("Reconcile Held Org"), await seedTenant("Reconcile Other Org")];
  const jobOf = async (tenant: typeof held) => {
    const created = await proposalContextRepository.create({
      organizationMongoId: tenant.organizationMongoId, actorUserMongoId: tenant.actorUserMongoId, proposalMongoId: tenant.proposalMongoId,
      ...contextInput({ fixture: "synthetic-conference-simple" }), idempotencyKey: randomMongoId(), correlationId: randomMongoId(),
    });
    return String(created.job.id);
  };
  const [heldJob, otherJob] = [await jobOf(held), await jobOf(other)];
  const ALL = 100_000; // the shared database holds other suites' queued jobs; these two are the newest
  const everything = (await durableJobRepository.reconcile(ALL)).map((message) => message.jobId);
  assert.ok(everything.includes(heldJob) && everything.includes(otherJob), "with no ids the statement is the one it always was");
  const without = await durableJobRepository.reconcile(ALL, [held.organizationMongoId, "not-an-id", randomMongoId()]);
  assert.equal(without.some((message) => message.organizationMongoId === held.organizationMongoId), false, "none of the held organization's jobs");
  assert.ok(without.map((message) => message.jobId).includes(otherJob), "the other organization's job is still reconciled");
  const kept = new Set(without.map((message) => message.jobId));
  assert.deepEqual(everything.filter((id) => !kept.has(id)), [heldJob], "nothing else is left out");
  assert.ok((await durableJobRepository.reconcile(ALL, [])).some((message) => message.jobId === heldJob), "an empty list leaves nothing out");
});
