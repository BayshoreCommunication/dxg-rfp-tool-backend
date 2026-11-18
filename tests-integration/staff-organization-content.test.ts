// Owner decision 2026-11-17 (docs/DECISIONS.md): RFPilot staff (an `admins` account holding an
// admin role) VIEW everything in every organization with no grant, and what they do is recorded
// on the RFPilot side only. Through the real API on real MongoDB: two customer organizations
// with different data plus the staff organization. Staff reading A see only A, for every
// resource; nothing from B; no audit event lands in A or B; the event is in the staff
// organization; a customer Owner of A can call no staff route; and A's own audit endpoints
// return none of the hidden events even though stored rows exist.
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
import OrganizationVendor from "../modal/organizationVendorModel";
import Proposal from "../modal/proposalsModel";
import ProposalTemplate from "../modal/proposalTemplateModel";
import RefreshSession from "../modal/refreshSessionModel";
import SecurityAuditEvent from "../modal/securityAuditEventModel";
import SupportAccessGrant from "../modal/supportAccessGrantModel";
import Team from "../modal/teamModel";
import TeamMembership from "../modal/teamMembershipModel";
import User from "../modal/userModel";
import VendorResponse from "../modal/vendorResponseModel";
import { beginAuthenticatedSession } from "../src/modules/auth/composition";
import { closePostgres } from "../config/postgres";
import { closeSecurityRateLimitRedis } from "../middleware/securityRateLimit";
import { closeSupportRedis } from "../src/modules/supportDesk/infrastructure/redis/supportRedis";
import { cleanupOrganizations, ROLES, seedOrganization, type Fixture } from "./memberFixtures";

const tag = randomMongoId().slice(0, 10);
const oid = (value?: string) => new mongoose.Types.ObjectId(value);
const BASE = "/api/v1/admin/organizations";
const AUDIT_LOG = "/api/v1/organization/audit-events";
const READ = "platform.organization_content.read";
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

let server: http.Server;
let baseUrl: string;
let a: Fixture;
let b: Fixture;
let aId: mongoose.Types.ObjectId;
let bId: mongoose.Types.ObjectId;
let staffToken: string;
let superToken: string;
let impostorToken: string;
// RFPilot's own organization: two staff accounts and a `users` account holding a staff role.
const dxg = { org: oid(), staff: oid(), superAdmin: oid(), impostor: oid() };
// A deactivated member of A (the seeded members stay active so they can call the API).
const suspendedMember = oid();
const ids = {
  aProposal: oid(), aProposalTwo: oid(), bProposal: oid(), aResponse: oid(), bResponse: oid(),
  aTeam: oid(), aArchivedTeam: oid(), bTeam: oid(),
  aTemplate: oid(), aPersonalTemplate: oid(), bTemplate: oid(), aVendor: oid(), bVendor: oid(),
  aInvitation: oid(), aAcceptedInvitation: oid(), bInvitation: oid(),
};

// Everything that belongs to B. None of it may appear in an answer about A.
const B_STRINGS = [`B Retreat ${tag}`, `B Florist ${tag}`, `b-florist-${tag}@vendor.example`, `B Team ${tag}`, `B Template ${tag}`, `b-invitee-${tag}@example.com`, `B Lighting ${tag}`, `b-vendor-reply-${tag}@example.com`];
const A_STRINGS = [`A Gala ${tag}`, `A Summit ${tag}`, `A Caterers ${tag}`, `a-chef-${tag}@vendor.example`, `A Team North ${tag}`, `A House Template ${tag}`, `A Personal Template ${tag}`, `a-invitee-${tag}@example.com`, `A Stage Audio ${tag}`];
// Secrets and internal data planted in the fixtures. None may appear in any answer.
const SECRETS = ["not-a-real-hash", `invite-token-hash-${tag}`, `old-invite-token-hash-${tag}`, `internal-setting-${tag}`, `candidate-${tag}`, `stray-ai-payload-${tag}`, `google-subject-${tag}`, `vendor-doc-key-${tag}`];

