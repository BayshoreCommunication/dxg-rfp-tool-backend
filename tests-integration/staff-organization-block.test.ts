// Owner decision 2026-11-18 (docs/DECISIONS.md): RFPilot staff block a whole customer organization
// and reactivate it. Through the real API on real MongoDB: two customer organizations (A and B),
// the staff organization and a legacy holding tenant.
//
// Block A: its members are refused on an authenticated request, on refresh and at password
// sign-in; a person who also has a membership in B still works in B; A's vendor link, shared
// proposal link and invitation link answer exactly as an unknown link does; a queued job of A is
// deferred, not run; B is untouched; staff reads and staff member management on A keep working.
// Nothing is written to A's audit trail by any of it, and A's own audit endpoints (list, filters,
// CSV, read after reactivation) show no trace. Reactivate A: everything works again and nothing
// was lost. The staff organization and the holding tenant can never be blocked.
import { TEST_MONGODB_DB_NAME } from "./env";
import { connectMongo, disconnectMongo, ensureMigrated, ensureServices, randomMongoId } from "./setup";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import http from "node:http";
import mongoose from "mongoose";
import { DelayedError } from "bullmq";
import app from "../server";
import Admin from "../modal/adminModel";
import Invitation from "../modal/invitationModel";
import Organization from "../modal/organizationModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import Proposal from "../modal/proposalsModel";
import PublicAccessGrant from "../modal/publicAccessGrantModel";
import RefreshSession from "../modal/refreshSessionModel";
import SecurityAuditEvent from "../modal/securityAuditEventModel";
import User from "../modal/userModel";
import { beginAuthenticatedSession } from "../src/modules/auth/composition";
import { deferJobOfBlockedOrganization } from "../src/modules/durableJobs/organizationBlockDeferral";
import { generateInvitationToken, hashInvitationToken } from "../src/modules/invitations/domain/invitationRules";
import { ORGANIZATION_BLOCK_REVOKE_REASON, OrganizationBlockedError, isOrganizationBlocked } from "../src/modules/organizationBlock/domain";
import { blockedOrganizationIds, organizationBlockGate } from "../src/modules/organizationBlock/organizationBlockGate";
import { STAFF_ORGANIZATION_AUDIT } from "../src/modules/staffAccess/domain";
import { closePostgres } from "../config/postgres";
import { closeSecurityRateLimitRedis } from "../middleware/securityRateLimit";
import { closeSupportRedis } from "../src/modules/supportDesk/infrastructure/redis/supportRedis";
import { cleanupOrganizations, seedOrganization, signIn, type Fixture } from "./memberFixtures";

const tag = randomMongoId().slice(0, 10);
const oid = (value?: string) => new mongoose.Types.ObjectId(value);
const BASE = "/api/v1/admin/organizations";
const AUDIT_LOG = "/api/v1/organization/audit-events";
const REASON = `Chargeback dispute, ticket ${tag}`;
const PASSWORD = "correct-horse-battery-staple";
const REFRESH_COOKIE = "rfpilot_refresh";
const BLOCK_ACTIONS = Object.values(STAFF_ORGANIZATION_AUDIT);
const NEUTRAL_GRANT = { success: false, message: "Access grant is invalid, expired, revoked, or exhausted" };

let server: http.Server;
let baseUrl: string;
let a: Fixture;
let b: Fixture;
let aId: mongoose.Types.ObjectId;
let bId: mongoose.Types.ObjectId;
let staffToken: string;
const dxg = { org: oid(), staff: oid() };
const holding = { org: oid(), member: oid() };
// Password accounts: one member of A, one of B, and a person whose account is B's and who also
// holds a membership in A.
const accounts = { a: { id: oid(), email: `block-a-${tag}@example.com` }, b: { id: oid(), email: `block-b-${tag}@example.com` }, both: { id: oid(), email: `block-both-${tag}@example.com` } };
const vendorEmail = `vendor-${tag}@vendor.example`;
const links: Record<"a" | "b", { proposalId: string; vendorQuery: string; viewQuery: string }> = { a: { proposalId: "", vendorQuery: "", viewQuery: "" }, b: { proposalId: "", vendorQuery: "", viewQuery: "" } };
const invitations = { a: generateInvitationToken(), b: generateInvitationToken() };
let before_: { aEvents: number; bEvents: number; b: string; aData: string; workspace: number; view: number; rfp: number };
let blockedAt: string;

