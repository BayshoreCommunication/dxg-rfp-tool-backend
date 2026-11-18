// ORG-404: support access grants through the real API on real MongoDB.
//
// Owner decision, 2026-11-17 (docs/DECISIONS.md): RFPilot staff read every organization's
// content with NO grant, and each read is recorded in the staff organization only. So here:
// the customer grant endpoints still answer (create, list, revoke, isolation between
// organizations: unchanged tests), a grant gates nothing, the older staff routes the deployed
// admin app calls keep their shapes, a record is never served through another organization's
// path, and nothing staff do is written into a customer organization.
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
const READ = "platform.organization_content.read";
// Everything in an organization's trail that a staff read could have written.
const staffWrites = (organizationId: string | mongoose.Types.ObjectId) =>
  SecurityAuditEvent.countDocuments({ organizationId, $or: [{ actorUserId: dxg.agent }, { action: /^(support_access\.(used|denied)|platform\.)/ }] });
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
    await db.collection("securityauditevents").deleteMany({ organizationId: dxg.org });
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

// Was: "without a grant RFPilot Support reads no customer RFP data, and the attempt is on the customer's record".
test("without a grant RFPilot staff read a customer organization's proposal data, and nothing is written in that organization", async () => {
  assert.equal(await SupportAccessGrant.countDocuments({ organizationId: acme.organizationId }), 0, "no grant exists");
  const list = await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps`);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.data.rfps.map((r: any) => r.id).sort(), [...acmeRfps].sort());
  assert.equal(list.body.data.rfps.find((r: any) => r.id === acmeRfps[0]).owner.id, acme.members.planner.userId);
  // The shape the deployed admin app parses: one standing organization-wide entry in place of a grant.
  assert.deepEqual(list.body.data.grants.map((g: any) => [g.id, g.scope, g.proposalId]), [[acme.organizationId, "organization", null]]);
  assert.ok(list.body.data.grants[0].secondsRemaining > 29 * 24 * 60 * 60);

  const detail = await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps/${acmeRfps[0]}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.data.rfp.event.eventName, "Acme spring summit");
  assert.equal(detail.body.data.grant.id, acme.organizationId);
  assert.equal(detail.body.data.rfp.organizationId, undefined);
  assert.equal(detail.body.data.rfp.proposalSettings, undefined);
  assert.equal(detail.body.data.rfp.__v, undefined);

  const responses = await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps/${acmeRfps[0]}/vendor-responses`);
  assert.equal(responses.status, 200);
  assert.deepEqual(responses.body.data.vendorResponses.map((r: any) => r.vendorName), ["Stage Audio"]);
  assert.equal(responses.body.data.grant.id, acme.organizationId);

  // "Granted to me" now lists every organization as a standing entry, with or without a grant.
  const granted = (await call(agentToken, "GET", `${ACCESS}/grants`)).body.data.grants;
  for (const organizationId of [acme.organizationId, other.organizationId]) {
    const mine = granted.filter((g: any) => g.organization.id === organizationId);
    assert.equal(mine.length, 1, organizationId);
    assert.deepEqual([mine[0].id, mine[0].scope, mine[0].rfp, mine[0].reason], [organizationId, "organization", null, null]);
  }
  assert.equal(granted.find((g: any) => g.organization.id === acme.organizationId).organization.name, "Acme Events");

  // Recorded in the staff organization, one event per read; nothing in Acme or Other Co.
  const recorded = await events(dxg.org, READ);
  assert.deepEqual(recorded.map((e) => [String(e.actorUserId), e.targetType, e.targetId, e.metadata.resource, e.metadata.recordId ?? null, e.decision]), [
    [String(dxg.agent), "organization", acme.organizationId, "proposals", null, "allowed"],
    [String(dxg.agent), "organization", acme.organizationId, "proposal", acmeRfps[0], "allowed"],
    [String(dxg.agent), "organization", acme.organizationId, "vendor_responses", acmeRfps[0], "allowed"],
  ]);
  assert.equal(await staffWrites(acme.organizationId), 0);
  assert.equal(await staffWrites(other.organizationId), 0);
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

// Was: "under a grant every read is audited with the agent, the grant and the object, and the organization sees it".
test("a grant changes nothing for staff reads, and the organization's grant view shows no staff activity", async () => {
  const grantId = String((await SupportAccessGrant.findOne({ organizationId: acme.organizationId }).lean())!._id);
  const before = (await events(dxg.org, READ)).length;

  const detail = await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps/${acmeRfps[1]}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  // The entry is the standing one, not the grant.
  assert.equal(detail.body.data.grant.id, acme.organizationId);
  assert.notEqual(detail.body.data.grant.id, grantId);
  assert.equal((await events(dxg.org, READ)).length, before + 1);
  assert.equal((await events(acme.organizationId, "support_access.used")).length, 0);
  assert.equal(await staffWrites(acme.organizationId), 0);

  const view = await call(acme.members.owner.accessToken, "GET", `${GRANTS}/${grantId}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.data.activity.useCount, 0);
  assert.deepEqual(view.body.data.events, []);
  assert.ok(!JSON.stringify(view.body).includes("Staff Agent"), "staff names stay out of customer views");
  const listed = await call(acme.members.organization_admin.accessToken, "GET", GRANTS);
  assert.equal(listed.body.data.grants.find((g: any) => g.id === grantId).activity.useCount, 0);
});

// Was: "a grant never reaches another organization, and organizations can't see or revoke each other's grants".
// The second half is unchanged. The first half now states the rule that replaced it: staff read
// Other Co directly, but a record is never served through another organization's path.
test("a record is never served through another organization's path, and organizations can't see or revoke each other's grants", async () => {
  const grantId = String((await SupportAccessGrant.findOne({ organizationId: acme.organizationId }).lean())!._id);

  const direct = await call(agentToken, "GET", `${ACCESS}/organizations/${other.organizationId}/rfps/${otherRfps[0]}`);
  assert.equal(direct.status, 200, JSON.stringify(direct.body));
  assert.equal(direct.body.data.rfp.event.eventName, "Other Co secret gala");
  const otherList = await call(agentToken, "GET", `${ACCESS}/organizations/${other.organizationId}/rfps`);
  assert.deepEqual(otherList.body.data.rfps.map((r: any) => r.id), otherRfps);
  // Other Co's proposal named under Acme, and Acme's under Other Co: exactly like an id that doesn't exist.
  const smuggled = await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps/${otherRfps[0]}`);
  const missing = await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps/${randomMongoId()}`);
  assert.equal(smuggled.status, 404);
  assert.equal(smuggled.body.code, "PROPOSAL_NOT_FOUND");
  assert.deepEqual(smuggled.body, missing.body);
  assert.equal((await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps/${otherRfps[0]}/vendor-responses`)).status, 404);
  assert.equal((await call(agentToken, "GET", `${ACCESS}/organizations/${other.organizationId}/rfps/${acmeRfps[0]}`)).status, 404);
  const borrowed = await call(agentToken, "GET", `${ACCESS}/organizations/${other.organizationId}/rfps/${acmeRfps[0]}/vendor-responses`);
  assert.equal(borrowed.status, 404);
  for (const res of [smuggled, borrowed]) assert.ok(!JSON.stringify(res.body).includes("secret gala") && !JSON.stringify(res.body).includes("Stage Audio"));
  // An organization that does not exist, and a malformed id.
  assert.equal((await call(agentToken, "GET", `${ACCESS}/organizations/${randomMongoId()}/rfps`)).body.code, "ORGANIZATION_NOT_FOUND");
  assert.equal((await call(agentToken, "GET", `${ACCESS}/organizations/not-an-id/rfps`)).status, 400);
  assert.equal(await staffWrites(acme.organizationId), 0);
  assert.equal(await staffWrites(other.organizationId), 0);

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