const call = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
};
const sessionFor = async (userId: mongoose.Types.ObjectId, organizationId: mongoose.Types.ObjectId) =>
  (await beginAuthenticatedSession({ userId: String(userId), organizationId: String(organizationId), correlationId: randomMongoId() })).accessToken;
const eventCount = (organizationId: mongoose.Types.ObjectId) => SecurityAuditEvent.countDocuments({ organizationId });
const reads = (organizationId: mongoose.Types.ObjectId) => SecurityAuditEvent.find({ organizationId, action: READ }).sort({ createdAt: 1, _id: 1 }).lean();

// Every staff read route for one organization, with the resource it records.
const routesFor = (organizationId: string, proposalId: mongoose.Types.ObjectId, templateId: mongoose.Types.ObjectId): Array<[string, string, string | null]> => [
  [`${BASE}/${organizationId}/proposals`, "proposals", null],
  [`${BASE}/${organizationId}/proposals/${proposalId}`, "proposal", String(proposalId)],
  [`${BASE}/${organizationId}/proposals/${proposalId}/vendor-responses`, "vendor_responses", String(proposalId)],
  [`${BASE}/${organizationId}/members`, "members", null],
  [`${BASE}/${organizationId}/teams`, "teams", null],
  [`${BASE}/${organizationId}/templates`, "templates", null],
  [`${BASE}/${organizationId}/templates/${templateId}`, "template", String(templateId)],
  [`${BASE}/${organizationId}/vendors`, "vendors", null],
];

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);

  a = await seedOrganization(`A Events ${tag}`);
  b = await seedOrganization(`B Company ${tag}`);
  aId = oid(a.organizationId);
  bId = oid(b.organizationId);
  const at = new Date(NOW - DAY);

  await User.collection.updateOne({ _id: oid(a.members.planner.userId) }, { $set: { googleId: `google-subject-${tag}` } });
  await OrganizationMembership.collection.updateOne({ organizationId: aId, userId: oid(a.members.planner.userId) }, { $set: { lastSignedInAt: new Date(NOW - 3600_000) } });
  await User.collection.insertOne({ _id: suspendedMember, organizationId: aId, name: "Gone Person", email: `a-gone-${tag}@example.com`, password: "not-a-real-hash", role: "customer", isBlocked: false });
  await OrganizationMembership.collection.insertOne({ organizationId: aId, userId: suspendedMember, roles: ["planner"], status: "suspended", version: 1, suspendedAt: new Date(NOW - 1000), createdAt: new Date(NOW - 500), updatedAt: new Date(NOW - 500) });

  await Proposal.collection.insertMany([
    { _id: ids.aProposal, organizationId: aId, userId: oid(a.members.planner.userId), status: "unsubmitted", isDraft: true, isArchived: false, event: { eventName: `A Gala ${tag}` },
      proposalSettings: { internal: `internal-setting-${tag}` }, candidateApplicationIds: [`candidate-${tag}`], aiRawResponse: { provider: `stray-ai-payload-${tag}` }, createdAt: at, updatedAt: new Date(NOW - 1000) },
    { _id: ids.aProposalTwo, organizationId: aId, userId: oid(a.members.team_manager.userId), status: "unsubmitted", isDraft: true, isArchived: false, event: { eventName: `A Summit ${tag}` }, createdAt: at, updatedAt: new Date(NOW - 2000) },
    { _id: ids.bProposal, organizationId: bId, userId: oid(b.members.planner.userId), status: "unsubmitted", isDraft: true, isArchived: false, event: { eventName: `B Retreat ${tag}` }, createdAt: at, updatedAt: at },
  ]);
  await VendorResponse.collection.insertMany([
    { _id: ids.aResponse, organizationId: aId, proposalId: ids.aProposal, proposalOwnerId: oid(a.members.planner.userId), vendorName: `A Stage Audio ${tag}`, submittedBy: "Sam", email: `a-vendor-reply-${tag}@example.com`, message: "Quote attached",
      documents: [{ name: "quote.pdf", key: `vendor-doc-key-${tag}` }], currentVersionNumber: 1, createdAt: at, updatedAt: at },
    { _id: ids.bResponse, organizationId: bId, proposalId: ids.bProposal, proposalOwnerId: oid(b.members.planner.userId), vendorName: `B Lighting ${tag}`, submittedBy: "Lee", email: `b-vendor-reply-${tag}@example.com`, message: "Hello", documents: [], currentVersionNumber: 1, createdAt: at, updatedAt: at },
  ]);
  await Team.collection.insertMany([
    { _id: ids.aTeam, organizationId: aId, name: `A Team North ${tag}`, archived: false, archivedAt: null, createdAt: at, updatedAt: at },
    { _id: ids.aArchivedTeam, organizationId: aId, name: `A Team Old ${tag}`, archived: true, archivedAt: at, createdAt: at, updatedAt: at },
    { _id: ids.bTeam, organizationId: bId, name: `B Team ${tag}`, archived: false, archivedAt: null, createdAt: at, updatedAt: at },
  ]);
  await TeamMembership.collection.insertMany([
    { organizationId: aId, teamId: ids.aTeam, userId: oid(a.members.team_manager.userId), isManager: true, createdAt: at, updatedAt: at },
    { organizationId: aId, teamId: ids.aTeam, userId: oid(a.members.planner.userId), isManager: false, createdAt: at, updatedAt: at },
    { organizationId: bId, teamId: ids.bTeam, userId: oid(b.members.team_manager.userId), isManager: true, createdAt: at, updatedAt: at },
  ]);
  await ProposalTemplate.collection.insertMany([
    { _id: ids.aTemplate, organizationId: aId, ownerUserId: oid(a.members.owner.userId), scope: "organization", title: `A House Template ${tag}`, description: "House style", content: { event: { eventName: "Annual meeting" }, production: { notes: "Line array" } },
      presentationLayout: "template-one", publishedAt: at, publishedBy: oid(a.members.owner.userId), archived: false, archivedAt: null, createdAt: at, updatedAt: at },
    { _id: ids.aPersonalTemplate, organizationId: aId, ownerUserId: oid(a.members.planner.userId), scope: "personal", title: `A Personal Template ${tag}`, description: "", content: { event: {} }, presentationLayout: null, publishedAt: null, publishedBy: null, archived: false, archivedAt: null, createdAt: at, updatedAt: at },
    { _id: ids.bTemplate, organizationId: bId, ownerUserId: oid(b.members.owner.userId), scope: "organization", title: `B Template ${tag}`, description: "", content: { event: { eventName: "B event" } }, presentationLayout: null, publishedAt: at, publishedBy: oid(b.members.owner.userId), archived: false, archivedAt: null, createdAt: at, updatedAt: at },
  ]);
  await OrganizationVendor.collection.insertMany([
    { _id: ids.aVendor, organizationId: aId, company: `A Caterers ${tag}`, category: "catering", contacts: [{ name: "Chef", email: `a-chef-${tag}@vendor.example` }], addedBy: oid(a.members.owner.userId), archived: false, archivedAt: null, createdAt: at, updatedAt: at },
    { _id: ids.bVendor, organizationId: bId, company: `B Florist ${tag}`, category: "flowers", contacts: [{ name: "Flo", email: `b-florist-${tag}@vendor.example` }], addedBy: oid(b.members.owner.userId), archived: false, archivedAt: null, createdAt: at, updatedAt: at },
  ]);
  const invitation = (id: mongoose.Types.ObjectId, organizationId: mongoose.Types.ObjectId, invitedBy: string, email: string, status: string, tokenHash: string | null) => ({
    _id: id, organizationId, email, role: "planner", teamId: null, invitedBy: oid(invitedBy), status, tokenHash, previousTokenHashes: tokenHash ? [`old-${tokenHash}`] : [],
    expiresAt: new Date(NOW + 3 * DAY), createdAt: at, updatedAt: at,
  });
  await Invitation.collection.insertMany([
    invitation(ids.aInvitation, aId, a.members.owner.userId, `a-invitee-${tag}@example.com`, "pending", `invite-token-hash-${tag}`),
    invitation(ids.aAcceptedInvitation, aId, a.members.owner.userId, `a-joined-${tag}@example.com`, "accepted", null),
    invitation(ids.bInvitation, bId, b.members.owner.userId, `b-invitee-${tag}@example.com`, "pending", `b-invite-token-hash-${tag}`),
  ]);

  await Organization.collection.insertOne({ _id: dxg.org, name: `RFPilot ${tag}`, slug: `intg-members-dxg-${tag}`, status: "active", kind: "customer", plan: "free_trial" });
  for (const [id, name, role] of [[dxg.staff, "Dana Staff", "admin"], [dxg.superAdmin, "Sam Super", "super_admin"]] as const) {
    await Admin.collection.insertOne({ _id: id, organizationId: dxg.org, name, email: `${role}-content-${tag}@example.com`, password: "not-a-real-hash", role, isBlocked: false });
    await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: id, roles: [role === "admin" ? "dxg_admin" : "super_admin"], status: "active", version: 1 });
  }
  // A `users` account that holds a staff membership role and an administrative account role.
  await User.collection.insertOne({ _id: dxg.impostor, organizationId: dxg.org, name: "Member With Staff Role", email: `impostor-content-${tag}@example.com`, password: "not-a-real-hash", role: "admin", isBlocked: false });
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
    const orgIds = [dxg.org, ...(aId ? [aId] : []), ...(bId ? [bId] : [])];
    const db = mongoose.connection.db!;
    for (const name of ["vendorresponses", "proposaltemplates", "organizationvendors", "invitations", "supportaccessgrants", "securityauditevents"]) {
      await db.collection(name).deleteMany({ organizationId: { $in: orgIds } });
    }
    await OrganizationMembership.collection.deleteMany({ organizationId: dxg.org });
    await RefreshSession.deleteMany({ organizationId: dxg.org });
    await User.collection.deleteMany({ organizationId: dxg.org });
    await Admin.collection.deleteMany({ _id: { $in: [dxg.staff, dxg.superAdmin] } });
    await Organization.collection.deleteOne({ _id: dxg.org });
    await cleanupOrganizations();
  }
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
  await closeSupportRedis();
});