type Answer = { status: number; body: Record<string, any>; text: string; cookies: string[] };
const send = async (method: string, path: string, options: { token?: string | null; body?: unknown; cookie?: string } = {}): Promise<Answer> => {
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
  return { status: res.status, body, text, cookies: res.headers.getSetCookie?.() ?? [] };
};
const asStaff = async (method: string, path: string, body?: unknown) => {
  const res = await send(method, path, { token: staffToken, body });
  assert.notEqual(res.status, 429, `rate limited: ${method} ${path}`);
  return res;
};
const me = (token: string) => send("GET", "/api/auth/me", { token });
const login = (email: string) => send("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
const refresh = (refreshToken: string) => send("POST", "/api/auth/refresh", { cookie: `${REFRESH_COOKIE}=${encodeURIComponent(refreshToken)}` });
const lookup = (token: string) => send("POST", "/api/v1/invitations/lookup", { body: { token } });
const eventCount = (organizationId: mongoose.Types.ObjectId) => SecurityAuditEvent.countDocuments({ organizationId });
const blockEvents = async (): Promise<Array<Record<string, any>>> =>
  SecurityAuditEvent.find({ organizationId: dxg.org, action: { $in: BLOCK_ACTIONS } }).sort({ createdAt: 1, _id: 1 }).lean();
const organizationDoc = async (id: mongoose.Types.ObjectId) => (await Organization.collection.findOne({ _id: id })) as Record<string, any>;
// Everything of an organization a block must leave exactly as it is (sessions are compared apart).
const dataOf = async (organizationId: mongoose.Types.ObjectId) => JSON.stringify({
  members: (await OrganizationMembership.find({ organizationId }).sort({ userId: 1 }).lean()).map((row: any) => [String(row.userId), row.roles, row.status]),
  proposals: (await Proposal.collection.find({ organizationId }).sort({ _id: 1 }).toArray()).map((row) => [String(row._id), row.status, row.isActive ?? null]),
  grants: (await PublicAccessGrant.find({ organizationId }).sort({ _id: 1 }).lean()).map((row: any) => [String(row._id), row.purpose, row.revokedAt ?? null, row.expiresAt.toISOString()]),
  invitations: (await Invitation.find({ organizationId }).sort({ _id: 1 }).lean()).map((row: any) => [String(row._id), row.status, row.tokenHash, row.expiresAt.toISOString()]),
});
const snapshotB = async () => JSON.stringify({
  data: await dataOf(bId),
  organization: await Organization.collection.findOne({ _id: bId }, { projection: { updatedAt: 0 } }),
  sessions: (await RefreshSession.find({ organizationId: bId, sessionId: { $in: Object.values(b.members).map((m) => m.sessionId) } }).sort({ sessionId: 1 }).lean()).map((row: any) => [row.sessionId, row.status]),
});

const seedLinks = async (which: "a" | "b", fixture: Fixture) => {
  const token = fixture.members.planner.accessToken;
  const draft = await send("POST", "/api/proposals", { token, body: { event: { eventName: `Block suite ${which} ${tag}` } } });
  assert.equal(draft.status, 201, draft.text);
  const proposalId = String(draft.body.data._id);
  assert.equal((await send("PATCH", `/api/proposals/${proposalId}/status`, { token, body: { status: "submitted" } })).status, 200);
  const vendor = await send("POST", "/api/public-access", { token, body: { resourceId: proposalId, purpose: "vendor:submit", recipient: vendorEmail } });
  assert.equal(vendor.status, 201, vendor.text);
  const view = await send("POST", "/api/public-access", { token, body: { resourceId: proposalId, purpose: "proposal:view" } });
  assert.equal(view.status, 201, view.text);
  links[which] = {
    proposalId,
    vendorQuery: `accessGrant=${encodeURIComponent(String(vendor.body.grant.token))}&proposalId=${proposalId}&email=${encodeURIComponent(vendorEmail)}`,
    viewQuery: `accessGrant=${encodeURIComponent(String(view.body.grant.token))}`,
  };
  const inviter = fixture.members.owner.userId;
  await Invitation.create({
    organizationId: fixture.organizationId, email: `invited-${which}-${tag}@example.com`, role: "planner", invitedBy: inviter, status: "pending",
    tokenHash: hashInvitationToken(invitations[which]), tokenIssuedAt: new Date(), expiresAt: new Date(Date.now() + 5 * 86_400_000),
    delivery: { state: "sent", kind: "invite", attempts: 1, sentAt: new Date() },
  });
};
const workspace = (which: "a" | "b") => send("GET", `/api/vendor-responses/workspace?${links[which].vendorQuery}`);
const vendorRfp = (which: "a" | "b") => send("GET", `/api/proposals/${links[which].proposalId}?${links[which].vendorQuery}`);
const sharedView = (which: "a" | "b") => send("GET", `/api/proposals/${links[which].proposalId}?${links[which].viewQuery}`);
const grantUses = async (organizationId: mongoose.Types.ObjectId) => (await PublicAccessGrant.find({ organizationId }).lean()).reduce((sum, row: any) => sum + (row.useCount ?? 0), 0);

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  await Promise.all([User.init(), Organization.init(), OrganizationMembership.init(), Invitation.init()]);

  a = await seedOrganization(`A Events ${tag}`);
  b = await seedOrganization(`B Company ${tag}`);
  aId = oid(a.organizationId);
  bId = oid(b.organizationId);

  for (const [account, organizationId] of [[accounts.a, aId], [accounts.b, bId], [accounts.both, bId]] as const) {
    await User.create({ _id: account.id, name: `Block ${account.email}`, email: account.email, password: PASSWORD, role: "customer", organizationId, isBlocked: false });
    await OrganizationMembership.create({ organizationId, userId: account.id, roles: ["planner"], status: "active" });
  }
  // The same person also holds a membership in A.
  await OrganizationMembership.create({ organizationId: aId, userId: accounts.both.id, roles: ["planner"], status: "active" });

  await Organization.collection.insertOne({ _id: dxg.org, name: `RFPilot ${tag}`, slug: `intg-members-dxg-${tag}`, status: "active", kind: "customer", plan: "free_trial" });
  await Admin.collection.insertOne({ _id: dxg.staff, organizationId: dxg.org, name: "Dana Staff", email: `admin-block-${tag}@example.com`, password: "not-a-real-hash", role: "admin", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: dxg.staff, roles: ["dxg_admin"], status: "active", version: 1 });
  await Organization.collection.insertOne({ _id: holding.org, name: `Holding ${tag}`, slug: `intg-members-holding-${tag}`, status: "active", kind: "legacy_holding", plan: "free_trial" });
  await User.collection.insertOne({ _id: holding.member, organizationId: holding.org, name: "Legacy Person", email: `legacy-block-${tag}@example.com`, password: "not-a-real-hash", role: "customer", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: holding.org, userId: holding.member, roles: ["planner"], status: "active", version: 1 });
  staffToken = (await beginAuthenticatedSession({ userId: String(dxg.staff), organizationId: String(dxg.org), correlationId: randomMongoId() })).accessToken;

  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await seedLinks("a", a);
  await seedLinks("b", b);
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    const orgIds = [dxg.org, holding.org, ...(aId ? [aId] : []), ...(bId ? [bId] : [])];
    await mongoose.connection.db!.collection("securityauditevents").deleteMany({ organizationId: { $in: orgIds } });
    await Promise.all([
      PublicAccessGrant.deleteMany({ organizationId: { $in: orgIds } }),
      Invitation.deleteMany({ organizationId: { $in: orgIds } }),
      Proposal.collection.deleteMany({ organizationId: { $in: orgIds } }),
      RefreshSession.deleteMany({ organizationId: { $in: orgIds } }),
    ]);
    await OrganizationMembership.collection.deleteMany({ $or: [{ organizationId: { $in: [dxg.org, holding.org] } }, { userId: { $in: Object.values(accounts).map((account) => account.id) } }] });
    await User.collection.deleteMany({ $or: [{ organizationId: { $in: [dxg.org, holding.org] } }, { _id: { $in: Object.values(accounts).map((account) => account.id) } }] });
    await Admin.collection.deleteMany({ _id: dxg.staff });
    await Organization.collection.deleteMany({ _id: { $in: [dxg.org, holding.org] } });
    await cleanupOrganizations();
  }
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
  await closeSupportRedis();
});