// Was: "AC: a revoked grant is refused on the next request".
test("revoking a grant still works for the customer and changes nothing for staff reads", async () => {
  const grantId = String((await SupportAccessGrant.findOne({ organizationId: acme.organizationId }).lean())!._id);
  const path = `${ACCESS}/organizations/${acme.organizationId}/rfps/${acmeRfps[0]}`;
  assert.equal((await call(agentToken, "GET", path)).status, 200);

  const revoked = await call(acme.members.owner.accessToken, "POST", `${GRANTS}/${grantId}/revoke`);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.data.status, "revoked");
  assert.equal(revoked.body.data.revokedBy.id, acme.members.owner.userId);

  for (const suffix of ["", "/vendor-responses"]) assert.equal((await call(agentToken, "GET", `${path}${suffix}`)).status, 200, suffix);
  assert.equal((await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps`)).status, 200);
  assert.ok((await call(agentToken, "GET", `${ACCESS}/grants`)).body.data.grants.some((g: any) => g.id === acme.organizationId));
  const [event] = await events(acme.organizationId, "support_access.revoked");
  assert.equal(String(event.actorUserId), acme.members.owner.userId);
  assert.equal(event.metadata.grantId, grantId);
  const past = await call(acme.members.owner.accessToken, "GET", `${GRANTS}/${grantId}`);
  assert.equal(past.body.data.status, "revoked");
  assert.equal(past.body.data.activity.useCount, 0);
  assert.equal(await staffWrites(acme.organizationId), 0);
});

// Was: "AC: an expired grant is refused; a grant for one RFP opens that RFP only".
test("a grant for one proposal does not narrow staff reads, and its expiry changes nothing for them", async () => {
  const created = await call(acme.members.owner.accessToken, "POST", GRANTS, { proposalId: acmeRfps[0], expiresInDays: 1 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const grantId = created.body.data.id;
  assert.equal(created.body.data.scope, "rfp");
  assert.equal(created.body.data.rfp.title, "Acme spring summit");

  assert.equal((await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps/${acmeRfps[1]}`)).status, 200);
  const list = await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps`);
  assert.deepEqual(list.body.data.rfps.map((r: any) => r.id).sort(), [...acmeRfps].sort());

  // Time passes: the stored expiry is now behind us.
  await SupportAccessGrant.collection.updateOne({ _id: oid(grantId) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps/${acmeRfps[0]}`)).status, 200);
  assert.equal((await call(agentToken, "GET", `${ACCESS}/organizations/${acme.organizationId}/rfps`)).status, 200);
  const view = await call(acme.members.owner.accessToken, "GET", `${GRANTS}/${grantId}`);
  assert.equal(view.body.data.status, "expired");
  assert.equal((await call(acme.members.owner.accessToken, "POST", `${GRANTS}/${grantId}/revoke`)).body.code, "SUPPORT_GRANT_EXPIRED");
  assert.equal(await staffWrites(acme.organizationId), 0);
});