test("staff reading A see A's content for every resource, with no grant, and nothing of B or of any secret", async () => {
  assert.equal(await SupportAccessGrant.countDocuments({ organizationId: { $in: [aId, bId] } }), 0, "no grant exists anywhere");
  const answers: Record<string, Record<string, any>> = {};
  for (const [path, resource] of routesFor(a.organizationId, ids.aProposal, ids.aTemplate)) {
    const res = await call(staffToken, "GET", path);
    assert.equal(res.status, 200, `${path}: ${res.text}`);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.organizationId, a.organizationId, path);
    for (const foreign of [...B_STRINGS, b.organizationId, ...Object.values(b.members).map((member) => member.userId), ...Object.values(b.members).map((member) => member.email)]) {
      assert.equal(res.text.includes(foreign), false, `${path} returned something of B: ${foreign}`);
    }
    for (const secret of SECRETS) assert.equal(res.text.includes(secret), false, `${path} returned a secret: ${secret}`);
    for (const key of ["password", "tokenHash", "previousTokenHashes", "googleId", "federatedIdentities", "proposalSettings", "candidateApplicationIds", "aiRawResponse", "__v", "delivery", "twoFactor", "refreshToken", "accessGrant"]) {
      assert.equal(res.text.includes(`"${key}"`), false, `${path} returned the field ${key}`);
    }
    answers[resource] = res.body.data;
  }

  // Proposals: list (newest first), detail, vendor responses.
  assert.deepEqual(answers.proposals.rfps.map((row: any) => [row.id, row.eventName, row.owner.id]), [
    [String(ids.aProposal), `A Gala ${tag}`, a.members.planner.userId],
    [String(ids.aProposalTwo), `A Summit ${tag}`, a.members.team_manager.userId],
  ]);
  assert.deepEqual(answers.proposals.pagination, { page: 1, perPage: 20, total: 2, totalPages: 1 });
  assert.deepEqual(Object.keys(answers.proposals).sort(), ["organizationId", "pagination", "rfps"]);
  assert.equal(answers.proposal.rfp.id, String(ids.aProposal));
  assert.equal(answers.proposal.rfp.event.eventName, `A Gala ${tag}`);
  assert.equal(answers.proposal.rfp.organizationId, undefined);
  assert.deepEqual(answers.proposal.owner, { id: a.members.planner.userId, name: "planner person", email: a.members.planner.email });
  assert.deepEqual(answers.vendor_responses.vendorResponses.map((row: any) => [row.id, row.vendorName, row.documentCount]), [[String(ids.aResponse), `A Stage Audio ${tag}`, 1]]);
  const search = await call(staffToken, "GET", `${BASE}/${a.organizationId}/proposals?search=${encodeURIComponent("summit")}`);
  assert.deepEqual(search.body.data.rfps.map((row: any) => row.id), [String(ids.aProposalTwo)]);

  // Members: one row per membership, with teams and dates; pending invitations as their own list.
  assert.equal(answers.members.members.length, ROLES.length + 1);
  assert.deepEqual(answers.members.pagination, { page: 1, perPage: 50, total: ROLES.length + 1, totalPages: 1 });
  const byId = new Map<string, any>(answers.members.members.map((member: any) => [member.userId, member]));
  for (const role of ROLES) {
    const member = byId.get(a.members[role].userId);
    assert.ok(member, role);
    assert.deepEqual(Object.keys(member).sort(), ["email", "joinedAt", "lastSignedInAt", "name", "roles", "status", "teams", "userId"]);
    assert.deepEqual([member.name, member.email, member.roles], [`${role} person`, a.members[role].email, [role]]);
    assert.ok(member.joinedAt, "joined date");
  }
  for (const role of ROLES) assert.equal(byId.get(a.members[role].userId).status, "active", role);
  assert.deepEqual([byId.get(String(suspendedMember)).name, byId.get(String(suspendedMember)).email, byId.get(String(suspendedMember)).status, byId.get(String(suspendedMember)).roles],
    ["Gone Person", `a-gone-${tag}@example.com`, "suspended", ["planner"]]);
  assert.ok(byId.get(a.members.planner.userId).lastSignedInAt);
  assert.deepEqual(byId.get(a.members.team_manager.userId).teams, [{ id: String(ids.aTeam), name: `A Team North ${tag}`, archived: false, isManager: true }]);
  assert.deepEqual(byId.get(a.members.planner.userId).teams, [{ id: String(ids.aTeam), name: `A Team North ${tag}`, archived: false, isManager: false }]);
  assert.deepEqual(byId.get(a.members.owner.userId).teams, []);
  assert.deepEqual(answers.members.pendingInvitations.map((row: any) => [row.id, row.email, row.role, row.status]), [[String(ids.aInvitation), `a-invitee-${tag}@example.com`, "planner", "pending"]]);
  assert.deepEqual(Object.keys(answers.members.pendingInvitations[0]).sort(), ["createdAt", "email", "expiresAt", "id", "role", "status"]);
  assert.equal(answers.members.pendingInvitationsTotal, 1);

  // Teams: active first, with member count and managers.
  assert.deepEqual(answers.teams.teams.map((team: any) => [team.id, team.name, team.archived, team.memberCount, team.managers]), [
    [String(ids.aTeam), `A Team North ${tag}`, false, 2, [{ id: a.members.team_manager.userId, name: "team_manager person", email: a.members.team_manager.email }]],
    [String(ids.aArchivedTeam), `A Team Old ${tag}`, true, 0, []],
  ]);

  // Templates: the organization's and every member's personal ones, with the owner; content on the detail.
  assert.deepEqual(answers.templates.templates.map((template: any) => [template.id, template.scope, template.owner.id]), [
    [String(ids.aTemplate), "organization", a.members.owner.userId],
    [String(ids.aPersonalTemplate), "personal", a.members.planner.userId],
  ]);
  assert.equal(answers.templates.templates[0].eventName, "Annual meeting");
  assert.equal(answers.templates.templates[0].content, undefined);
  assert.deepEqual(answers.template.template.content, { event: { eventName: "Annual meeting" }, production: { notes: "Line array" } });
  assert.deepEqual(answers.template.template.owner, { id: a.members.owner.userId, name: "owner person", email: a.members.owner.email });

  // Vendors: as members read the list.
  assert.deepEqual(answers.vendors.vendors.map((vendor: any) => [vendor.id, vendor.company, vendor.category, vendor.contacts, vendor.archived]), [
    [String(ids.aVendor), `A Caterers ${tag}`, "catering", [{ name: "Chef", email: `a-chef-${tag}@vendor.example` }], false],
  ]);

  // The second staff role reads too, and B is read through B's own path only.
  assert.equal((await call(superToken, "GET", `${BASE}/${a.organizationId}/members`)).status, 200);
  const bProposals = await call(staffToken, "GET", `${BASE}/${b.organizationId}/proposals`);
  assert.deepEqual(bProposals.body.data.rfps.map((row: any) => row.id), [String(ids.bProposal)]);
  for (const mine of A_STRINGS) assert.equal(bProposals.text.includes(mine), false, mine);
});