test("before any block: everything works in A and in B, and no organization carries the marker", async () => {
  assert.equal((await me(a.members.owner.accessToken)).status, 200);
  assert.equal((await me(b.members.owner.accessToken)).status, 200);
  assert.equal((await login(accounts.a.email)).status, 200);
  const rfp = await vendorRfp("a");
  assert.equal(rfp.status, 200, rfp.text);
  const space = await workspace("a");
  assert.notEqual(space.status, 403, space.text);
  assert.notEqual(space.status, 401, space.text);
  const view = await sharedView("a");
  assert.equal(view.status, 200, view.text);
  const found = await lookup(invitations.a);
  assert.equal(found.status, 200, found.text);
  assert.equal(found.body.invitation.email, `invited-a-${tag}@example.com`);
  for (const id of [aId, bId, dxg.org, holding.org]) {
    const doc = await organizationDoc(id);
    assert.equal("blocked" in doc, false, "no organization has the marker until staff set it");
    assert.equal(isOrganizationBlocked(doc), false);
    assert.equal(await organizationBlockGate.isBlocked(String(id)), false);
  }
  assert.equal((await blockedOrganizationIds()).has(a.organizationId), false);
  // The account detail of an organization that is not blocked has no block field at all.
  const detail = await asStaff("GET", `${BASE}/${a.organizationId}`);
  assert.equal(detail.status, 200, detail.text);
  assert.equal("blocked" in detail.body.data.organization, false);
  assert.equal("blockedAt" in detail.body.data.organization, false);
  before_ = {
    aEvents: await eventCount(aId), bEvents: await eventCount(bId), b: await snapshotB(), aData: await dataOf(aId),
    workspace: space.status, view: view.status, rfp: rfp.status,
  };
});

