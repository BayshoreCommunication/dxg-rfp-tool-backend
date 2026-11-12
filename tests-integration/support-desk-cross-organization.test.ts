// The helpdesk across organizations, through the real API on real MongoDB.
//
// Production bug (2026-11-12): a customer Owner opened a ticket in their own organization and it
// never reached RFPilot staff. The inbox, search and the ticket's own URL were all bounded to the
// staff member's organization. This suite is that case end to end, plus the boundary around it:
// only an `admins` account with a staff role works every organization's tickets; customers stay
// inside their own; and the proposals behind a ticket still need a grant from the ticket's
// organization.
import { TEST_MONGODB_DB_NAME } from "./env";
import { connectMongo, disconnectMongo, ensureMigrated, ensureServices, randomMongoId } from "./setup";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import http from "node:http";
import mongoose from "mongoose";
import app from "../server";
import Admin from "../modal/adminModel";
import Notification from "../modal/notificationModel";
import Organization from "../modal/organizationModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import RefreshSession from "../modal/refreshSessionModel";
import SecurityAuditEvent from "../modal/securityAuditEventModel";
import SupportMessage from "../modal/supportMessageModel";
import SupportTicket from "../modal/supportTicketModel";
import User from "../modal/userModel";
import { beginAuthenticatedSession } from "../src/modules/auth/composition";
import { closePostgres } from "../config/postgres";
import { closeSecurityRateLimitRedis } from "../middleware/securityRateLimit";
import { closeSupportRedis } from "../src/modules/supportDesk/infrastructure/redis/supportRedis";
import { cleanupOrganizations, createProposals, seedOrganization, type Fixture } from "./memberFixtures";

const tag = randomMongoId().slice(0, 10);
const oid = (value?: string) => new mongoose.Types.ObjectId(value);
const CUSTOMER = "/api/v1/support";
const AGENT = "/api/v1/admin/support";
const GRANTS = "/api/v1/organization/support-grants";
const BAYSHORE_NAME = `Bayshore Events ${tag}`;
const ACME_NAME = `Acme Planning ${tag}`;
const SUBJECT = `QA check ${tag}: test ticket, please ignore`;

let server: http.Server;
let baseUrl: string;
let bayshore: Fixture;
let acme: Fixture;
let bayshoreOwnerRfps: string[];
// RFPilot's own organization: two staff accounts (`admins`), a `users` account holding a staff
// membership role (the impostor), and a `users` account whose account role is administrative
// (an agent before this change: it keeps its own organization, nothing more).
const dxg = { org: oid(), staff: oid(), staffTwo: oid(), impostor: oid(), legacyAgent: oid(), customer: oid() };
let staffToken: string;
let staffTwoToken: string;
let impostorToken: string;
let legacyAgentToken: string;
let dxgCustomerToken: string;
let bayshoreTicketId: string;
let acmeTicketId: string;
let dxgTicketId: string;

const call = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const sessionFor = async (userId: mongoose.Types.ObjectId, organizationId: mongoose.Types.ObjectId) =>
  (await beginAuthenticatedSession({ userId: String(userId), organizationId: String(organizationId), correlationId: randomMongoId() })).accessToken;
