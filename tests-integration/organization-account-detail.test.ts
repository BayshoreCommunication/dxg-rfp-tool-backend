// Owner decision 2026-11-17: RFPilot staff (an `admins` account) read account-level information
// about any organization without a support grant, and nothing else. Through the real API on real
// MongoDB: two organizations with different data; staff reading one sees only that one's counts,
// settings and Owner, and no member list, customer content or secret from either.
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
import OrganizationDomain from "../modal/organizationDomainModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import OrganizationVendor from "../modal/organizationVendorModel";
import Proposal from "../modal/proposalsModel";
import ProposalTemplate from "../modal/proposalTemplateModel";
import RefreshSession from "../modal/refreshSessionModel";
import SecurityAuditEvent from "../modal/securityAuditEventModel";
import SsoConnection from "../modal/ssoConnectionModel";
import SupportAccessGrant from "../modal/supportAccessGrantModel";
import SupportTicket from "../modal/supportTicketModel";
import Team from "../modal/teamModel";
import User from "../modal/userModel";
import { beginAuthenticatedSession } from "../src/modules/auth/composition";
import { closePostgres } from "../config/postgres";
import { closeSecurityRateLimitRedis } from "../middleware/securityRateLimit";
import { closeSupportRedis } from "../src/modules/supportDesk/infrastructure/redis/supportRedis";
import { closeQueue } from "../src/modules/durableJobs/queue";
import { cleanupOrganizations, ROLES, seedOrganization, SLUG_PREFIX, type Fixture } from "./memberFixtures";

const tag = randomMongoId().slice(0, 10);
const oid = (value?: string) => new mongoose.Types.ObjectId(value);
const DETAIL = "/api/v1/admin/organizations";
const PLANS = "/api/v1/admin/organization-plans";
const READ = "platform.organization_account.read";
const AUDIT_LOG = "/api/v1/organization/audit-events";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const at = (iso: string) => new Date(iso);

let server: http.Server;
let baseUrl: string;
let acme: Fixture;
let other: Fixture;
let acmeId: mongoose.Types.ObjectId;
let otherId: mongoose.Types.ObjectId;
let staffToken: string;
let superToken: string;
let impostorToken: string;
// DXG's own organization: two staff accounts and a `users` account holding a staff role.
const dxg = { org: oid(), staff: oid(), superAdmin: oid(), impostor: oid() };
const holding = oid();
const ACME_GRANT_EXPIRY = new Date(NOW + 5 * DAY);
const OTHER_GRANT_EXPIRY = new Date(NOW + 2 * DAY);

// Strings that are customer content, member identity or secrets. None may reach a response.
const acmeContent = [`Acme Gala ${tag}`, `Acme Summit ${tag}`, `Acme Venue Template ${tag}`, `Acme Caterers ${tag}`, `chef-${tag}@vendor.example`, `Acme invoice question ${tag}`, `invitee-one-${tag}@example.com`, `Acme Team North ${tag}`, `Grant reason ${tag}`];
const acmeSecrets = [`acme-client-id-${tag}`, `acme-sealed-secret-${tag}`, `https://idp-${tag}.example`, `acme-verify-token-${tag}`];
const otherContent = [`Other Co ${tag}`, `Other Retreat ${tag}`, `Other Florist ${tag}`, `Other ticket ${tag}`, `Other Team ${tag}`, `other-sso-client-${tag}`];

const call = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const sessionFor = async (userId: mongoose.Types.ObjectId, organizationId: mongoose.Types.ObjectId) =>
  (await beginAuthenticatedSession({ userId: String(userId), organizationId: String(organizationId), correlationId: randomMongoId() })).accessToken;
const readEvents = (organizationId: mongoose.Types.ObjectId) =>
  SecurityAuditEvent.find({ organizationId, action: READ }).sort({ createdAt: 1, _id: 1 }).lean();
const eventCount = (organizationId: mongoose.Types.ObjectId) => SecurityAuditEvent.countDocuments({ organizationId });

