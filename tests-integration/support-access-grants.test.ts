// ORG-404: support access grants through the real API on real MongoDB. An organization's
// Owner/Admin grants RFPilot Support time-limited read access; a DXG admin-app account reads
// that organization's RFP data only under an active grant, every read is audited in the
// customer's organization, and nothing crosses to another organization.
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
import SupportAccessGrant from "../modal/supportAccessGrantModel";
import User from "../modal/userModel";
import VendorResponse from "../modal/vendorResponseModel";
import { beginAuthenticatedSession } from "../src/modules/auth/composition";
import { closePostgres } from "../config/postgres";
import { closeSecurityRateLimitRedis } from "../middleware/securityRateLimit";
import { closeSupportRedis } from "../src/modules/supportDesk/infrastructure/redis/supportRedis";
import { cleanupOrganizations, createProposals, seedOrganization, type Fixture } from "./memberFixtures";

const tag = randomMongoId().slice(0, 10);
const oid = (value?: string) => new mongoose.Types.ObjectId(value);
const DAY = 24 * 60 * 60 * 1000;
const GRANTS = "/api/v1/organization/support-grants";
const ACCESS = "/api/v1/admin/support-access";

let server: http.Server;
let baseUrl: string;
let acme: Fixture;
let other: Fixture;
let acmeRfps: string[];
let otherRfps: string[];
let agentToken: string;
// DXG's own organization: staff accounts, plus (as before cutover) a customer and an Owner.
const dxg = { org: oid(), agent: oid(), customer: oid(), owner: oid(), impostor: oid() };
let dxgCustomerToken: string;
let dxgOwnerToken: string;
let impostorToken: string;
let dxgCustomerRfp: string;

const call = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const events = (organizationId: string | mongoose.Types.ObjectId, action: string) =>
  SecurityAuditEvent.find({ organizationId, action }).sort({ createdAt: 1, _id: 1 }).lean();
const sessionFor = async (userId: mongoose.Types.ObjectId, organizationId: mongoose.Types.ObjectId) =>
  (await beginAuthenticatedSession({ userId: String(userId), organizationId: String(organizationId), correlationId: randomMongoId() })).accessToken;

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);

  acme = await seedOrganization("Acme Events");
  other = await seedOrganization("Other Co");
  acmeRfps = await createProposals(acme.organizationId, acme.members.planner.userId, 2);
  otherRfps = await createProposals(other.organizationId, other.members.planner.userId, 1);
  await Proposal.collection.updateOne({ _id: oid(acmeRfps[0]) }, { $set: { event: { eventName: "Acme spring summit" } } });
  await Proposal.collection.updateOne({ _id: oid(otherRfps[0]) }, { $set: { event: { eventName: "Other Co secret gala" } } });
  await VendorResponse.collection.insertOne({
    organizationId: oid(acme.organizationId), proposalId: oid(acmeRfps[0]), proposalOwnerId: oid(acme.members.planner.userId),
    vendorName: "Stage Audio", submittedBy: "Sam", email: `sam-${tag}@example.com`, message: "Quote attached", documents: [], createdAt: new Date(), updatedAt: new Date(),
  });

  await Organization.collection.insertOne({ _id: dxg.org, name: "DXG", slug: `intg-members-dxg-${tag}`, status: "active", kind: "customer", plan: "free_trial" });
  await Admin.collection.insertOne({ _id: dxg.agent, organizationId: dxg.org, name: "Staff Agent", email: `agent-${tag}@example.com`, password: "not-a-real-hash", role: "admin", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: dxg.agent, roles: ["dxg_admin"], status: "active", version: 1 });
  for (const [id, name, role] of [[dxg.customer, "Legacy Customer", "planner"], [dxg.owner, "DXG Owner", "owner"], [dxg.impostor, "Member With Staff Role", "dxg_admin"]] as const) {
    await User.collection.insertOne({ _id: id, organizationId: dxg.org, name, email: `${role}-${tag}@example.com`, password: "not-a-real-hash", role: "customer", isBlocked: false });
    await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: id, roles: [role], status: "active", version: 1 });
  }
  dxgCustomerRfp = (await createProposals(String(dxg.org), String(dxg.customer), 1))[0];
  agentToken = await sessionFor(dxg.agent, dxg.org);
  dxgCustomerToken = await sessionFor(dxg.customer, dxg.org);
  dxgOwnerToken = await sessionFor(dxg.owner, dxg.org);
  impostorToken = await sessionFor(dxg.impostor, dxg.org);

  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    const orgIds = [dxg.org, oid(acme.organizationId), oid(other.organizationId)];
    const db = mongoose.connection.db!;
    for (const name of ["supportaccessgrants", "vendorresponses", "supporttickets", "supportmessages", "supportticketcounters", "notifications"]) {
      await db.collection(name).deleteMany({ organizationId: { $in: orgIds } });
    }
    await OrganizationMembership.collection.deleteMany({ organizationId: dxg.org });
    await RefreshSession.deleteMany({ organizationId: dxg.org });
    await Proposal.collection.deleteMany({ organizationId: dxg.org });
    await User.collection.deleteMany({ organizationId: dxg.org });
    await Admin.collection.deleteOne({ _id: dxg.agent });
    await cleanupOrganizations();
  }
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
  await closeSupportRedis();
});