// Was: "AC: ticket content is readable without a grant; the RFP behind the ticket needs one".
test("ticket content and the proposals behind the ticket are both readable by staff without a grant", async () => {
  const opened = await call(dxgCustomerToken, "POST", "/api/v1/support/tickets", { subject: "Budget table won't save", body: "It spins forever on my spring RFP.", category: "bug" });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const ticketId = opened.body.data.ticket.id;

  const ticket = await call(agentToken, "GET", `/api/v1/admin/support/tickets/${ticketId}`);
  assert.equal(ticket.status, 200, JSON.stringify(ticket.body));
  assert.ok(JSON.stringify(ticket.body).includes("It spins forever on my spring RFP."));
  assert.equal((await call(agentToken, "POST", `/api/v1/admin/support/tickets/${ticketId}/messages`, { body: "Looking into it." })).status, 201);

  assert.equal(await SupportAccessGrant.countDocuments({ organizationId: dxg.org }), 0, "no grant exists");
  const behind = await call(agentToken, "GET", `/api/v1/admin/support/tickets/${ticketId}/rfps`);
  assert.equal(behind.status, 200, JSON.stringify(behind.body));
  // The requester's proposals only.
  assert.deepEqual(behind.body.data.rfps.map((r: any) => r.id), [dxgCustomerRfp]);
  assert.equal((await call(agentToken, "GET", `${ACCESS}/organizations/${dxg.org}/rfps/${dxgCustomerRfp}`)).status, 200);
  const recorded = await SecurityAuditEvent.find({ organizationId: dxg.org, action: READ, "metadata.ticketId": ticketId }).lean();
  assert.deepEqual(recorded.map((e) => [String(e.actorUserId), e.targetId, e.metadata.resource]), [[String(dxg.agent), String(dxg.org), "ticket_proposals"]]);
  assert.equal(await SecurityAuditEvent.countDocuments({ action: /^support_access\.(used|denied)$/, organizationId: { $in: [dxg.org, oid(acme.organizationId), oid(other.organizationId)] } }), 0);

  // A ticket that does not exist is missing. (A customer organization's ticket: see
  // support-desk-cross-organization.test.ts.)
  assert.equal((await call(agentToken, "GET", `/api/v1/admin/support/tickets/${randomMongoId()}/rfps`)).status, 404);
});