test("a record is never served through another organization's path; ids are validated; an unknown organization is a 404", async () => {
  const before = (await reads(dxg.org)).length;
  // B's records asked for through A, and A's through B: the same answer as an id that doesn't exist.
  for (const [organizationId, proposalId, templateId] of [[a.organizationId, ids.bProposal, ids.bTemplate], [b.organizationId, ids.aProposal, ids.aTemplate]] as const) {
    const proposal = await call(staffToken, "GET", `${BASE}/${organizationId}/proposals/${proposalId}`);
    const missing = await call(staffToken, "GET", `${BASE}/${organizationId}/proposals/${randomMongoId()}`);
    assert.equal(proposal.status, 404);
    assert.equal(proposal.body.code, "PROPOSAL_NOT_FOUND");
    assert.deepEqual(proposal.body, missing.body);
    const responses = await call(staffToken, "GET", `${BASE}/${organizationId}/proposals/${proposalId}/vendor-responses`);
    assert.equal(responses.status, 404);
    assert.equal(responses.body.data, undefined);
    const template = await call(staffToken, "GET", `${BASE}/${organizationId}/templates/${templateId}`);
    assert.equal(template.status, 404);
    assert.equal(template.body.code, "TEMPLATE_NOT_FOUND");
    for (const res of [proposal, responses, template]) for (const leaked of [...A_STRINGS, ...B_STRINGS]) assert.equal(res.text.includes(leaked), false, leaked);
  }
  for (const [path] of routesFor("not-an-id", ids.aProposal, ids.aTemplate)) {
    const res = await call(staffToken, "GET", path);
    assert.deepEqual([res.status, res.body.code], [400, "INVALID_ORGANIZATION_ID"], path);
  }
  for (const [path] of routesFor(randomMongoId(), ids.aProposal, ids.aTemplate)) {
    const res = await call(staffToken, "GET", path);
    assert.deepEqual([res.status, res.body.code], [404, "ORGANIZATION_NOT_FOUND"], path);
  }
  assert.equal((await call(staffToken, "GET", `${BASE}/${a.organizationId}/proposals/nope`)).status, 400);
  assert.equal((await call(staffToken, "GET", `${BASE}/${a.organizationId}/templates/nope`)).status, 400);
  assert.equal((await call(staffToken, "GET", `${BASE}/${a.organizationId}/templates?scope=${encodeURIComponent("{$ne:1}")}`)).status, 400);
  // The organization in the query or a header changes nothing: the path decides.
  const pinned = await call(staffToken, "GET", `${BASE}/${a.organizationId}/vendors?organizationId=${b.organizationId}`);
  assert.deepEqual(pinned.body.data.vendors.map((vendor: any) => vendor.id), [String(ids.aVendor)]);
  // Only the one successful read was recorded.
  assert.equal((await reads(dxg.org)).length, before + 1);
});