test("trust boundary: only RFPilot staff can block or reactivate; the staff organization and a holding tenant can never be blocked", async () => {
  for (const action of ["block", "reactivate"]) {
    assert.equal((await send("POST", `${BASE}/${a.organizationId}/${action}`, { body: { reason: REASON } })).status, 401, `${action} anonymous`);
    for (const fixture of [a, b]) {
      for (const role of ["owner", "organization_admin", "planner"] as const) {
        const res = await send("POST", `${BASE}/${a.organizationId}/${action}`, { token: fixture.members[role].accessToken, body: { reason: REASON } });
        assert.equal(res.status, 403, `${action} as ${role}: ${res.text}`);
      }
    }
    for (const [organizationId, standing] of [[dxg.org, "platform"], [holding.org, "legacy_holding"]] as const) {
      const res = await asStaff("POST", `${BASE}/${organizationId}/${action}`, { reason: REASON });
      assert.equal(res.status, 409, res.text);
      assert.deepEqual([res.body.code, res.body.standing], ["ORGANIZATION_NOT_MANAGEABLE", standing]);
      assert.equal("blocked" in (await organizationDoc(organizationId)), false);
    }
    assert.deepEqual([(await asStaff("POST", `${BASE}/${a.organizationId}/${action}`, { reason: "short" })).status, (await asStaff("POST", `${BASE}/${a.organizationId}/${action}`, {})).body.code], [400, "INVALID_REASON"]);
    assert.equal((await asStaff("POST", `${BASE}/not-an-id/${action}`, { reason: REASON })).body.code, "INVALID_ORGANIZATION_ID");
    assert.equal((await asStaff("POST", `${BASE}/${randomMongoId()}/${action}`, { reason: REASON })).status, 404);
  }
  assert.equal("blocked" in (await organizationDoc(aId)), false, "nothing was blocked by a refused request");
  const denied = await SecurityAuditEvent.find({ organizationId: dxg.org, action: { $in: BLOCK_ACTIONS }, decision: "denied" }).lean();
  assert.equal(denied.length, 12, "every refusal after the staff check is recorded, on the staff side");
  assert.equal(await eventCount(aId), before_.aEvents);
  assert.equal(await eventCount(bId), before_.bEvents);
});

test("block A: one staff-side event, the marker on A only, every session of A ended, nothing in A's audit trail", async () => {
  const sessionsBefore = await RefreshSession.countDocuments({ organizationId: aId, status: "active" });
  assert.ok(sessionsBefore >= 5);
  const blocked = await asStaff("POST", `${BASE}/${a.organizationId}/block`, { reason: REASON, organizationId: b.organizationId });
  assert.equal(blocked.status, 200, blocked.text);
  assert.deepEqual(Object.keys(blocked.body.data).sort(), ["blocked", "blockedAt", "changed", "organizationId", "sessionsEnded"]);
  assert.deepEqual([blocked.body.data.organizationId, blocked.body.data.changed, blocked.body.data.blocked, blocked.body.data.sessionsEnded], [a.organizationId, true, true, sessionsBefore]);
  blockedAt = blocked.body.data.blockedAt;
  assert.equal(blocked.text.includes(REASON), false);
  assert.equal(blocked.text.includes(String(dxg.staff)), false);

  const doc = await organizationDoc(aId);
  assert.equal(isOrganizationBlocked(doc), true);
  assert.deepEqual([doc.blocked.byStaffOrganizationId, doc.blocked.byStaffAccountId, doc.blocked.at.toISOString()], [String(dxg.org), String(dxg.staff), blockedAt]);
  assert.equal(doc.status, "active", "`status` is not what a block changes");
  assert.equal("blocked" in (await organizationDoc(bId)), false);
  assert.deepEqual([...(await blockedOrganizationIds())].filter((id) => [a.organizationId, b.organizationId].includes(id)), [a.organizationId]);

  assert.equal(await RefreshSession.countDocuments({ organizationId: aId, status: "active" }), 0);
  assert.equal(await RefreshSession.countDocuments({ organizationId: aId, revokeReason: ORGANIZATION_BLOCK_REVOKE_REASON }), sessionsBefore);

  const events = (await blockEvents()).filter((event) => event.decision === "allowed");
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].action, String(events[0].actorUserId), events[0].targetId, events[0].reason], ["platform.organization.blocked", String(dxg.staff), a.organizationId, "organization_blocked"]);
  assert.deepEqual([events[0].metadata.staffReason, events[0].metadata.changed, events[0].metadata.sessionsEnded], [REASON, true, sessionsBefore]);
  assert.equal(await eventCount(aId), before_.aEvents, "nothing was written to A's audit trail");

  // Idempotent, and still recorded.
  const again = await asStaff("POST", `${BASE}/${a.organizationId}/block`, { reason: REASON });
  assert.deepEqual([again.status, again.body.data.changed, again.body.data.blocked, again.body.data.blockedAt], [200, false, true, blockedAt]);
  assert.deepEqual((await blockEvents()).filter((event) => event.decision === "allowed").map((event) => event.reason), ["organization_blocked", "organization_already_blocked"]);
});