const search = (text: string) => `${AGENT}/tickets?status=all&perPage=50&search=${encodeURIComponent(text)}`;
const ids = (res: { body: Record<string, any> }) => (res.body.data.tickets as Array<{ id: string }>).map((t) => t.id);

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);

  bayshore = await seedOrganization(BAYSHORE_NAME);
  acme = await seedOrganization(ACME_NAME);
  bayshoreOwnerRfps = await createProposals(bayshore.organizationId, bayshore.members.owner.userId, 2);
  await createProposals(bayshore.organizationId, bayshore.members.planner.userId, 1);
  await createProposals(acme.organizationId, acme.members.owner.userId, 1);

  await Organization.collection.insertOne({ _id: dxg.org, name: `DXG Agency ${tag}`, slug: `intg-members-dxg-${tag}`, status: "active", kind: "customer", plan: "free_trial" });
  for (const [id, name, role] of [[dxg.staff, "Dana Staff", "admin"], [dxg.staffTwo, "Eli Staff", "super_admin"]] as const) {
    await Admin.collection.insertOne({ _id: id, organizationId: dxg.org, name, email: `${role}-${tag}@example.com`, password: "not-a-real-hash", role, isBlocked: false });
    await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: id, roles: [role === "admin" ? "dxg_admin" : "super_admin"], status: "active", version: 1 });
  }
  for (const [id, name, accountRole, membershipRole] of [
    [dxg.impostor, "Member With Staff Role", "customer", "dxg_admin"],
    [dxg.legacyAgent, "Users Account With Admin Role", "admin", "dxg_admin"],
    [dxg.customer, "Legacy Customer", "customer", "planner"],
  ] as const) {
    await User.collection.insertOne({ _id: id, organizationId: dxg.org, name, email: `${name.replace(/\s+/g, "-").toLowerCase()}-${tag}@example.com`, password: "not-a-real-hash", role: accountRole, isBlocked: false });
    await OrganizationMembership.collection.insertOne({ organizationId: dxg.org, userId: id, roles: [membershipRole], status: "active", version: 1 });
  }
  staffToken = await sessionFor(dxg.staff, dxg.org);
  staffTwoToken = await sessionFor(dxg.staffTwo, dxg.org);
  impostorToken = await sessionFor(dxg.impostor, dxg.org);
  legacyAgentToken = await sessionFor(dxg.legacyAgent, dxg.org);
  dxgCustomerToken = await sessionFor(dxg.customer, dxg.org);

  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    const orgIds = [dxg.org, ...(bayshore ? [oid(bayshore.organizationId)] : []), ...(acme ? [oid(acme.organizationId)] : [])];
    const db = mongoose.connection.db!;
    for (const name of ["supportaccessgrants", "supporttickets", "supportmessages", "supportticketcounters", "supportattachments", "supportcannedreplies", "notifications", "securityauditevents"]) {
      await db.collection(name).deleteMany({ organizationId: { $in: orgIds } });
    }
    await OrganizationMembership.collection.deleteMany({ organizationId: dxg.org });
    await RefreshSession.deleteMany({ organizationId: dxg.org });
    await User.collection.deleteMany({ organizationId: dxg.org });
    await Admin.collection.deleteMany({ _id: { $in: [dxg.staff, dxg.staffTwo] } });
    await Organization.collection.deleteOne({ _id: dxg.org });
    await cleanupOrganizations();
  }
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
  await closeSupportRedis();
});