test("audit: one event per read in the staff organization; zero events in A or B", async () => {
  const [aBefore, bBefore, staffBefore] = [await eventCount(aId), await eventCount(bId), (await reads(dxg.org)).length];
  const routes = [...routesFor(a.organizationId, ids.aProposal, ids.aTemplate), ...routesFor(b.organizationId, ids.bProposal, ids.bTemplate)];
  for (const [path] of routes) assert.equal((await call(staffToken, "GET", path)).status, 200, path);

  const written = (await reads(dxg.org)).slice(staffBefore);
  assert.deepEqual(
    written.map((event) => [String(event.actorUserId), event.targetType, event.targetId, event.decision, event.reason, event.metadata]),
    routes.map(([path, resource, recordId]) => [
      String(dxg.staff), "organization", path.includes(a.organizationId) ? a.organizationId : b.organizationId, "allowed", resource,
      { agentAccountType: "admin", resource, ...(recordId ? { recordId } : {}) },
    ]),
  );
  assert.equal(await eventCount(aId), aBefore, "nothing is written to A's audit trail");
  assert.equal(await eventCount(bId), bBefore, "nothing is written to B's audit trail");
  assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: { $in: [aId, bId] }, $or: [{ actorUserId: { $in: [dxg.staff, dxg.superAdmin] } }, { action: /^(platform\.|support_access\.(used|denied))/ }] }), 0);
});