test("without a grant RFPilot Support reads no customer RFP data, and the attempt is on the customer's record", async () => {
  for (const path of [
    `/organizations/${acme.organizationId}/rfps`,
    `/organizations/${acme.organizationId}/rfps/${acmeRfps[0]}`,
    `/organizations/${acme.organizationId}/rfps/${acmeRfps[0]}/vendor-responses`,
  ]) {
    const res = await call(agentToken, "GET", `${ACCESS}${path}`);
    assert.equal(res.status, 403, path);
    assert.equal(res.body.code, "SUPPORT_GRANT_REQUIRED");
    assert.ok(!JSON.stringify(res.body).includes("Acme spring summit"));
  }
  assert.deepEqual((await call(agentToken, "GET", `${ACCESS}/grants`)).body.data.grants.filter((g: any) => g.organization.id === acme.organizationId), []);
  const denied = await events(acme.organizationId, "support_access.denied");
  assert.equal(denied.length, 3);
  assert.ok(denied.every((e) => String(e.actorUserId) === String(dxg.agent) && e.decision === "denied"));
});

test("only an Owner or Admin grants; expiry defaults to 7 days and is capped at 30", async () => {
  for (const role of ["team_manager", "planner", "viewer"] as const) {
    assert.equal((await call(acme.members[role].accessToken, "POST", GRANTS, {})).status, 403, role);
    assert.equal((await call(acme.members[role].accessToken, "GET", GRANTS)).status, 403, role);
  }
  for (const body of [{ expiresInDays: 31 }, { expiresInDays: 0 }, { expiresAt: new Date(Date.now() + 31 * DAY).toISOString() }, { expiresAt: new Date(Date.now() - 1000).toISOString() }]) {
    const res = await call(acme.members.owner.accessToken, "POST", GRANTS, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, "INVALID_GRANT_EXPIRY");
  }
  assert.equal(await SupportAccessGrant.countDocuments({ organizationId: acme.organizationId }), 0);
  // The model holds the ceiling even if a caller skips the service.
  await assert.rejects(SupportAccessGrant.create({ organizationId: acme.organizationId, grantedBy: acme.members.owner.userId, expiresAt: new Date(Date.now() + 40 * DAY) }), /at most 30 days/);

  const before = Date.now();
  const created = await call(acme.members.organization_admin.accessToken, "POST", GRANTS, { reason: "Budget table won't save" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const grant = created.body.data;
  assert.equal(grant.scope, "organization");
  assert.equal(grant.status, "active");
  assert.equal(grant.grantedBy.id, acme.members.organization_admin.userId);
  const lifetime = new Date(grant.expiresAt).getTime() - before;
  assert.ok(lifetime >= 7 * DAY - 5_000 && lifetime <= 7 * DAY + 60_000, `lifetime ${lifetime}`);
  const [granted] = await events(acme.organizationId, "support_access.granted");
  assert.equal(String(granted.actorUserId), acme.members.organization_admin.userId);
  assert.equal(granted.metadata.grantId, grant.id);
});

test("under a grant every read is audited with the agent, the grant and the object, and the organization sees it", async () => {
  const grantId = String((await SupportAccessGrant.findOne({ organizationId: acme.organizationId }).lean())!._id);

  const granted = await call(agentToken, "GET", `${ACCESS}/grants`);
  const mine = granted.body.data.grants.find((g: any) => g.id === grantId);
  assert.equal(mine.organization.name, "Acme Events");
  assert.equal(mine.scope, "organization");
  assert.ok(mine.secondsRemaining > 6 * 24 * 60 * 60);

  const list = await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps`);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.data.rfps.map((r: any) => r.id).sort(), [...acmeRfps].sort());
  assert.equal(list.body.data.rfps.find((r: any) => r.id === acmeRfps[0]).owner.id, acme.members.planner.userId);

  const detail = await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps/${acmeRfps[0]}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.rfp.event.eventName, "Acme spring summit");
  assert.equal(detail.body.data.grant.id, grantId);
  assert.equal(detail.body.data.rfp.organizationId, undefined);

  const responses = await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps/${acmeRfps[0]}/vendor-responses`);
  assert.equal(responses.status, 200);
  assert.deepEqual(responses.body.data.vendorResponses.map((r: any) => r.vendorName), ["Stage Audio"]);

  const used = await events(acme.organizationId, "support_access.used");
  assert.deepEqual(used.map((e) => [String(e.actorUserId), e.metadata.grantId, e.targetType, e.targetId, e.metadata.operation, e.decision]), [
    [String(dxg.agent), grantId, "organization", acme.organizationId, "rfp.list", "allowed"],
    [String(dxg.agent), grantId, "proposal", acmeRfps[0], "rfp.read", "allowed"],
    [String(dxg.agent), grantId, "proposal", acmeRfps[0], "vendor_responses.list", "allowed"],
  ]);
  // Nothing about the use lands in another organization's trail.
  assert.equal((await events(other.organizationId, "support_access.used")).length, 0);

  const view = await call(acme.members.owner.accessToken, "GET", `${GRANTS}/${grantId}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.data.activity.useCount, 3);
  assert.deepEqual(view.body.data.events.map((e: any) => e.operation).sort(), ["rfp.list", "rfp.read", "vendor_responses.list"]);
  assert.ok(view.body.data.events.every((e: any) => e.agent.label === "RFPilot Support" && e.agent.id === String(dxg.agent)));
  assert.ok(!JSON.stringify(view.body).includes("Staff Agent"), "staff names stay out of customer views");
  const listed = await call(acme.members.organization_admin.accessToken, "GET", GRANTS);
  assert.equal(listed.body.data.grants.find((g: any) => g.id === grantId).activity.useCount, 3);
});

test("a grant never reaches another organization, and organizations can't see or revoke each other's grants", async () => {
  const grantId = String((await SupportAccessGrant.findOne({ organizationId: acme.organizationId }).lean())!._id);

  // Acme's grant doesn't open Other Co, directly or by naming its RFP under Acme.
  const direct = await call(agentToken, "GET", `${ACCESS}/organizations/${other.organizationId}/rfps/${otherRfps[0]}`);
  assert.equal(direct.status, 403);
  assert.equal(direct.body.code, "SUPPORT_GRANT_REQUIRED");
  assert.equal((await call(agentToken, "GET", `${ACCESS}/organizations/${other.organizationId}/rfps`)).status, 403);
  const smuggled = await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps/${otherRfps[0]}`);
  const missing = await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps/${randomMongoId()}`);
  assert.equal(smuggled.status, 404);
  assert.deepEqual(smuggled.body, missing.body);
  assert.equal((await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps/${otherRfps[0]}/vendor-responses`)).status, 404);
  for (const res of [direct, smuggled]) assert.ok(!JSON.stringify(res.body).includes("secret gala"));

  // Other Co's Owner: Acme's grant is missing, exactly like an id that doesn't exist.
  const foreignGet = await call(other.members.owner.accessToken, "GET", `${GRANTS}/${grantId}`);
  const missingGet = await call(other.members.owner.accessToken, "GET", `${GRANTS}/${randomMongoId()}`);
  assert.equal(foreignGet.status, 404);
  assert.deepEqual(foreignGet.body, missingGet.body);
  const foreignRevoke = await call(other.members.owner.accessToken, "POST", `${GRANTS}/${grantId}/revoke`);
  assert.equal(foreignRevoke.status, 404);
  assert.equal((await SupportAccessGrant.findById(grantId).lean())!.revokedAt, null);
  assert.deepEqual((await call(other.members.owner.accessToken, "GET", GRANTS)).body.data.grants, []);

  // Nor can Other Co grant access to Acme's RFP.
  const foreignRfp = await call(other.members.owner.accessToken, "POST", GRANTS, { proposalId: acmeRfps[0] });
  const missingRfp = await call(other.members.owner.accessToken, "POST", GRANTS, { proposalId: randomMongoId() });
  assert.equal(foreignRfp.status, 404);
  assert.deepEqual(foreignRfp.body, missingRfp.body);
  assert.equal(await SupportAccessGrant.countDocuments({ organizationId: other.organizationId }), 0);
});