test("the production case: a customer Owner opens a ticket; staff list it, find it, open it and reply; the customer sees the reply", async () => {
  const owner = bayshore.members.owner;
  const opened = await call(owner.accessToken, "POST", `${CUSTOMER}/tickets`, { subject: SUBJECT, body: "Checking that support can see this.", category: "other" });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  bayshoreTicketId = opened.body.data.ticket.id;
  assert.equal(opened.body.data.ticket.organizationId, bayshore.organizationId);
  const number = opened.body.data.ticket.ticketNumber;

  // In the inbox (default view: active tickets), with the customer's organization on it.
  const inbox = await call(staffToken, "GET", `${AGENT}/tickets?perPage=50&organization=${bayshore.organizationId}`);
  assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
  assert.equal(inbox.body.data.scope, "all_organizations");
  assert.deepEqual(ids(inbox), [bayshoreTicketId]);
  assert.deepEqual(inbox.body.data.tickets[0].organization, { id: bayshore.organizationId, name: BAYSHORE_NAME });
  assert.equal(inbox.body.data.tickets[0].requester.email, owner.email);
  // Without the organization filter it is there too, among every organization's tickets.
  const everything = await call(staffToken, "GET", `${AGENT}/tickets?perPage=50&sort=recent`);
  assert.ok(ids(everything).includes(bayshoreTicketId));

  // Found by subject, by the organization's name and by the requester's email.
  assert.deepEqual(ids(await call(staffToken, "GET", search(SUBJECT))), [bayshoreTicketId]);
  assert.deepEqual(ids(await call(staffToken, "GET", search(BAYSHORE_NAME))), [bayshoreTicketId]);
  assert.deepEqual(ids(await call(staffToken, "GET", search(owner.email))), [bayshoreTicketId]);

  // Opened by its id.
  const detail = await call(staffToken, "GET", `${AGENT}/tickets/${bayshoreTicketId}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.deepEqual(detail.body.data.organization, { id: bayshore.organizationId, name: BAYSHORE_NAME });
  assert.equal(detail.body.data.ticket.ticketNumber, number);
  assert.equal(detail.body.data.requester.email, owner.email);
  assert.ok(detail.body.data.messages.some((m: any) => m.body === "Checking that support can see this."));

  // Answered.
  const reply = await call(staffToken, "POST", `${AGENT}/tickets/${bayshoreTicketId}/messages`, { body: "We can see it. Thanks for checking." });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  assert.equal(reply.body.data.ticket.status, "waiting_on_customer");
  // The reply is stored in the customer's organization, not the agent's.
  const stored = await SupportMessage.findOne({ _id: reply.body.data.message.id }).lean(); // scope-exempt: test assertion on one row
  assert.equal(String(stored?.organizationId), bayshore.organizationId);

  // The customer sees it, as RFPilot support, with the number they were given.
  assert.equal((await call(owner.accessToken, "GET", `${CUSTOMER}/tickets/unread-count`)).body.data.unreadTickets, 1);
  const seen = await call(owner.accessToken, "GET", `${CUSTOMER}/tickets/${bayshoreTicketId}`);
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.equal(seen.body.data.ticket.ticketNumber, number);
  assert.ok(seen.body.data.messages.some((m: any) => m.body === "We can see it. Thanks for checking." && m.authorRole === "agent"));
  assert.equal(seen.body.data.assignee.name, "RFPilot support");
  assert.ok(!JSON.stringify(seen.body).includes("Dana Staff"));
  const bell = await Notification.find({ organizationId: oid(bayshore.organizationId), userId: oid(owner.userId), type: "support_ticket" }).lean();
  assert.ok(bell.some((n) => n.metadata?.ticketId === bayshoreTicketId && n.metadata?.audience === "requester"));
  // The customer can keep the conversation going.
  assert.equal((await call(owner.accessToken, "POST", `${CUSTOMER}/tickets/${bayshoreTicketId}/messages`, { body: "Great, thank you." })).status, 201);

  // Audit decision: reading and answering a ticket is ordinary helpdesk work and writes
  // nothing to the customer's audit log (PRD P0-9: tickets work without a grant).
  assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: oid(bayshore.organizationId), actorUserId: dxg.staff }), 0);
});

test("notifications: staff are alerted for a customer organization's ticket", async () => {
  const ticket = await SupportTicket.findOne({ _id: oid(bayshoreTicketId), organizationId: oid(bayshore.organizationId) }).lean();
  // New tickets are given to RFPilot staff. Before the fix nobody in the customer's
  // organization qualified, so the ticket stayed unowned and no one was told.
  assert.ok(ticket?.assigneeUserId, "the ticket has an owner");
  assert.ok(await Admin.exists({ _id: ticket!.assigneeUserId }), "the owner is an admins account");
  const forOwner = await Notification.find({ userId: ticket!.assigneeUserId, type: "support_ticket", "metadata.ticketId": bayshoreTicketId }).lean(); // scope-exempt: test assertion, the owner sits in the staff organization
  assert.ok(forOwner.some((n) => n.title.startsWith("New support ticket") && n.title.includes(BAYSHORE_NAME)), "the owner was told about the new ticket");
  assert.ok(forOwner.some((n) => n.title.startsWith("Reply on")), "the owner was told about the customer's reply");

  // Unowned: every staff account is alerted when the customer writes again.
  assert.equal((await call(staffToken, "PATCH", `${AGENT}/tickets/${bayshoreTicketId}`, { assigneeUserId: null })).status, 200);
  assert.equal((await call(bayshore.members.owner.accessToken, "POST", `${CUSTOMER}/tickets/${bayshoreTicketId}/messages`, { body: "One more thing." })).status, 201);
  for (const staffId of [dxg.staff, dxg.staffTwo]) {
    const alerts = await Notification.find({ organizationId: dxg.org, userId: staffId, type: "support_ticket", "metadata.ticketId": bayshoreTicketId }).lean();
    assert.ok(alerts.some((n) => n.message.includes("One more thing.")), `staff ${String(staffId)} was alerted`);
  }
  // The unread figure on the staff stat cards counts the customer's ticket.
  const before = (await call(staffToken, "GET", `${AGENT}/metrics`)).body.data.unreadForAgents;
  await call(staffToken, "GET", `${AGENT}/tickets/${bayshoreTicketId}`);
  const afterRead = (await call(staffToken, "GET", `${AGENT}/metrics`)).body.data.unreadForAgents;
  assert.ok(before - afterRead >= 1, `unread dropped after reading (${before} -> ${afterRead})`);
});

test("numbering: each organization keeps its own numbers, and staff tell tickets apart by organization", async () => {
  const acmeOpened = await call(acme.members.owner.accessToken, "POST", `${CUSTOMER}/tickets`, { subject: `Acme question ${tag}`, body: "How do I invite vendors?" });
  assert.equal(acmeOpened.status, 201, JSON.stringify(acmeOpened.body));
  acmeTicketId = acmeOpened.body.data.ticket.id;
  const dxgOpened = await call(dxgCustomerToken, "POST", `${CUSTOMER}/tickets`, { subject: `DXG question ${tag}`, body: "A ticket inside the staff organization." });
  assert.equal(dxgOpened.status, 201, JSON.stringify(dxgOpened.body));
  dxgTicketId = dxgOpened.body.data.ticket.id;
  // All three are the first ticket of their organization: the number each customer sees.
  const numbers = await SupportTicket.find({ organizationId: { $in: [oid(bayshore.organizationId), oid(acme.organizationId), dxg.org] } }).select("ticketNumber").lean();
  assert.deepEqual(numbers.map((t) => t.ticketNumber), [1, 1, 1]);

  // #1 matches one ticket per organization; each comes back with its organization.
  // (The shared test database can hold other organizations' #1 tickets too, so count, don't list.)
  const byNumber = await call(staffToken, "GET", search("#1"));
  assert.ok(byNumber.body.data.pagination.total >= 3, `#1 matches at least our three tickets (${byNumber.body.data.pagination.total})`);
  assert.ok((byNumber.body.data.tickets as any[]).length > 0 && (byNumber.body.data.tickets as any[]).every((t) => t.ticketNumber === 1 && t.organization?.id === t.organizationId));
  // A search that only starts with a number is text, not a ticket number.
  assert.deepEqual(ids(await call(staffToken, "GET", `${search("1 day event nobody wrote about")}&organization=${bayshore.organizationId}`)), []);
  // Number plus organization is exact.
  for (const [organizationId, ticketId] of [[bayshore.organizationId, bayshoreTicketId], [acme.organizationId, acmeTicketId], [String(dxg.org), dxgTicketId]]) {
    assert.deepEqual(ids(await call(staffToken, "GET", `${search("#1")}&organization=${organizationId}`)), [ticketId]);
  }
  assert.equal((await call(staffToken, "GET", `${AGENT}/tickets?organization=not-an-id`)).status, 400);
});

test("every agent operation works on a customer organization's ticket", async () => {
  const base = `${AGENT}/tickets/${bayshoreTicketId}`;
  const note = await call(staffTwoToken, "POST", `${base}/notes`, { body: "Internal: customer is on the free trial." });
  assert.equal(note.status, 201, JSON.stringify(note.body));

  const agents = await call(staffToken, "GET", `${AGENT}/agents`);
  const agentIds = (agents.body.data as any[]).map((a) => a.id);
  assert.ok(agentIds.includes(String(dxg.staff)) && agentIds.includes(String(dxg.staffTwo)));
  // Only `admins` accounts answer tickets.
  assert.ok(!agentIds.includes(String(dxg.impostor)) && !agentIds.includes(String(dxg.legacyAgent)) && !agentIds.includes(bayshore.members.owner.userId));

  const assigned = await call(staffToken, "PATCH", base, { assigneeUserId: String(dxg.staffTwo), priority: "high" });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  assert.equal(assigned.body.data.assigneeUserId, String(dxg.staffTwo));
  assert.equal(assigned.body.data.priority, "high");
  assert.equal((await call(staffToken, "PATCH", base, { assigneeUserId: bayshore.members.owner.userId })).status, 400);
  assert.deepEqual(ids(await call(staffTwoToken, "GET", `${AGENT}/tickets?assignee=me&organization=${bayshore.organizationId}`)), [bayshoreTicketId]);

  const presence = await call(staffToken, "POST", `${base}/presence`, { state: "replying" });
  assert.equal(presence.status, 200, JSON.stringify(presence.body));
  const others = await call(staffTwoToken, "POST", `${base}/presence`, { state: "viewing" });
  assert.deepEqual(others.body.data.others, [{ userId: String(dxg.staff), name: "Dana Staff", state: "replying" }]);
  assert.equal((await call(staffToken, "DELETE", `${base}/presence`)).status, 200);

  const canned = await call(staffToken, "POST", `${AGENT}/canned-replies`, { title: `Greeting ${tag}`, body: "Thanks for getting in touch." });
  assert.equal(canned.status, 201, JSON.stringify(canned.body));
  assert.ok(((await call(staffTwoToken, "GET", `${AGENT}/canned-replies`)).body.data as any[]).some((r) => r.id === canned.body.data.id));

  const resolved = await call(staffTwoToken, "PATCH", base, { status: "resolved" });
  assert.equal(resolved.body.data.status, "resolved");
  // An attachment that is not on the ticket is missing; the ticket itself resolved.
  const missing = await call(staffToken, "GET", `${base}/attachments/0b9d3c1e-8a4f-4c2b-9d1e-2f3a4b5c6d7e`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "SUPPORT_ATTACHMENT_NOT_FOUND");

  // The customer sees the status change, never the internal note or who assigned whom.
  const seen = await call(bayshore.members.owner.accessToken, "GET", `${CUSTOMER}/tickets/${bayshoreTicketId}`);
  assert.equal(seen.body.data.ticket.status, "resolved");
  const text = JSON.stringify(seen.body);
  assert.ok(!text.includes("free trial") && !text.includes("Eli Staff") && !text.includes("assigned this ticket"));
});

test("trust boundary: a users account holding a staff role gets nothing across organizations", async () => {
  const agentRoutes: Array<[string, string, unknown?]> = [
    ["GET", `${AGENT}/tickets`],
    ["GET", `${AGENT}/metrics`],
    ["GET", `${AGENT}/agents`],
    ["GET", `${AGENT}/canned-replies`],
    ["GET", `${AGENT}/tickets/${bayshoreTicketId}`],
    ["POST", `${AGENT}/tickets/${bayshoreTicketId}/messages`, { body: "let me in" }],
    ["POST", `${AGENT}/tickets/${bayshoreTicketId}/notes`, { body: "note" }],
    ["PATCH", `${AGENT}/tickets/${bayshoreTicketId}`, { priority: "urgent" }],
    ["POST", `${AGENT}/tickets/${bayshoreTicketId}/presence`, { state: "viewing" }],
    ["DELETE", `${AGENT}/tickets/${bayshoreTicketId}/presence`],
    ["GET", `${AGENT}/tickets/${bayshoreTicketId}/attachments/0b9d3c1e-8a4f-4c2b-9d1e-2f3a4b5c6d7e`],
    ["GET", `${AGENT}/tickets/${bayshoreTicketId}/rfps`],
  ];
  // The impostor passes the route's role guard (it holds dxg_admin) and is refused by the service.
  for (const [method, path, body] of agentRoutes) {
    const res = await call(impostorToken, method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.ok(!JSON.stringify(res.body).includes(SUBJECT), `${method} ${path}`);
  }

  // A `users` account whose account role is administrative was an agent of its own
  // organization before this change. It still is, and it sees no other organization.
  const own = await call(legacyAgentToken, "GET", `${AGENT}/tickets?status=all&perPage=50`);
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.data.scope, "organization");
  assert.deepEqual(ids(own), [dxgTicketId]);
  assert.deepEqual(ids(await call(legacyAgentToken, "GET", `${AGENT}/tickets?status=all&organization=${bayshore.organizationId}`)), [dxgTicketId]);
  assert.deepEqual(ids(await call(legacyAgentToken, "GET", search(SUBJECT))), []);
  assert.deepEqual(ids(await call(legacyAgentToken, "GET", search(BAYSHORE_NAME))), []);
  assert.equal((await call(legacyAgentToken, "GET", `${AGENT}/tickets/${dxgTicketId}`)).status, 200);
  for (const [method, path, body] of agentRoutes.filter(([, path]) => path.includes(bayshoreTicketId) && !path.endsWith("/rfps") && !path.endsWith("/presence"))) {
    const res = await call(legacyAgentToken, method, path, body);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(res.body.code, "SUPPORT_TICKET_NOT_FOUND");
  }
  assert.equal((await call(legacyAgentToken, "POST", `${AGENT}/tickets/${bayshoreTicketId}/presence`, {})).status, 404);
  assert.equal((await call(legacyAgentToken, "GET", `${AGENT}/tickets/${bayshoreTicketId}/rfps`)).status, 403);
  // Nothing either account tried was written.
  assert.equal(await SupportMessage.countDocuments({ organizationId: oid(bayshore.organizationId), authorUserId: { $in: [dxg.impostor, dxg.legacyAgent] } }), 0);
  const untouched = await SupportTicket.findOne({ _id: oid(bayshoreTicketId), organizationId: oid(bayshore.organizationId) }).lean();
  assert.equal(untouched?.priority, "high");
});

test("customers stay isolated: another organization's ticket is a 404, and no customer role reaches the agent desk", async () => {
  const outsider = acme.members.owner.accessToken;
  assert.equal((await call(outsider, "GET", `${CUSTOMER}/tickets/${bayshoreTicketId}`)).status, 404);
  assert.equal((await call(outsider, "POST", `${CUSTOMER}/tickets/${bayshoreTicketId}/messages`, { body: "let me in" })).status, 404);
  assert.equal((await call(outsider, "POST", `${CUSTOMER}/tickets/${bayshoreTicketId}/resolve`)).status, 404);
  assert.equal((await call(outsider, "GET", `${CUSTOMER}/tickets/${bayshoreTicketId}/attachments/0b9d3c1e-8a4f-4c2b-9d1e-2f3a4b5c6d7e`)).status, 404);
  assert.deepEqual(ids(await call(outsider, "GET", `${CUSTOMER}/tickets`)), [acmeTicketId]);
  // Unchanged inside one organization: a member sees their own tickets, not a colleague's.
  assert.deepEqual(ids(await call(bayshore.members.organization_admin.accessToken, "GET", `${CUSTOMER}/tickets`)), []);
  assert.equal((await call(bayshore.members.organization_admin.accessToken, "GET", `${CUSTOMER}/tickets/${bayshoreTicketId}`)).status, 404);
  for (const member of [acme.members.owner, bayshore.members.owner, bayshore.members.organization_admin]) {
    for (const path of [`${AGENT}/tickets`, `${AGENT}/tickets/${bayshoreTicketId}`, `${AGENT}/metrics`, `${AGENT}/tickets/${bayshoreTicketId}/rfps`]) {
      assert.equal((await call(member.accessToken, "GET", path)).status, 403, path);
    }
  }
});

test("the proposals behind a customer organization's ticket need an active grant from that organization", async () => {
  const path = `${AGENT}/tickets/${bayshoreTicketId}/rfps`;
  // The ticket resolves for staff now; its proposals still do not without a grant.
  const refused = await call(staffToken, "GET", path);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "SUPPORT_GRANT_REQUIRED");
  assert.ok(!JSON.stringify(refused.body).includes("Fixture event"));
  const denied = await SecurityAuditEvent.find({ organizationId: oid(bayshore.organizationId), action: "support_access.denied" }).lean();
  assert.equal(denied.length, 1);
  assert.equal(String(denied[0].actorUserId), String(dxg.staff));

  // A grant from another organization, or from the staff organization, opens nothing here.
  assert.equal((await call(acme.members.owner.accessToken, "POST", GRANTS, { expiresInDays: 2 })).status, 201);
  assert.equal((await call(staffToken, "GET", path)).body.code, "SUPPORT_GRANT_REQUIRED");

  const granted = await call(bayshore.members.owner.accessToken, "POST", GRANTS, { expiresInDays: 2 });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  const behind = await call(staffToken, "GET", path);
  assert.equal(behind.status, 200, JSON.stringify(behind.body));
  assert.equal(behind.body.data.organizationId, bayshore.organizationId);
  // The requester's proposals only: not a colleague's, not another organization's.
  assert.deepEqual((behind.body.data.rfps as any[]).map((r) => r.id).sort(), [...bayshoreOwnerRfps].sort());
  const used = await SecurityAuditEvent.find({ organizationId: oid(bayshore.organizationId), action: "support_access.used" }).lean();
  assert.deepEqual(used.map((e) => [String(e.actorUserId), e.metadata.grantId, e.metadata.operation, e.metadata.ticketId]), [
    [String(dxg.staff), granted.body.data.id, "ticket.rfp.list", bayshoreTicketId],
  ]);

  // Revoked: closed again on the next request, while the ticket itself stays readable.
  assert.equal((await call(bayshore.members.owner.accessToken, "POST", `${GRANTS}/${granted.body.data.id}/revoke`)).status, 200);
  assert.equal((await call(staffToken, "GET", path)).status, 403);
  assert.equal((await call(staffToken, "GET", `${AGENT}/tickets/${bayshoreTicketId}`)).status, 200);
  // The other organization's ticket never borrowed Bayshore's grant either.
  assert.equal((await call(staffToken, "GET", `${AGENT}/tickets/${randomMongoId()}/rfps`)).status, 404);
});