test("trust boundary: no customer role, and no `users` account holding a staff role, can call any staff route", async () => {
  const staffBefore = (await reads(dxg.org)).length;
  const own = routesFor(a.organizationId, ids.aProposal, ids.aTemplate);
  const foreign = routesFor(b.organizationId, ids.bProposal, ids.bTemplate);
  const older = [
    "/api/v1/admin/support-access/grants",
    `/api/v1/admin/support-access/organizations/${a.organizationId}/rfps`,
    `/api/v1/admin/support-access/organizations/${a.organizationId}/rfps/${ids.aProposal}`,
    `/api/v1/admin/support-access/organizations/${a.organizationId}/rfps/${ids.aProposal}/vendor-responses`,
  ];
  for (const role of ROLES) {
    for (const path of [...own, ...foreign].map(([path]) => path).concat(older)) {
      const res = await call(a.members[role].accessToken, "GET", path);
      assert.equal(res.status, 403, `${role} ${path}`);
      assert.equal(res.body.data, undefined);
      for (const leaked of [...A_STRINGS, ...B_STRINGS]) assert.equal(res.text.includes(leaked), false, leaked);
    }
  }
  for (const path of [...own.map(([path]) => path), ...older]) {
    const res = await call(impostorToken, "GET", path);
    assert.equal(res.status, 403, path);
    assert.ok(["STAFF_ACCESS_FORBIDDEN", "SUPPORT_ACCESS_FORBIDDEN"].includes(res.body.code), `${path}: ${res.body.code}`);
    assert.equal(res.body.data, undefined);
  }
  assert.equal((await fetch(`${baseUrl}${own[0][0]}`)).status, 401);
  // The routes are read-only: there is nothing to write to.
  const stored = async () => [await Proposal.countDocuments({ organizationId: aId }), await ProposalTemplate.countDocuments({ organizationId: aId }), await OrganizationVendor.countDocuments({ organizationId: aId }), await Team.countDocuments({ organizationId: aId }), await OrganizationMembership.countDocuments({ organizationId: aId })];
  const storedBefore = await stored();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const [path] of own) {
      const res = await call(staffToken, method, path, {});
      assert.ok(res.status >= 400, `${method} ${path} ${res.status}`);
      assert.equal(res.body.data, undefined);
    }
  }
  assert.deepEqual(await stored(), storedBefore);
  assert.equal((await reads(dxg.org)).length, staffBefore, "a refused call records nothing");
});