test("customers, and members holding a staff role, can't use the RFPilot Support routes", async () => {
  const paths = [`${ACCESS}/grants`, `${ACCESS}/organizations/${acme.organizationId}/rfps`, `${ACCESS}/organizations/${acme.organizationId}/rfps/${acmeRfps[0]}`];
  for (const path of paths) {
    assert.equal((await call(acme.members.owner.accessToken, "GET", path)).status, 403, path);
    // A `users` account with a staff membership role passes the route guard but is not an admin-app account.
    const impostor = await call(impostorToken, "GET", path);
    assert.equal(impostor.status, 403, path);
    assert.equal(impostor.body.code, "SUPPORT_ACCESS_FORBIDDEN");
  }
  // Staff are not members: they can't issue themselves a grant in a customer organization.
  assert.equal((await call(agentToken, "POST", GRANTS, {})).status, 403);
  assert.equal(await SupportAccessGrant.countDocuments({ organizationId: dxg.org }), 0);
});

test("AC: a revoked grant is refused on the next request", async () => {
  const grantId = String((await SupportAccessGrant.findOne({ organizationId: acme.organizationId }).lean())!._id);
  const path = `${ACCESS}/organizations/${acme.organizationId}/rfps/${acmeRfps[0]}`;
  assert.equal((await call(agentToken, "GET", path)).status, 200);

  const revoked = await call(acme.members.owner.accessToken, "POST", `${GRANTS}/${grantId}/revoke`);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.data.status, "revoked");
  assert.equal(revoked.body.data.revokedBy.id, acme.members.owner.userId);

  for (const suffix of ["", "/vendor-responses"]) {
    const res = await call(agentToken, "GET", `${path}${suffix}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "SUPPORT_GRANT_REQUIRED");
  }
  assert.equal((await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps`)).status, 403);
  assert.ok(!(await call(agentToken, "GET", `${ACCESS}/grants`)).body.data.grants.some((g: any) => g.id === grantId));
  const [event] = await events(acme.organizationId, "support_access.revoked");
  assert.equal(String(event.actorUserId), acme.members.owner.userId);
  assert.equal(event.metadata.grantId, grantId);
  // The past grant and what happened under it stay visible.
  const past = await call(acme.members.owner.accessToken, "GET", `${GRANTS}/${grantId}`);
  assert.equal(past.body.data.status, "revoked");
  assert.equal(past.body.data.activity.useCount, 4);
});