test("while blocked: A's members are refused on a request, on refresh and at sign-in, with a code, and none of it is written to A's audit trail", async () => {
  for (const role of ["owner", "organization_admin", "planner", "viewer"] as const) {
    const refused = await me(a.members[role].accessToken);
    assert.deepEqual([refused.status, refused.body.code], [401, "ORGANIZATION_BLOCKED"], `${role}: ${refused.text}`);
    assert.match(refused.body.message, /paused/);
  }
  // Every other authenticated route of the organization, not only /me.
  for (const path of ["/api/proposals", "/api/v1/organization/audit-events", "/api/organization/members", "/api/notifications"]) {
    const refused = await send("GET", path, { token: a.members.owner.accessToken });
    assert.deepEqual([refused.status, refused.body.code], [401, "ORGANIZATION_BLOCKED"], `${path}: ${refused.text}`);
  }
  // Refresh, twice: the session the block ended, then the same token again.
  for (const attempt of [1, 2]) {
    const refused = await refresh(a.members.owner.refreshToken);
    assert.deepEqual([refused.status, refused.body.code, refused.body.reason], [401, "REFRESH_SESSION_EXPIRED", "organization_blocked"], `refresh ${attempt}: ${refused.text}`);
    assert.equal(refused.body.accessToken, undefined);
  }
  // Password sign-in with the right password.
  const signIn_ = await login(accounts.a.email);
  assert.deepEqual([signIn_.status, signIn_.body.code, signIn_.body.errorCode], [403, "ORGANIZATION_BLOCKED", "ORGANIZATION_BLOCKED"], signIn_.text);
  assert.equal(signIn_.body.accessToken, undefined);
  assert.equal(signIn_.cookies.some((cookie) => cookie.startsWith(`${REFRESH_COOKIE}=`) && !/Expires=Thu, 01 Jan 1970/.test(cookie)), false, "no refresh cookie is set");
  assert.equal(await RefreshSession.countDocuments({ userId: accounts.a.id, status: "active" }), 0, "no session is created");
  // No session can be begun for A by any path: this is what every sign-in method ends in.
  await assert.rejects(
    () => beginAuthenticatedSession({ userId: a.members.planner.userId, organizationId: a.organizationId, correlationId: randomMongoId() }),
    (error: unknown) => error instanceof OrganizationBlockedError,
  );
  // A session that slipped in while the block committed is closed by the member's next request.
  const slipped = await signIn(a.organizationId, a.members.viewer.userId, a.members.viewer.email);
  await SecurityAuditEvent.deleteMany({ organizationId: aId, action: "auth.session.created", targetId: slipped.sessionId });
  assert.deepEqual([(await me(slipped.accessToken)).body.code], ["ORGANIZATION_BLOCKED"]);
  assert.deepEqual([(await RefreshSession.findOne({ sessionId: slipped.sessionId }).lean())?.status, (await RefreshSession.findOne({ sessionId: slipped.sessionId }).lean())?.revokeReason], ["revoked", ORGANIZATION_BLOCK_REVOKE_REASON]);

  assert.equal(await eventCount(aId), before_.aEvents, "no row in A: no 'sessions signed out', no 'session reuse detected', no sign-in event");
});

test("while blocked: a person who also belongs to B still signs in to B and works there; no session can be begun for them in A", async () => {
  const signedIn = await login(accounts.both.email);
  assert.equal(signedIn.status, 200, signedIn.text);
  const token = String(signedIn.body.accessToken);
  const mine = await me(token);
  assert.equal(mine.status, 200, mine.text);
  assert.equal((await send("GET", "/api/proposals", { token })).status, 200);
  const session = await RefreshSession.findOne({ userId: accounts.both.id, status: "active" }).lean();
  assert.equal(String(session?.organizationId), b.organizationId, "the session is B's");
  await assert.rejects(
    () => beginAuthenticatedSession({ userId: String(accounts.both.id), organizationId: a.organizationId, correlationId: randomMongoId() }),
    (error: unknown) => error instanceof OrganizationBlockedError,
  );
  // Their membership in A is untouched: it works again when A is reactivated.
  assert.equal((await OrganizationMembership.findOne({ organizationId: aId, userId: accounts.both.id }).lean())?.status, "active");
});