test("A's customer audit endpoints return none of the hidden events, even though stored rows exist", async () => {
  // Stored rows as earlier releases wrote them into A, plus a plan change and a placement.
  const base = { organizationId: aId, actorUserId: dxg.staff, correlationId: randomMongoId() };
  await SecurityAuditEvent.create([
    { ...base, action: "support_access.used", targetType: "proposal", targetId: String(ids.aProposal), decision: "allowed", reason: "rfp.read", metadata: { grantId: `stored-grant-${tag}`, operation: "rfp.read", agentAccountType: "admin" } },
    { ...base, action: "support_access.denied", targetType: "organization", targetId: a.organizationId, decision: "denied", reason: "no_active_grant", metadata: { operation: "rfp.list", agentAccountType: "admin" } },
    { ...base, actorUserId: oid(a.members.owner.userId), action: "support_access.granted", targetType: "organization", targetId: a.organizationId, decision: "created", reason: "customer_granted", metadata: { grantId: `stored-grant-${tag}`, scope: "organization" } },
    { ...base, actorUserId: oid(a.members.owner.userId), action: "support_access.revoked", targetType: "organization", targetId: a.organizationId, decision: "revoked", reason: "customer_revoked", metadata: { grantId: `stored-grant-${tag}` } },
    { ...base, action: "organization.plan_changed", targetType: "organization", targetId: a.organizationId, decision: "allowed", reason: "staff_plan_change", metadata: { fromPlan: "free_trial", toPlan: "full_access" } },
    { ...base, action: "organization.legacy_customer.placed", targetType: "user", targetId: a.members.planner.userId, decision: "allowed", reason: "legacy_customer_placed", metadata: { role: "planner" } },
    { ...base, action: "organization.legacy_customer.placement_rolled_back", targetType: "user", targetId: a.members.planner.userId, decision: "allowed", reason: "placement_rolled_back", metadata: {} },
  ]);
  const hidden = await SecurityAuditEvent.find({ organizationId: aId, action: /^(support_access\.|organization\.plan_changed|organization\.legacy_customer\.)/ }).select("_id action").lean();
  assert.equal(hidden.length, 7, "the rows are stored");
  // Staff also read A just now; that is not in A's trail at all.
  assert.equal((await call(staffToken, "GET", `${BASE}/${a.organizationId}/members`)).status, 200);

  for (const who of [a.members.owner, a.members.organization_admin]) {
    for (const route of [AUDIT_LOG, `${AUDIT_LOG}/export`]) {
      for (const query of ["?limit=100", "?actor=support", `?actor=${dxg.staff}`, `?actor=${a.members.owner.userId}&limit=100`, "?category=settings", "?category=members"]) {
        const res = await call(who.accessToken, "GET", `${route}${query}`);
        assert.equal(res.status, 200, `${route}${query}: ${res.text}`);
        for (const row of hidden) assert.equal(res.text.includes(String(row._id)), false, `${route}${query} returned ${row.action}`);
        for (const text of ["support_access", "Support access", "RFPilot Support", "plan_changed", "legacy_customer", "platform.", `stored-grant-${tag}`, String(dxg.staff), "Dana Staff"]) {
          assert.equal(res.text.includes(text), false, `${route}${query}: ${text}`);
        }
      }
      for (const query of [...new Set(hidden.map((row) => row.action))].map((action) => `?action=${action}`).concat("?category=support_access", `?action=${READ}`)) {
        const res = await call(who.accessToken, "GET", `${route}${query}`);
        assert.equal(res.status, 400, `${route}${query}`);
        assert.equal(res.body.code, "AUDIT_FILTER_INVALID");
      }
    }
    const filters = await call(who.accessToken, "GET", `${AUDIT_LOG}/filters`);
    assert.equal(filters.status, 200);
    assert.equal(filters.body.data.supportActor, undefined);
    assert.equal(filters.body.data.categories.some((category: any) => category.key === "support_access"), false);
    for (const text of ["support_access", "RFPilot", "plan_changed", "legacy_customer", "platform."]) assert.equal(filters.text.includes(text), false, text);
  }
  // The log still works: A's Owner sees their own sign-in.
  const own = await call(a.members.owner.accessToken, "GET", `${AUDIT_LOG}?action=auth.session.created&actor=${a.members.owner.userId}`);
  assert.equal(own.status, 200);
  assert.ok(own.body.data.events.length >= 1);
});