// Rows written before the decision of 2026-11-17 stay in the customer organization's trail. The
// customer's grant list and detail must not show them. Last in the file, and the seeded rows are
// removed again, so the `staffWrites(...) === 0` checks above never see them.
test("stored support_access.used rows are kept but never shown on the customer's grant list or detail", async () => {
  const grant = await SupportAccessGrant.findOne({ organizationId: acme.organizationId, proposalId: null }).lean();
  assert.ok(grant, "the organization-wide grant created above");
  const grantId = String(grant!._id);
  const stored = (operation: string, targetId: string) => ({
    organizationId: oid(acme.organizationId), actorUserId: dxg.agent, action: "support_access.used", targetType: "proposal", targetId,
    decision: "allowed", reason: operation, correlationId: `stored-${tag}`,
    metadata: { grantId, operation, agentAccountType: "admin" }, createdAt: new Date(Date.now() - DAY), updatedAt: new Date(Date.now() - DAY),
  });
  await SecurityAuditEvent.collection.insertMany([stored("rfp.read", acmeRfps[0]), stored("rfp.vendor_responses", acmeRfps[0]), stored("rfp.read", acmeRfps[1])]);
  try {
    assert.equal((await events(acme.organizationId, "support_access.used")).length, 3, "the rows are stored");

    for (const role of ["owner", "organization_admin"] as const) {
      const listed = await call(acme.members[role].accessToken, "GET", GRANTS);
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      const mine = listed.body.data.grants.find((g: any) => g.id === grantId);
      assert.deepEqual(mine.activity, { useCount: 0, lastUsedAt: null }, role);
      for (const g of listed.body.data.grants) assert.deepEqual(g.activity, { useCount: 0, lastUsedAt: null }, role);

      const view = await call(acme.members[role].accessToken, "GET", `${GRANTS}/${grantId}`);
      assert.equal(view.status, 200, JSON.stringify(view.body));
      assert.deepEqual(view.body.data.activity, { useCount: 0, lastUsedAt: null }, role);
      assert.deepEqual(view.body.data.events, [], role);
      for (const body of [listed.body, view.body]) {
        const json = JSON.stringify(body);
        for (const hidden of [String(dxg.agent), "RFPilot Support", "Staff Agent", "rfp.read", "rfp.vendor_responses"]) assert.equal(json.includes(hidden), false, `${role}: ${hidden}`);
      }
    }
    // Hidden, not deleted.
    assert.equal((await events(acme.organizationId, "support_access.used")).length, 3);
  } finally {
    await SecurityAuditEvent.collection.deleteMany({ correlationId: `stored-${tag}` });
  }
});