test("while blocked: A's vendor link, shared proposal link and invitation link answer exactly as an unknown link does, and are not used", async () => {
  const usesBefore = await grantUses(aId);
  const bogus = `accessGrant=${"x".repeat(43)}&proposalId=${links.a.proposalId}&email=${encodeURIComponent(vendorEmail)}`;
  const unknownWorkspace = await send("GET", `/api/vendor-responses/workspace?${bogus}`);
  const unknownRfp = await send("GET", `/api/proposals/${links.a.proposalId}?${bogus}`);
  assert.deepEqual([unknownWorkspace.status, unknownWorkspace.body], [403, NEUTRAL_GRANT]);

  for (const [label, answer, unknown] of [
    ["vendor workspace", await workspace("a"), unknownWorkspace],
    ["vendor proposal read", await vendorRfp("a"), unknownRfp],
    ["shared proposal page", await sharedView("a"), unknownRfp],
  ] as const) {
    assert.deepEqual([answer.status, answer.body], [unknown.status, unknown.body], `${label}: the answer of a link that does not exist`);
    assert.doesNotMatch(answer.text, /block|paus|suspend|reactivat/i, `${label} says nothing of a block`);
  }
  // Writes through the vendor link are closed the same way.
  const draft = await send("POST", `/api/vendor-responses/drafts?${links.a.vendorQuery}`, { body: { proposalId: links.a.proposalId, email: vendorEmail } });
  assert.deepEqual([draft.status, draft.body], [403, NEUTRAL_GRANT]);
  const views = await send("PATCH", `/api/proposals/${links.a.proposalId}/views?${links.a.viewQuery}`, { body: {} });
  assert.deepEqual([views.status, views.body], [403, NEUTRAL_GRANT]);
  assert.equal(await grantUses(aId), usesBefore, "no use of A's links was counted");

  const unknownInvitation = await lookup(generateInvitationToken());
  assert.deepEqual([unknownInvitation.status, unknownInvitation.body.code], [404, "INVITATION_INVALID"]);
  const closed = await lookup(invitations.a);
  assert.deepEqual([closed.status, closed.body], [unknownInvitation.status, unknownInvitation.body]);
  for (const [path, body] of [
    ["/api/v1/invitations/accept", { token: invitations.a, email: `invited-a-${tag}@example.com`, password: PASSWORD }],
    ["/api/v1/invitations/accept/register", { token: invitations.a, name: "Invited Person", password: PASSWORD }],
    ["/api/v1/invitations/accept/google", { token: invitations.a, idToken: "not-a-token" }],
  ] as const) {
    const refused = await send("POST", path, { body });
    assert.deepEqual([refused.status, refused.body], [unknownInvitation.status, unknownInvitation.body], path);
  }
  assert.equal(await User.countDocuments({ email: `invited-a-${tag}@example.com` }), 0, "nobody joined A");
  assert.equal((await Invitation.findOne({ tokenHash: hashInvitationToken(invitations.a) }).lean())?.status, "pending", "the invitation is untouched");

  // B's links work as they did.
  assert.equal((await vendorRfp("b")).status, 200);
  assert.equal((await sharedView("b")).status, 200);
  assert.equal((await lookup(invitations.b)).status, 200);
  assert.equal(await eventCount(aId), before_.aEvents);
});

test("while blocked: a queued job of A is deferred and not run; a job of B runs", async () => {
  const job = (organizationMongoId: string) => {
    const moves: Array<[number, string | undefined]> = [];
    return {
      moves,
      data: { jobId: randomMongoId(), organizationMongoId, actorUserMongoId: a.members.planner.userId, jobType: "proposal_draft_generate" as const, inputReference: "run", inputVersion: null, correlationId: randomMongoId() },
      async moveToDelayed(timestamp: number, token?: string) { moves.push([timestamp, token]); },
    };
  };
  const ofA = job(a.organizationId);
  const started = Date.now();
  await assert.rejects(() => deferJobOfBlockedOrganization(ofA, "lock"), (error: unknown) => error instanceof DelayedError);
  assert.equal(ofA.moves.length, 1);
  assert.ok(ofA.moves[0][0] >= started + 4 * 60_000, "deferred for minutes, to be asked again");
  const ofB = job(b.organizationId);
  await deferJobOfBlockedOrganization(ofB, "lock");
  assert.deepEqual(ofB.moves, [], "B's job goes on to be claimed and run");
});