test("AC: an expired grant is refused; a grant for one RFP opens that RFP only", async () => {
  const created = await call(acme.members.owner.accessToken, "POST", GRANTS, { proposalId: acmeRfps[0], expiresInDays: 1 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const grantId = created.body.data.id;
  assert.equal(created.body.data.scope, "rfp");
  assert.equal(created.body.data.rfp.title, "Acme spring summit");

  const granted = `${ACCESS}/organizations/${acme.organizationId}/rfps/${acmeRfps[0]}`;
  assert.equal((await call(agentToken, "GET", granted)).status, 200);
  assert.equal((await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps/${acmeRfps[1]}`)).status, 404);
  const list = await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps`);
  assert.deepEqual(list.body.data.rfps.map((r: any) => r.id), [acmeRfps[0]]);

  // Time passes: the stored expiry is now behind us.
  await SupportAccessGrant.collection.updateOne({ _id: oid(grantId) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await call(agentToken, "GET", granted);
  assert.equal(expired.status, 403);
  assert.equal(expired.body.code, "SUPPORT_GRANT_REQUIRED");
  assert.equal((await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps`)).status, 403);
  assert.ok(!(await call(agentToken, "GET", `${ACCESS}/grants`)).body.data.grants.some((g: any) => g.id === grantId));
  const view = await call(acme.members.owner.accessToken, "GET", `${GRANTS}/${grantId}`);
  assert.equal(view.body.data.status, "expired");
  assert.equal((await call(acme.members.owner.accessToken, "POST", `${GRANTS}/${grantId}/revoke`)).body.code, "SUPPORT_GRANT_EXPIRED");
});

test("AC: ticket content is readable without a grant; the RFP behind the ticket needs one", async () => {
  const opened = await call(dxgCustomerToken, "POST", "/api/v1/support/tickets", { subject: "Budget table won't save", body: "It spins forever on my spring RFP.", category: "bug" });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const ticketId = opened.body.data.ticket.id;

  // No grant: the helpdesk works as before.
  const ticket = await call(agentToken, "GET", `/api/v1/admin/support/tickets/${ticketId}`);
  assert.equal(ticket.status, 200, JSON.stringify(ticket.body));
  assert.ok(JSON.stringify(ticket.body).includes("It spins forever on my spring RFP."));
  assert.equal((await call(agentToken, "POST", `/api/v1/admin/support/tickets/${ticketId}/messages`, { body: "Looking into it." })).status, 201);

  // ...but not the RFPs behind it.
  const refused = await call(agentToken, "GET", `/api/v1/admin/support/tickets/${ticketId}/rfps`);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "SUPPORT_GRANT_REQUIRED");
  assert.equal((await call(agentToken, "GET", `${ACCESS}/organizations/${dxg.org}/rfps/${dxgCustomerRfp}`)).status, 403);

  const created = await call(dxgOwnerToken, "POST", GRANTS, { expiresInDays: 2 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const behind = await call(agentToken, "GET", `/api/v1/admin/support/tickets/${ticketId}/rfps`);
  assert.equal(behind.status, 200, JSON.stringify(behind.body));
  assert.deepEqual(behind.body.data.rfps.map((r: any) => r.id), [dxgCustomerRfp]);
  const used = await events(dxg.org, "support_access.used");
  assert.deepEqual(used.map((e) => [String(e.actorUserId), e.metadata.grantId, e.metadata.operation, e.metadata.ticketId]), [
    [String(dxg.agent), created.body.data.id, "ticket.rfp.list", ticketId],
  ]);

  // A ticket that does not exist is missing. (A customer organization's ticket: see
  // support-desk-cross-organization.test.ts.)
  assert.equal((await call(agentToken, "GET", `/api/v1/admin/support/tickets/${randomMongoId()}/rfps`)).status, 404);
});