const proposal = (organizationId: mongoose.Types.ObjectId, userId: string, eventName: string, updatedAt: Date, isArchived = false) => ({
  organizationId, userId: oid(userId), status: "unsubmitted", isDraft: true, isArchived, archivedAt: isArchived ? updatedAt : null,
  event: { eventName }, createdAt: at("2026-10-01T00:00:00.000Z"), updatedAt,
});
const template = (organizationId: mongoose.Types.ObjectId, userId: string, title: string, overrides: Record<string, unknown> = {}) => ({
  organizationId, ownerUserId: oid(userId), scope: "organization", title, description: "", content: {}, publishedAt: new Date(NOW), publishedBy: oid(userId), archived: false, archivedAt: null, ...overrides,
});
const vendor = (organizationId: mongoose.Types.ObjectId, company: string, archived = false, email = `contact-${randomMongoId().slice(0, 6)}@vendor.example`) => ({
  organizationId, company, category: "catering", contacts: [{ name: "Vendor Contact", email }], archived, archivedAt: archived ? new Date(NOW) : null,
});
const ticket = (organizationId: mongoose.Types.ObjectId, userId: string, ticketNumber: number, subject: string, status: string) => ({
  organizationId, ticketNumber, requesterUserId: oid(userId), assigneeUserId: null, subject, category: "other", priority: "normal", status,
  messageCount: 1, unreadForRequester: 0, unreadForAgents: 1, lastMessageAt: new Date(NOW), createdAt: new Date(NOW), updatedAt: new Date(NOW),
});
const invitation = (organizationId: mongoose.Types.ObjectId, invitedBy: string, email: string, status: string, expiresAt: Date) => ({
  organizationId, email, role: "planner", teamId: null, invitedBy: oid(invitedBy), status, tokenHash: null, previousTokenHashes: [], expiresAt,
  createdAt: new Date(NOW), updatedAt: new Date(NOW),
});

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);

  acme = await seedOrganization(`Acme Events ${tag}`);
  other = await seedOrganization(`Other Co ${tag}`);
  acmeId = oid(acme.organizationId);
  otherId = oid(other.organizationId);
  const acmeOwner = acme.members.owner.userId;
  const otherOwner = other.members.owner.userId;

  // ── Acme: a busy organization with every setting on ──────────────────────────────────────
  await Organization.collection.updateOne({ _id: acmeId }, { $set: { country: "US", requireTwoFactor: true, requireSso: true, allowManagerInvites: true, autoApproveDomain: true } });
  await OrganizationMembership.collection.updateMany({ organizationId: acmeId }, { $set: { lastSignedInAt: null } });
  await OrganizationMembership.collection.updateOne({ organizationId: acmeId, userId: oid(acme.members.planner.userId) }, { $set: { lastSignedInAt: at("2026-11-16T10:00:00.000Z") } });
  await OrganizationMembership.collection.updateOne({ organizationId: acmeId, userId: oid(acme.members.viewer.userId) }, { $set: { lastSignedInAt: at("2026-11-12T10:00:00.000Z") } });
  await OrganizationMembership.collection.insertMany([
    { organizationId: acmeId, userId: oid(), roles: ["planner"], status: "suspended", version: 1, lastSignedInAt: at("2026-10-01T00:00:00.000Z") },
    { organizationId: acmeId, userId: oid(), roles: ["planner"], status: "removed", version: 1, lastSignedInAt: at("2026-11-17T00:00:00.000Z") },
  ]);
  await Invitation.collection.insertMany([
    invitation(acmeId, acmeOwner, `invitee-one-${tag}@example.com`, "pending", new Date(NOW + 3 * DAY)),
    invitation(acmeId, acmeOwner, `invitee-two-${tag}@example.com`, "pending", new Date(NOW + 3 * DAY)),
    invitation(acmeId, acmeOwner, `invitee-late-${tag}@example.com`, "pending", new Date(NOW - DAY)),
    invitation(acmeId, acmeOwner, `invitee-done-${tag}@example.com`, "accepted", new Date(NOW + 3 * DAY)),
  ]);
  await Team.collection.insertMany([
    { organizationId: acmeId, name: `Acme Team North ${tag}`, archived: false },
    { organizationId: acmeId, name: `Acme Team South ${tag}`, archived: false },
    { organizationId: acmeId, name: `Acme Team Old ${tag}`, archived: true, archivedAt: new Date(NOW) },
  ]);
  await Proposal.collection.insertMany([
    proposal(acmeId, acmeOwner, `Acme Gala ${tag}`, at("2026-11-14T09:00:00.000Z")),
    proposal(acmeId, acmeOwner, `Acme Summit ${tag}`, at("2026-11-15T12:00:00.000Z")),
    proposal(acmeId, acmeOwner, `Acme Old ${tag}`, at("2026-10-02T00:00:00.000Z"), true),
  ]);
  await ProposalTemplate.collection.insertMany([
    template(acmeId, acmeOwner, `Acme Venue Template ${tag}`),
    template(acmeId, acmeOwner, `Acme AV Template ${tag}`),
    template(acmeId, acmeOwner, `Acme Archived Template ${tag}`, { archived: true, archivedAt: new Date(NOW) }),
    template(acmeId, acmeOwner, `Acme Unpublished Template ${tag}`, { publishedAt: null, publishedBy: null }),
    template(acmeId, acmeOwner, `Acme Personal Template ${tag}`, { scope: "personal", publishedAt: null, publishedBy: null }),
  ]);
  await OrganizationVendor.collection.insertMany([
    vendor(acmeId, `Acme Caterers ${tag}`, false, `chef-${tag}@vendor.example`),
    vendor(acmeId, `Acme Lighting ${tag}`),
    vendor(acmeId, `Acme Former Vendor ${tag}`, true),
  ]);
  await SupportTicket.collection.insertMany([
    ticket(acmeId, acmeOwner, 1, `Acme invoice question ${tag}`, "open"),
    ticket(acmeId, acmeOwner, 2, `Acme waiting ${tag}`, "waiting_on_customer"),
    ticket(acmeId, acmeOwner, 3, `Acme closed ${tag}`, "closed"),
    ticket(acmeId, acmeOwner, 4, `Acme resolved ${tag}`, "resolved"),
  ]);
  await OrganizationDomain.collection.insertMany([
    { organizationId: acmeId, domain: `acme-${tag}.example`, status: "verified", verificationToken: `acme-verify-token-${tag}`, method: "dns_txt", addedByUserId: oid(acmeOwner), verifiedByUserId: oid(acmeOwner), verifiedAt: new Date(NOW), nextCheckAt: new Date(NOW + DAY) },
    { organizationId: acmeId, domain: `acme-events-${tag}.example`, status: "pending", verificationToken: `acme-verify-token-${tag}-2`, method: null, addedByUserId: oid(acmeOwner), nextCheckAt: new Date(NOW + DAY) },
  ]);
  await SsoConnection.collection.insertOne({ organizationId: acmeId, issuer: `https://idp-${tag}.example`, clientId: `acme-client-id-${tag}`, clientSecretSealed: `acme-sealed-secret-${tag}`, domains: [`acme-${tag}.example`], status: "active", version: 1, updatedByUserId: oid(acmeOwner) });
  await SupportAccessGrant.collection.insertMany([
    { organizationId: acmeId, proposalId: null, grantedBy: oid(acmeOwner), reason: `Grant reason ${tag}`, expiresAt: ACME_GRANT_EXPIRY, revokedAt: null, revokedBy: null, createdAt: new Date(NOW) },
    { organizationId: acmeId, proposalId: null, grantedBy: oid(acmeOwner), reason: null, expiresAt: new Date(NOW + 9 * DAY), revokedAt: new Date(NOW), revokedBy: oid(acmeOwner), createdAt: new Date(NOW) },
    { organizationId: acmeId, proposalId: null, grantedBy: oid(acmeOwner), reason: null, expiresAt: new Date(NOW - DAY), revokedAt: null, revokedBy: null, createdAt: new Date(NOW - 8 * DAY) },
  ]);

  // ── Other Co: different numbers everywhere, so a leak across organizations shows up ─────────
  await OrganizationMembership.collection.updateMany({ organizationId: otherId }, { $set: { lastSignedInAt: at("2026-11-17T07:00:00.000Z") } });
  await Team.collection.insertOne({ organizationId: otherId, name: `Other Team ${tag}`, archived: false });
  const otherProposals = await Proposal.collection.insertMany([
    proposal(otherId, otherOwner, `Other Retreat ${tag}`, at("2026-11-17T06:00:00.000Z")),
    proposal(otherId, otherOwner, `Other Retreat B ${tag}`, at("2026-11-01T00:00:00.000Z"), true),
    proposal(otherId, otherOwner, `Other Retreat C ${tag}`, at("2026-11-02T00:00:00.000Z"), true),
    proposal(otherId, otherOwner, `Other Retreat D ${tag}`, at("2026-11-03T00:00:00.000Z")),
    proposal(otherId, otherOwner, `Other Retreat E ${tag}`, at("2026-11-04T00:00:00.000Z")),
  ]);
  await OrganizationVendor.collection.insertMany([1, 2, 3, 4].map((n) => vendor(otherId, n === 1 ? `Other Florist ${tag}` : `Other Vendor ${n} ${tag}`)));
  await SupportTicket.collection.insertOne(ticket(otherId, otherOwner, 1, `Other ticket ${tag}`, "open"));
  await SsoConnection.collection.insertOne({ organizationId: otherId, issuer: `https://other-idp-${tag}.example`, clientId: `other-sso-client-${tag}`, clientSecretSealed: `other-sealed-${tag}`, domains: [], status: "draft", version: 1, updatedByUserId: oid(otherOwner) });
  await SupportAccessGrant.collection.insertOne({ organizationId: otherId, proposalId: otherProposals.insertedIds[0], grantedBy: oid(otherOwner), reason: null, expiresAt: OTHER_GRANT_EXPIRY, revokedAt: new Date(NOW), revokedBy: oid(otherOwner), createdAt: new Date(NOW) });

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
    const orgIds = [dxg.org, holding, acmeId, otherId];
    // Raw collections: the audit model itself is append-only.
    const seeded: mongoose.Model<any>[] = [SecurityAuditEvent, Invitation, ProposalTemplate, OrganizationVendor, SupportTicket, OrganizationDomain, SsoConnection, SupportAccessGrant, Proposal, Team];
    for (const model of seeded) {
      await model.collection.deleteMany({ organizationId: { $in: orgIds } });
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

test("staff read one organization's account and see only that organization's counts, settings and Owner", async () => {
  // A plan change first, so the detail has a last change to show.
  assert.equal((await call(staffToken, "PUT", `${PLANS}/${acme.organizationId}`, { plan: "full_access", note: `Plan note ${tag}` })).status, 200);

  const res = await call(staffToken, "GET", `${DETAIL}/${acme.organizationId}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const data = res.body.data;
  assert.deepEqual(Object.keys(data), ["organization", "owner", "plan", "counts", "security", "activity", "supportAccess"]);

  const { createdAt, slug, ...identity } = data.organization;
  assert.deepEqual(identity, { id: acme.organizationId, name: `Acme Events ${tag}`, country: "US", status: "active", kind: "customer", standing: "active" });
  assert.ok(slug.startsWith(SLUG_PREFIX));
  assert.ok(!Number.isNaN(Date.parse(createdAt)));
  assert.deepEqual(data.owner, { name: "owner person", email: acme.members.owner.email });

  const { lastChange, ...plan } = data.plan;
  assert.deepEqual(plan, {
    plan: "full_access", exempt: false,
    proposals: { created: 0, limit: null, remaining: null, canCreate: true },
    features: { vendorResponses: true, proposalIntelligence: true },
  });
  assert.deepEqual({ fromPlan: lastChange.fromPlan, toPlan: lastChange.toPlan, changedBy: lastChange.changedBy }, { fromPlan: "free_trial", toPlan: "full_access", changedBy: { id: String(dxg.staff), name: "Staff Agent" } });
  assert.deepEqual(Object.keys(lastChange).sort(), ["at", "changedBy", "fromPlan", "toPlan"]);

  assert.deepEqual(data.counts, {
    members: {
      active: 5, deactivated: 1,
      byRole: { owner: 1, organization_admin: 1, team_manager: 1, planner: 1, viewer: 1, other: 0 },
    },
    teams: { active: 2, archived: 1 },
    proposals: { total: 3 },
    openSupportTickets: 2,
  });
  assert.deepEqual(data.security, {
    signInMethods: ["password", "google", "microsoft", "company_sso"],
    requireTwoFactor: true,
    companySso: { configured: true, enabled: true, required: true, type: "oidc" },
    domains: [{ domain: `acme-${tag}.example`, status: "verified" }, { domain: `acme-events-${tag}.example`, status: "pending" }]
      .sort((a, b) => (a.domain < b.domain ? -1 : 1)),
    autoApproveDomain: true,
    allowManagerInvites: true,
  });
  // The removed member's later sign-in is not counted; a timestamp only, no name.
  assert.deepEqual(data.activity, { lastSignInAt: "2026-11-16T10:00:00.000Z" });
  // A grant is active; nothing about it (scope, expiry, how many, which proposal) is returned.
  assert.deepEqual(data.supportAccess, { active: true });

  const json = JSON.stringify(res.body);
  // No member list: the Owner's is the only email address, and no other member is named.
  assert.deepEqual(json.match(/[\w.+-]+@[\w.-]+/g), [acme.members.owner.email]);
  for (const role of ROLES.filter((r) => r !== "owner")) {
    assert.ok(!json.includes(acme.members[role].email), role);
    assert.ok(!json.includes(`${role} person`), role);
    assert.ok(!json.includes(acme.members[role].userId), role);
  }
  // No customer content, no secrets, and nothing from the other organization.
  for (const leaked of [...acmeContent, ...acmeSecrets, ...otherContent, "pendingInvitations", "expiresAt", `Plan note ${tag}`, other.organizationId, other.members.owner.email, "not-a-real-hash"]) {
    assert.ok(!json.includes(leaked), leaked);
  }
});

test("the other organization answers its own numbers, with nothing of the first", async () => {
  const res = await call(superToken, "GET", `${DETAIL}/${other.organizationId}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const data = res.body.data;
  assert.equal(data.organization.name, `Other Co ${tag}`);
  assert.deepEqual(data.owner, { name: "owner person", email: other.members.owner.email });
  assert.deepEqual([data.plan.plan, data.plan.proposals.limit, data.plan.lastChange], ["free_trial", 2, null]);
  assert.deepEqual(data.counts, {
    members: { active: 5, deactivated: 0, byRole: { owner: 1, organization_admin: 1, team_manager: 1, planner: 1, viewer: 1, other: 0 } },
    teams: { active: 1, archived: 0 },
    proposals: { total: 5 },
    openSupportTickets: 1,
  });
  assert.deepEqual(data.security, {
    signInMethods: ["password", "google", "microsoft"],
    requireTwoFactor: false,
    companySso: { configured: true, enabled: false, required: false, type: "oidc" },
    domains: [],
    autoApproveDomain: false,
    allowManagerInvites: false,
  });
  assert.deepEqual(data.activity, { lastSignInAt: "2026-11-17T07:00:00.000Z" });
  // Other Co's only grant is revoked, and Acme's active one doesn't count here.
  assert.deepEqual(data.supportAccess, { active: false });

  const json = JSON.stringify(res.body);
  assert.deepEqual(json.match(/[\w.+-]+@[\w.-]+/g), [other.members.owner.email]);
  for (const leaked of [...acmeContent, ...acmeSecrets, `Acme Events ${tag}`, acme.organizationId, acme.members.owner.email, `Other Retreat ${tag}`, `Other Florist ${tag}`, `Other ticket ${tag}`, `other-sso-client-${tag}`, `other-sealed-${tag}`]) {
    assert.ok(!json.includes(leaked), leaked);
  }
});

test("audit: each read is one event in the staff organization and none in the customer's", async () => {
  const acmeBefore = await eventCount(acmeId);
  const otherBefore = await eventCount(otherId);
  const staffBefore = (await readEvents(dxg.org)).length;
  assert.ok(staffBefore >= 2, "the two reads above were recorded");

  assert.equal((await call(staffToken, "GET", `${DETAIL}/${acme.organizationId}`)).status, 200);
  const events = await readEvents(dxg.org);
  assert.equal(events.length, staffBefore + 1);
  const event = events[events.length - 1];
  assert.deepEqual(
    { actor: String(event.actorUserId), targetType: event.targetType, targetId: event.targetId, decision: event.decision, reason: event.reason, metadata: event.metadata },
    { actor: String(dxg.staff), targetType: "organization", targetId: acme.organizationId, decision: "allowed", reason: "organization_account_detail", metadata: { agentAccountType: "admin" } },
  );
  assert.equal(await eventCount(acmeId), acmeBefore, "nothing is written to the customer's audit trail");
  assert.equal(await eventCount(otherId), otherBefore);
  assert.equal(await SecurityAuditEvent.countDocuments({ action: READ, organizationId: { $in: [acmeId, otherId, holding] } }), 0);

  // The customer's own audit log shows no trace of a read of their organization.
  assert.equal((await call(staffToken, "GET", `${DETAIL}/${other.organizationId}`)).status, 200);
  const log = await call(other.members.owner.accessToken, "GET", AUDIT_LOG);
  assert.equal(log.status, 200, JSON.stringify(log.body));
  assert.ok(!JSON.stringify(log.body).includes(READ));
  assert.ok(!JSON.stringify(log.body).includes("organization_account"));
});

test("trust boundary: no customer role, and no member holding a staff role, can read an organization's account", async () => {
  const staffBefore = (await readEvents(dxg.org)).length;
  // Other Co's members: Acme requires two-factor and SSO, which would refuse its members earlier.
  for (const role of ROLES) {
    for (const id of [acme.organizationId, other.organizationId]) {
      const res = await call(other.members[role].accessToken, "GET", `${DETAIL}/${id}`);
      assert.equal(res.status, 403, `${role} ${id}`);
      assert.equal(res.body.data, undefined, `${role} ${id}`);
      assert.ok(!JSON.stringify(res.body).includes(tag), `${role} ${id}`);
    }
  }
  // A `users` account with a staff membership role passes the route guard but isn't an admin-app account.
  for (const id of [acme.organizationId, String(dxg.org)]) {
    const res = await call(impostorToken, "GET", `${DETAIL}/${id}`);
    assert.equal(res.status, 403, id);
    assert.equal(res.body.code, "PLAN_MANAGEMENT_FORBIDDEN");
    assert.equal(res.body.data, undefined);
  }
  assert.equal((await fetch(`${baseUrl}${DETAIL}/${acme.organizationId}`)).status, 401);
  assert.equal((await readEvents(dxg.org)).length, staffBefore, "a refused read writes no event");
  // The route is read-only.
  for (const method of ["PUT", "POST", "PATCH", "DELETE"]) {
    const status = (await fetch(`${baseUrl}${DETAIL}/${acme.organizationId}`, { method, headers: { authorization: `Bearer ${staffToken}` } })).status;
    assert.ok(status >= 400, `${method} ${status}`);
  }
});

test("an unknown organization is a 404 and a malformed id a 400; a holding tenant and RFPilot's own organization say what they are", async () => {
  const staffBefore = (await readEvents(dxg.org)).length;
  const missing = await call(staffToken, "GET", `${DETAIL}/${randomMongoId()}`);
  assert.deepEqual([missing.status, missing.body], [404, { success: false, code: "ORGANIZATION_NOT_FOUND", message: "Organization not found." }]);
  for (const id of ["not-an-id", `${acme.organizationId}0`, "%7B%22%24ne%22%3Anull%7D"]) {
    const res = await call(staffToken, "GET", `${DETAIL}/${id}`);
    assert.deepEqual([res.status, res.body.code], [400, "INVALID_ORGANIZATION_ID"], id);
  }
  assert.equal((await readEvents(dxg.org)).length, staffBefore);

  const held = await call(staffToken, "GET", `${DETAIL}/${holding}`);
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.deepEqual([held.body.data.organization.kind, held.body.data.organization.standing, held.body.data.owner], ["legacy_holding", "awaiting_placement", null]);
  assert.deepEqual([held.body.data.plan.exempt, held.body.data.plan.proposals.limit], [true, null]);
  assert.deepEqual(held.body.data.counts.members, { active: 0, deactivated: 0, byRole: { owner: 0, organization_admin: 0, team_manager: 0, planner: 0, viewer: 0, other: 0 } });
  assert.deepEqual(held.body.data.supportAccess, { active: false });

  const own = await call(staffToken, "GET", `${DETAIL}/${dxg.org}`);
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.data.organization.standing, "platform");
  // Staff memberships carry no customer role; the member with a staff role is counted, never named.
  assert.deepEqual([own.body.data.counts.members.active, own.body.data.counts.members.byRole.other, own.body.data.owner], [3, 3, null]);
  assert.ok(!JSON.stringify(own.body).includes("@example.com"));
});

test("the existing plan routes answer as before", async () => {
  const one = await call(staffToken, "GET", `${PLANS}/${other.organizationId}`);
  assert.equal(one.status, 200);
  assert.deepEqual(Object.keys(one.body.data), ["organization", "plans", "history"]);
  assert.deepEqual(Object.keys(one.body.data.organization), ["id", "name", "slug", "status", "createdAt", "plan", "proposals", "features"]);
  const listed = await call(staffToken, "GET", `${PLANS}?search=${tag}`);
  assert.deepEqual(Object.keys(listed.body.data), ["organizations", "plans", "pagination", "filters"]);
});