test("while blocked: staff reads and staff member management on A keep working, and show A as blocked", async () => {
  const detail = await asStaff("GET", `${BASE}/${a.organizationId}`);
  assert.equal(detail.status, 200, detail.text);
  assert.deepEqual([detail.body.data.organization.blocked, detail.body.data.organization.blockedAt, detail.body.data.organization.status], [true, blockedAt, "active"]);
  assert.equal(detail.text.includes(String(dxg.staff)), false, "the detail does not say who blocked it");
  const other = await asStaff("GET", `${BASE}/${b.organizationId}`);
  assert.equal("blocked" in other.body.data.organization, false);

  const listed = await asStaff("GET", `/api/v1/admin/organization-plans?search=${encodeURIComponent(tag)}`);
  assert.equal(listed.status, 200, listed.text);
  const rows = Object.fromEntries((listed.body.data.organizations as Array<Record<string, any>>).map((row) => [row.id, [row.blocked, row.blockedAt]]));
  assert.deepEqual(rows[a.organizationId], [true, blockedAt]);
  assert.deepEqual(rows[b.organizationId], [false, null]);
  assert.equal(listed.text.includes("byStaff"), false);
  const plan = await asStaff("GET", `/api/v1/admin/organization-plans/${a.organizationId}`);
  assert.deepEqual([plan.status, plan.body.data.organization.blocked], [200, true]);

  const members = await asStaff("GET", `${BASE}/${a.organizationId}/members`);
  assert.equal(members.status, 200, members.text);
  const proposals = await asStaff("GET", `${BASE}/${a.organizationId}/proposals`);
  assert.equal(proposals.status, 200, proposals.text);

  // Staff fix the organization while it is blocked: a role change on one of A's members.
  const viewer = `${BASE}/${a.organizationId}/members/${a.members.viewer.userId}`;
  const read = await asStaff("GET", viewer);
  assert.equal(read.status, 200, read.text);
  const changed = await asStaff("PATCH", `${viewer}/role`, { role: "planner", version: read.body.data.version, reason: REASON });
  assert.equal(changed.status, 200, changed.text);
  assert.deepEqual(changed.body.data.member.roles, ["planner"]);
  const back = await asStaff("PATCH", `${viewer}/role`, { role: "viewer", version: changed.body.data.version, reason: REASON });
  assert.equal(back.status, 200, back.text);
  assert.equal(await eventCount(aId), before_.aEvents);
});

test("while blocked: B is completely unaffected", async () => {
  assert.equal(await snapshotB(), before_.b);
  assert.equal(await eventCount(bId), before_.bEvents + (await SecurityAuditEvent.countDocuments({ organizationId: bId, actorUserId: accounts.both.id })), "the only new rows in B are the dual member's own sign-in");
  for (const role of ["owner", "planner", "viewer"] as const) assert.equal((await me(b.members[role].accessToken)).status, 200);
  const rotated = await refresh(b.members.organization_admin.refreshToken);
  assert.equal(rotated.status, 200, rotated.text);
  assert.equal((await me(String(rotated.body.accessToken))).status, 200);
  assert.equal((await login(accounts.b.email)).status, 200);
  assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: bId, action: { $regex: /^platform\./ } }), 0);
});

test("reactivate A: one staff-side event, the marker gone, and everything works again with nothing lost", async () => {
  assert.equal(await eventCount(aId), before_.aEvents, "the whole block left no row in A");
  const usesBefore = await grantUses(aId);
  const reactivated = await asStaff("POST", `${BASE}/${a.organizationId}/reactivate`, { reason: REASON });
  assert.equal(reactivated.status, 200, reactivated.text);
  assert.deepEqual(reactivated.body.data, { organizationId: a.organizationId, changed: true, blocked: false, blockedAt: null });
  const doc = await organizationDoc(aId);
  assert.equal("blocked" in doc, false, "the marker is removed");
  assert.equal(doc.status, "active");
  const again = await asStaff("POST", `${BASE}/${a.organizationId}/reactivate`, { reason: REASON });
  assert.deepEqual([again.status, again.body.data.changed, again.body.data.blocked], [200, false, false]);
  const allowed = (await blockEvents()).filter((event) => event.decision === "allowed");
  assert.deepEqual(allowed.map((event) => [event.action, event.reason]), [
    ["platform.organization.blocked", "organization_blocked"], ["platform.organization.blocked", "organization_already_blocked"],
    ["platform.organization.reactivated", "organization_reactivated"], ["platform.organization.reactivated", "organization_not_blocked"],
  ]);
  assert.ok(allowed.every((event) => String(event.organizationId) === String(dxg.org) && event.metadata.staffReason === REASON));
  assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: { $in: [aId, bId] }, action: { $regex: /^platform\./ } }), 0);

  // Nothing was lost: members, proposals, links and invitations are what they were.
  assert.equal(await dataOf(aId), before_.aData);
  assert.equal(await grantUses(aId), usesBefore);

  // Ended sessions stay ended, and an old refresh token coming back writes no "reuse detected".
  const old = await me(a.members.owner.accessToken);
  assert.notEqual(old.status, 200);
  assert.notEqual(old.body.code, "ORGANIZATION_BLOCKED");
  const stale = await refresh(a.members.owner.refreshToken);
  assert.deepEqual([stale.status, stale.body.reason], [401, "reuse_detected"]);
  assert.equal(await eventCount(aId), before_.aEvents, "no 'session reuse detected' row for a session the block ended");

  // Members sign in afresh.
  const signedIn = await login(accounts.a.email);
  assert.equal(signedIn.status, 200, signedIn.text);
  assert.equal((await me(String(signedIn.body.accessToken))).status, 200);
  const fresh = await signIn(a.organizationId, a.members.organization_admin.userId, a.members.organization_admin.email);
  assert.equal((await me(fresh.accessToken)).status, 200);
  a.members.organization_admin = { ...a.members.organization_admin, ...fresh };
  const dual = await beginAuthenticatedSession({ userId: a.members.planner.userId, organizationId: a.organizationId, correlationId: randomMongoId() });
  assert.equal((await me(dual.accessToken)).status, 200);

  // Links work again.
  assert.equal((await vendorRfp("a")).status, before_.rfp);
  assert.equal((await workspace("a")).status, before_.workspace);
  assert.equal((await sharedView("a")).status, before_.view);
  const found = await lookup(invitations.a);
  assert.equal(found.status, 200, found.text);
  assert.equal(found.body.invitation.email, `invited-a-${tag}@example.com`);

  // Background work resumes.
  const moves: unknown[] = [];
  await deferJobOfBlockedOrganization({
    data: { jobId: randomMongoId(), organizationMongoId: a.organizationId, actorUserMongoId: a.members.planner.userId, jobType: "proposal_draft_generate", inputReference: "run", inputVersion: null, correlationId: randomMongoId() },
    async moveToDelayed(timestamp: number) { moves.push(timestamp); },
  }, "lock");
  assert.deepEqual(moves, []);
});

test("A's customer audit endpoints (list, filters, CSV), read after reactivation, show no row caused by the block", async () => {
  const admin = a.members.organization_admin.accessToken;
  const since = Date.parse(blockedAt) - 1000;
  const hidden = [REASON, "platform.", "organization_blocked", "organization_reactivated", ORGANIZATION_BLOCK_REVOKE_REASON, String(dxg.staff), String(dxg.org), "Dana Staff"];
  // What a block must never cause in the customer's log: sessions signed out, session reuse.
  const causedByBlock = ["auth.refresh.reuse_detected", "auth.sessions.revoked_all", "auth.sessions.revoked_others", "auth.session.revoked"];
  // In the database: the only rows in A since the block are the members' own sign-ins after the reactivation.
  const stored = await SecurityAuditEvent.find({ organizationId: aId, createdAt: { $gte: new Date(since) } }).lean();
  assert.deepEqual([...new Set(stored.map((row: any) => row.action))], ["auth.session.created"]);
  assert.ok(stored.every((row: any) => row.createdAt.getTime() > Date.parse(blockedAt)));

  for (const query of ["?limit=100", "?category=sign_in&limit=100", `?actor=${dxg.staff}`]) {
    const res = await send("GET", `${AUDIT_LOG}${query}`, { token: admin });
    assert.equal(res.status, 200, `${query}: ${res.text.slice(0, 300)}`);
    for (const text of hidden) assert.equal(res.text.includes(text), false, `${query}: ${text}`);
    if (query.startsWith("?actor=")) assert.deepEqual(res.body.data.events, [], query);
    for (const event of res.body.data.events as Array<Record<string, any>>) assert.equal(causedByBlock.includes(event.action), false, `${query}: ${event.action}`);
  }
  for (const action of BLOCK_ACTIONS) {
    const res = await send("GET", `${AUDIT_LOG}?action=${action}`, { token: admin });
    assert.deepEqual([res.status, res.body.code], [400, "AUDIT_FILTER_INVALID"], action);
  }
  const filters = await send("GET", `${AUDIT_LOG}/filters`, { token: admin });
  assert.equal(filters.status, 200, filters.text.slice(0, 300));
  for (const text of hidden) assert.equal(filters.text.includes(text), false, `filters: ${text}`);
  // The export is limited to 20 per user per 15 minutes: three calls here.
  for (const query of ["", `?actor=${dxg.staff}`]) {
    const res = await send("GET", `${AUDIT_LOG}/export${query}`, { token: admin });
    assert.equal(res.status, 200, `export${query}: ${res.text.slice(0, 300)}`);
    for (const text of [...hidden, ...causedByBlock, "Session reuse detected"]) assert.equal(res.text.includes(text), false, `export${query}: ${text}`);
  }
  assert.equal((await send("GET", `${AUDIT_LOG}/export?action=${STAFF_ORGANIZATION_AUDIT.blocked}`, { token: admin })).status, 400);
});
