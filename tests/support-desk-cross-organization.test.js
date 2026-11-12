require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");

const { createCustomerSupportDesk } = require("../src/modules/supportDesk/application/customerSupportDesk");
const { createAgentSupportDesk } = require("../src/modules/supportDesk/application/agentSupportDesk");
const { createSupportPresence } = require("../src/modules/supportDesk/application/supportPresence");
const { createSupportAttachments } = require("../src/modules/supportDesk/application/supportAttachments");
const { createSupportDeskSweeper } = require("../src/modules/supportDesk/application/supportDeskSweeper");
const { agentScopeFor } = require("../src/modules/supportDesk/application/agentScope");
const { SupportDeskError, isPlatformSupportStaff } = require("../src/modules/supportDesk/domain");

// The production bug (2026-11-12): sign-up gives every customer their own organization
// (ORG-106), RFPilot staff sit in theirs, and the agent side of the helpdesk was bounded to
// the agent's organization. A customer's ticket never reached the staff inbox.

const hex = (n) => n.toString(16).padStart(24, "0");
const STAFF_ORG = hex(0xd0);
const ACME = hex(0xa0);
const BAYSHORE = hex(0xb0);

const ACME_OWNER = hex(0xa1);
const ACME_PLANNER = hex(0xa2);
// A `users` account in Acme whose account role is administrative: an agent before this change.
const ACME_LEGACY_AGENT = hex(0xa3);
const BAYSHORE_OWNER = hex(0xb1);
const STAFF_ONE = hex(0xd1);
const STAFF_TWO = hex(0xd2);
// A `users` account in the staff organization holding a staff membership role.
const IMPOSTOR = hex(0xd3);

const acmeOwner = { userId: ACME_OWNER, organizationId: ACME, role: "customer", roles: ["owner"], accountType: "planner" };
const acmePlanner = { userId: ACME_PLANNER, organizationId: ACME, role: "customer", roles: ["planner"], accountType: "planner" };
const bayshoreOwner = { userId: BAYSHORE_OWNER, organizationId: BAYSHORE, role: "customer", roles: ["owner"], accountType: "planner" };
const staff = { userId: STAFF_ONE, organizationId: STAFF_ORG, role: "admin", roles: ["dxg_admin"], accountType: "admin" };
const staffTwo = { userId: STAFF_TWO, organizationId: STAFF_ORG, role: "super_admin", roles: ["super_admin"], accountType: "admin" };
const impostor = { userId: IMPOSTOR, organizationId: STAFF_ORG, role: "customer", roles: ["dxg_admin"], accountType: "planner" };
const legacyAgent = { userId: ACME_LEGACY_AGENT, organizationId: ACME, role: "admin", roles: ["dxg_admin"], accountType: "planner" };

const ORGANIZATIONS = new Map([[STAFF_ORG, "DXG Agency"], [ACME, "Acme Events"], [BAYSHORE, "Bayshore Communication"]]);

/**
 * In-memory repository with the Mongo adapter's scoping rules: planners live in `users` inside
 * one organization, staff in `admins`, and a ticket is found either inside one organization or
 * (platform scope) in any.
 */
const fakeRepository = () => {
  const planners = new Map([
    [ACME_OWNER, { id: ACME_OWNER, organizationId: ACME, name: "Olive Owner", email: "olive@acme.test", company: "Acme", role: "customer" }],
    [ACME_PLANNER, { id: ACME_PLANNER, organizationId: ACME, name: "Pat Planner", email: "pat@acme.test", company: "Acme", role: "customer" }],
    [ACME_LEGACY_AGENT, { id: ACME_LEGACY_AGENT, organizationId: ACME, name: "Lee Legacy", email: "lee@acme.test", company: "Acme", role: "admin" }],
    [BAYSHORE_OWNER, { id: BAYSHORE_OWNER, organizationId: BAYSHORE, name: "Bea Owner", email: "bea@bayshore.test", company: "Bayshore", role: "customer" }],
    [IMPOSTOR, { id: IMPOSTOR, organizationId: STAFF_ORG, name: "Member With Staff Role", email: "impostor@dxg.test", company: null, role: "customer" }],
  ]);
  const admins = new Map([
    [STAFF_ONE, { id: STAFF_ONE, organizationId: STAFF_ORG, name: "Dana RFPilot", email: "dana@dxg.test", company: null, role: "admin" }],
    [STAFF_TWO, { id: STAFF_TWO, organizationId: STAFF_ORG, name: "Eli RFPilot", email: "eli@dxg.test", company: null, role: "super_admin" }],
  ]);
  const summary = ({ organizationId: _organizationId, ...rest }) => rest;
  const tickets = new Map();
  const messages = [];
  const uploads = new Map();
  const counters = new Map();
  const calls = [];
  let ticketSeq = 0;
  let messageSeq = 0;

  const matches = (rows, filters) => {
    if (filters.organizationId) rows = rows.filter((t) => t.organizationId === filters.organizationId);
    if (filters.requesterUserId) rows = rows.filter((t) => t.requesterUserId === filters.requesterUserId);
    if (filters.status === "active") rows = rows.filter((t) => t.status === "open" || t.status === "waiting_on_customer");
    else if (filters.status) rows = rows.filter((t) => t.status === filters.status);
    if (filters.assignee === "unassigned") rows = rows.filter((t) => t.assigneeUserId === null);
    else if (filters.assignee) rows = rows.filter((t) => t.assigneeUserId === filters.assignee);
    if (filters.search) {
      const needle = filters.search.toLowerCase();
      const numeric = Number.parseInt(filters.search.replace(/^#/, ""), 10);
      rows = rows.filter(
        (t) =>
          t.subject.toLowerCase().includes(needle) ||
          (Number.isInteger(numeric) && t.ticketNumber === numeric) ||
          (ORGANIZATIONS.get(t.organizationId) ?? "").toLowerCase().includes(needle),
      );
    }
    rows.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    const start = (filters.page - 1) * filters.perPage;
    return { tickets: rows.slice(start, start + filters.perPage).map((t) => ({ ...t })), total: rows.length };
  };
  const metricsOf = (rows) => ({
    open: rows.filter((t) => t.status === "open").length,
    waitingOnCustomer: rows.filter((t) => t.status === "waiting_on_customer").length,
    resolved: rows.filter((t) => t.status === "resolved").length,
    closed: rows.filter((t) => t.status === "closed").length,
    unassigned: rows.filter((t) => !t.assigneeUserId).length,
    unreadForAgents: rows.reduce((sum, t) => sum + t.unreadForAgents, 0),
    overdue: 0,
    averageFirstResponseMs: null,
    averageResolutionMs: null,
    perAgent: [...new Set(rows.map((t) => t.assigneeUserId).filter(Boolean))].map((agentUserId) => ({
      agentUserId,
      openTickets: rows.filter((t) => t.assigneeUserId === agentUserId).length,
    })),
  });

  return {
    tickets,
    messages,
    uploads,
    calls,
    async createTicket(input) {
      ticketSeq += 1;
      // Numbers are per organization, as in SupportTicketCounter.
      const number = (counters.get(input.organizationId) ?? 0) + 1;
      counters.set(input.organizationId, number);
      const record = {
        id: hex(0x1000 + ticketSeq), ticketNumber: number, organizationId: input.organizationId,
        requesterUserId: input.requesterUserId, assigneeUserId: null, subject: input.subject,
        category: input.category, priority: input.priority, status: "open", messageCount: 0,
        unreadForRequester: 0, unreadForAgents: 0, lastMessageAt: input.now.toISOString(),
        lastCustomerMessageAt: input.now.toISOString(), lastAgentMessageAt: null, firstAgentResponseAt: null,
        resolvedAt: null, closedAt: null, responseDueAt: null, escalatedAt: null, waitingSince: null,
        autoCloseReminderSentAt: null, createdAt: input.now.toISOString(), updatedAt: input.now.toISOString(),
      };
      tickets.set(record.id, record);
      return { ...record };
    },
    async findTicket(organizationId, ticketId) {
      const ticket = tickets.get(ticketId);
      return ticket && ticket.organizationId === organizationId ? { ...ticket } : null;
    },
    async findTicketInAnyOrganization(ticketId) {
      calls.push("findTicketInAnyOrganization");
      const ticket = tickets.get(ticketId);
      return ticket ? { ...ticket } : null;
    },
    async listTickets(organizationId, filters) {
      return matches([...tickets.values()].filter((t) => t.organizationId === organizationId), { ...filters, organizationId: undefined });
    },
    async listTicketsInAnyOrganization(filters) {
      calls.push("listTicketsInAnyOrganization");
      return matches([...tickets.values()], filters);
    },
    async updateTicket(organizationId, ticketId, patch) {
      const ticket = tickets.get(ticketId);
      if (!ticket || ticket.organizationId !== organizationId) return null;
      const { messageCountDelta, ...rest } = patch;
      for (const [key, value] of Object.entries(rest)) if (value !== undefined) ticket[key] = value;
      if (messageCountDelta) ticket.messageCount += messageCountDelta;
      return { ...ticket };
    },
    async countRequesterUnread(organizationId, requesterUserId) {
      return [...tickets.values()].filter(
        (t) => t.organizationId === organizationId && t.requesterUserId === requesterUserId && t.unreadForRequester > 0,
      ).length;
    },
    async appendMessage(input) {
      messageSeq += 1;
      const record = {
        id: hex(0x5000 + messageSeq), organizationId: input.organizationId, ticketId: input.ticketId,
        authorUserId: input.authorUserId, authorRole: input.authorRole, kind: input.kind, body: input.body,
        attachments: input.attachments, createdAt: input.now.toISOString(),
      };
      messages.push(record);
      return { ...record };
    },
    async listMessages(organizationId, ticketId, options) {
      return messages
        .filter((m) => m.organizationId === organizationId && m.ticketId === ticketId)
        .filter((m) => options.includeInternal || m.kind !== "internal_note")
        .map((m) => ({ ...m }));
    },
    async metrics(organizationId) {
      return metricsOf([...tickets.values()].filter((t) => t.organizationId === organizationId));
    },
    async metricsForAllOrganizations() {
      calls.push("metricsForAllOrganizations");
      return metricsOf([...tickets.values()]);
    },
    async listAgents(organizationId) {
      return [...admins.values()].filter((a) => a.organizationId === organizationId).map(summary);
    },
    async listStaffAgents() {
      return [...admins.values()].map(summary);
    },
    async staffAgentLoads() {
      const loads = new Map();
      for (const t of tickets.values()) {
        if (!t.assigneeUserId || (t.status !== "open" && t.status !== "waiting_on_customer")) continue;
        loads.set(t.assigneeUserId, (loads.get(t.assigneeUserId) ?? 0) + 1);
      }
      return loads;
    },
    async findUserSummaries(organizationId, userIds) {
      const found = new Map();
      for (const id of userIds) {
        const person = planners.get(id) ?? admins.get(id);
        if (person && person.organizationId === organizationId) found.set(id, summary(person));
      }
      return found;
    },
    async findTicketPeople(refs) {
      const found = new Map();
      for (const ref of refs) {
        for (const id of ref.userIds.filter(Boolean)) {
          const planner = planners.get(id);
          if (planner && planner.organizationId === ref.organizationId) found.set(id, summary(planner));
          if (admins.has(id)) found.set(id, summary(admins.get(id)));
        }
      }
      return found;
    },
    async findOrganizationNames(ids) {
      return new Map(ids.filter((id) => ORGANIZATIONS.has(id)).map((id) => [id, ORGANIZATIONS.get(id)]));
    },
    async createPendingAttachment(input) {
      uploads.set(input.attachment.id, { ...input.attachment, organizationId: input.organizationId, uploaderUserId: input.uploaderUserId, status: "pending" });
    },
    async claimPendingAttachments(input) {
      const out = [];
      for (const id of input.ids) {
        const u = uploads.get(id);
        if (!u || u.status !== "pending" || u.organizationId !== input.organizationId || u.uploaderUserId !== input.uploaderUserId) return null;
        out.push({ id: u.id, fileName: u.fileName, mimeType: u.mimeType, sizeBytes: u.sizeBytes, objectKey: u.objectKey });
      }
      return out;
    },
    async markAttachmentsUsed(input) {
      for (const id of input.ids) {
        const u = uploads.get(id);
        if (u && u.organizationId === input.organizationId) Object.assign(u, { status: "attached", ticketId: input.ticketId, messageId: input.messageId });
      }
    },
    async findTicketAttachment(organizationId, ticketId, attachmentId) {
      for (const m of messages) {
        if (m.organizationId !== organizationId || m.ticketId !== ticketId) continue;
        const a = m.attachments.find((x) => x.id === attachmentId);
        if (a) return { attachment: a, messageKind: m.kind };
      }
      return null;
    },
    async listCannedReplies(organizationId) {
      return organizationId === STAFF_ORG ? [{ id: hex(0x9001), title: "Greeting", body: "Hello" }] : [];
    },
  };
};

const fakeNotifier = () => {
  const events = [];
  const record = (name) => async (input) => { events.push([name, input]); };
  return {
    events,
    ticketCreated: record("ticketCreated"), customerReplied: record("customerReplied"), agentReplied: record("agentReplied"),
    statusChanged: record("statusChanged"), ticketAssigned: record("ticketAssigned"), ticketEscalated: record("ticketEscalated"),
    autoCloseReminder: record("autoCloseReminder"), autoResolved: record("autoResolved"),
  };
};

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 12, 9, 0, tick++));

const build = ({ autoAssign = false, random } = {}) => {
  const repository = fakeRepository();
  const notifier = fakeNotifier();
  const presenceEntries = new Map();
  const store = {
    async touch(organizationId, ticketId, entry) { presenceEntries.set(`${organizationId}:${ticketId}:${entry.userId}`, entry); },
    async list(organizationId, ticketId) { return [...presenceEntries.entries()].filter(([key]) => key.startsWith(`${organizationId}:${ticketId}:`)).map(([, value]) => value); },
    async remove(organizationId, ticketId, userId) { presenceEntries.delete(`${organizationId}:${ticketId}:${userId}`); },
  };
  const presigned = [];
  return {
    repository,
    notifier,
    presenceEntries,
    presigned,
    customer: createCustomerSupportDesk({ repository, notifier, clock, autoAssign, random }),
    agent: createAgentSupportDesk({ repository, notifier, clock }),
    presence: createSupportPresence({ store, repository, clock }),
    attachments: createSupportAttachments({
      repository,
      storage: { async upload() {}, async presignDownload(objectKey) { presigned.push(objectKey); return `https://signed.example/${objectKey}`; } },
      scanner: { async scan() { return "clean"; } },
      clock,
    }),
  };
};

const rejects = async (work, code, status) => {
  await assert.rejects(work, (error) => {
    assert.ok(error instanceof SupportDeskError, `expected SupportDeskError, got ${error}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
};

const openTickets = async (desk) => {
  const acme = await desk.customer.createTicket(acmeOwner, { subject: "Acme cannot export", body: "The export button does nothing." });
  const bayshore = await desk.customer.createTicket(bayshoreOwner, { subject: "QA check 12 Nov: test ticket, please ignore", body: "Checking the helpdesk." });
  return { acme: acme.ticket, bayshore: bayshore.ticket };
};

test("who counts as RFPilot staff: an admins account with a staff role, nothing else", () => {
  assert.equal(isPlatformSupportStaff(staff), true);
  assert.equal(isPlatformSupportStaff(staffTwo), true);
  assert.equal(isPlatformSupportStaff({ role: "superadmin", accountType: "admin" }), true);
  // A `users` account, whatever role it holds on the account or in its membership.
  assert.equal(isPlatformSupportStaff(impostor), false);
  assert.equal(isPlatformSupportStaff(legacyAgent), false);
  assert.equal(isPlatformSupportStaff({ role: "super_admin", accountType: "planner" }), false);
  assert.equal(isPlatformSupportStaff({ role: "admin", accountType: undefined }), false);
  // An admin-app account without a staff role.
  assert.equal(isPlatformSupportStaff({ role: "customer", accountType: "admin" }), false);
  assert.equal(isPlatformSupportStaff(acmeOwner), false);
});

test("staff list every organization's tickets, each with the customer organization", async () => {
  const desk = build();
  const { acme, bayshore } = await openTickets(desk);

  const inbox = await desk.agent.listInbox(staff, {});
  assert.equal(inbox.scope, "all_organizations");
  assert.equal(inbox.pagination.total, 2);
  assert.deepEqual(
    inbox.tickets.map((t) => [t.id, t.organization, t.requester?.name]).sort(),
    [
      [acme.id, { id: ACME, name: "Acme Events" }, "Olive Owner"],
      [bayshore.id, { id: BAYSHORE, name: "Bayshore Communication" }, "Bea Owner"],
    ].sort(),
  );
  // One organization's tickets, by its id.
  const narrowed = await desk.agent.listInbox(staff, { organization: BAYSHORE });
  assert.deepEqual(narrowed.tickets.map((t) => t.id), [bayshore.id]);
  await rejects(() => desk.agent.listInbox(staff, { organization: "not-an-id" }), "SUPPORT_INVALID_ID", 400);
  // Found by subject and by the organization's name.
  assert.deepEqual((await desk.agent.listInbox(staff, { search: "QA check 12 Nov" })).tickets.map((t) => t.id), [bayshore.id]);
  assert.deepEqual((await desk.agent.listInbox(staff, { search: "bayshore" })).tickets.map((t) => t.id), [bayshore.id]);
  // The stat cards count every organization.
  const metrics = await desk.agent.metrics(staff);
  assert.equal(metrics.open, 2);
  assert.equal(metrics.unreadForAgents, 2);
});

test("numbering: numbers stay per organization, and a #number search returns every match with its organization", async () => {
  const desk = build();
  const { acme, bayshore } = await openTickets(desk);
  // Both are the first ticket of their organization: the number the customer already sees.
  assert.equal(acme.ticketNumber, 1);
  assert.equal(bayshore.ticketNumber, 1);

  const byNumber = await desk.agent.listInbox(staff, { search: "#1" });
  assert.deepEqual(
    byNumber.tickets.map((t) => `${t.organization.name} #${t.ticketNumber}`).sort(),
    ["Acme Events #1", "Bayshore Communication #1"],
  );
  // Unambiguous together with the organization.
  const one = await desk.agent.listInbox(staff, { search: "#1", organization: ACME });
  assert.deepEqual(one.tickets.map((t) => t.id), [acme.id]);
});

test("staff open, reply, note, assign and re-prioritise a customer organization's ticket; the customer sees the reply", async () => {
  const desk = build();
  const { bayshore } = await openTickets(desk);

  const opened = await desk.agent.getTicket(staff, bayshore.id);
  assert.deepEqual(opened.organization, { id: BAYSHORE, name: "Bayshore Communication" });
  assert.equal(opened.requester.name, "Bea Owner");
  assert.equal(opened.ticket.unreadForAgents, 0);
  assert.ok(opened.messages.some((m) => m.body === "Checking the helpdesk."));

  const reply = await desk.agent.reply(staff, bayshore.id, { body: "We can see it now." });
  assert.equal(reply.ticket.status, "waiting_on_customer");
  assert.equal(reply.ticket.assigneeUserId, STAFF_ONE);
  // Written into the customer's organization, never the agent's.
  assert.equal(desk.repository.messages.find((m) => m.id === reply.message.id).organizationId, BAYSHORE);
  assert.equal(desk.repository.messages.some((m) => m.organizationId === STAFF_ORG), false);

  await desk.agent.addInternalNote(staff, bayshore.id, { body: "Customer is on the free trial." });
  const assigned = await desk.agent.updateTicket(staff, bayshore.id, { assigneeUserId: STAFF_TWO, priority: "high" });
  assert.equal(assigned.assigneeUserId, STAFF_TWO);
  assert.equal(assigned.priority, "high");
  assert.deepEqual(
    desk.notifier.events.filter(([name]) => name === "ticketAssigned").map(([, input]) => input.assigneeUserId),
    [STAFF_TWO],
  );
  // Only RFPilot staff can own a ticket: not the customer, not a member of the customer's organization.
  await rejects(() => desk.agent.updateTicket(staff, bayshore.id, { assigneeUserId: BAYSHORE_OWNER }), "SUPPORT_INVALID_ASSIGNEE", 400);
  const closed = await desk.agent.updateTicket(staffTwo, bayshore.id, { status: "resolved" });
  assert.equal(closed.status, "resolved");

  const seen = await desk.customer.getOwnTicket(bayshoreOwner, bayshore.id);
  assert.ok(seen.messages.some((m) => m.body === "We can see it now." && m.authorRole === "agent"));
  assert.equal(seen.messages.some((m) => m.kind === "internal_note"), false);
  assert.equal(seen.messages.some((m) => m.body.includes("free trial")), false);
  // The planner learns someone is on it, never who.
  assert.deepEqual(seen.assignee, { id: STAFF_TWO, name: "RFPilot support" });
  const told = desk.notifier.events.filter(([name]) => name === "agentReplied");
  assert.equal(told.length, 1);
  assert.equal(told[0][1].requester.email, "bea@bayshore.test");
  assert.equal(told[0][1].ticket.organizationId, BAYSHORE);
});

test("impostor: a users account holding a staff membership role gets nothing, in any organization", async () => {
  const desk = build();
  const { acme, bayshore } = await openTickets(desk);
  desk.repository.calls.length = 0;

  for (const work of [
    () => desk.agent.listInbox(impostor, {}),
    () => desk.agent.metrics(impostor),
    () => desk.agent.listAgents(impostor),
    () => desk.agent.getTicket(impostor, bayshore.id),
    () => desk.agent.reply(impostor, acme.id, { body: "hello" }),
    () => desk.agent.addInternalNote(impostor, acme.id, { body: "note" }),
    () => desk.agent.updateTicket(impostor, acme.id, { priority: "urgent" }),
    () => desk.agent.listCannedReplies(impostor),
    () => desk.presence.heartbeat(impostor, acme.id, {}),
    () => desk.presence.leave(impostor, acme.id),
    () => desk.attachments.agentDownload(impostor, acme.id, "0b9d3c1e-8a4f-4c2b-9d1e-2f3a4b5c6d7e"),
    () => desk.attachments.uploadForAgent(impostor, []),
  ]) {
    await rejects(work, "SUPPORT_FORBIDDEN", 403);
  }
  assert.deepEqual(desk.repository.calls, [], "no platform-scope read ran for the impostor");
  assert.throws(() => agentScopeFor(desk.repository, impostor), (error) => error.status === 403);
});

test("a users account with an administrative account role keeps its own organization and gains nothing", async () => {
  const desk = build();
  const { acme, bayshore } = await openTickets(desk);
  desk.repository.calls.length = 0;

  assert.equal(agentScopeFor(desk.repository, legacyAgent).platform, false);
  const inbox = await desk.agent.listInbox(legacyAgent, {});
  assert.equal(inbox.scope, "organization");
  assert.deepEqual(inbox.tickets.map((t) => t.id), [acme.id]);
  // Asking for another organization changes nothing.
  assert.deepEqual((await desk.agent.listInbox(legacyAgent, { organization: BAYSHORE })).tickets.map((t) => t.id), [acme.id]);
  assert.deepEqual((await desk.agent.listInbox(legacyAgent, { search: "QA check" })).tickets, []);
  assert.deepEqual((await desk.agent.listInbox(legacyAgent, { search: "#1" })).tickets.map((t) => t.id), [acme.id]);
  assert.equal((await desk.agent.metrics(legacyAgent)).open, 1);
  assert.equal((await desk.agent.getTicket(legacyAgent, acme.id)).ticket.id, acme.id);

  for (const work of [
    () => desk.agent.getTicket(legacyAgent, bayshore.id),
    () => desk.agent.reply(legacyAgent, bayshore.id, { body: "hello" }),
    () => desk.agent.addInternalNote(legacyAgent, bayshore.id, { body: "note" }),
    () => desk.agent.updateTicket(legacyAgent, bayshore.id, { priority: "urgent" }),
    () => desk.presence.heartbeat(legacyAgent, bayshore.id, {}),
    () => desk.attachments.agentDownload(legacyAgent, bayshore.id, "0b9d3c1e-8a4f-4c2b-9d1e-2f3a4b5c6d7e"),
  ]) {
    await rejects(work, "SUPPORT_TICKET_NOT_FOUND", 404);
  }
  assert.equal(desk.repository.messages.some((m) => m.ticketId === bayshore.id && m.authorUserId === ACME_LEGACY_AGENT), false);
  assert.deepEqual(desk.repository.calls, [], "no platform-scope read ran for a users account");
});

test("customers stay isolated: another organization's ticket is a 404 to list, open, reply, resolve or download", async () => {
  const desk = build();
  const { acme, bayshore } = await openTickets(desk);
  await desk.agent.reply(staff, bayshore.id, { body: "Answer for Bayshore only." });
  desk.repository.calls.length = 0;

  const own = await desk.customer.listOwnTickets(acmeOwner, {});
  assert.deepEqual(own.tickets.map((t) => t.id), [acme.id]);
  for (const work of [
    () => desk.customer.getOwnTicket(acmeOwner, bayshore.id),
    () => desk.customer.replyToOwnTicket(acmeOwner, bayshore.id, { body: "let me in" }),
    () => desk.customer.resolveOwnTicket(acmeOwner, bayshore.id),
    () => desk.attachments.customerDownload(acmeOwner, bayshore.id, "0b9d3c1e-8a4f-4c2b-9d1e-2f3a4b5c6d7e"),
  ]) {
    await rejects(work, "SUPPORT_TICKET_NOT_FOUND", 404);
  }
  // Unchanged rule inside one organization: a member sees their own tickets, not a colleague's.
  assert.deepEqual((await desk.customer.listOwnTickets(acmePlanner, {})).tickets, []);
  await rejects(() => desk.customer.getOwnTicket(acmePlanner, acme.id), "SUPPORT_TICKET_NOT_FOUND", 404);
  assert.equal(await desk.customer.ownUnreadCount(acmeOwner), 0);
  assert.equal(await desk.customer.ownUnreadCount(bayshoreOwner), 1);
  // No customer operation reads across organizations, and none reaches the agent desk.
  assert.deepEqual(desk.repository.calls, []);
  await rejects(() => desk.agent.listInbox(acmeOwner, {}), "SUPPORT_FORBIDDEN", 403);
  await rejects(() => desk.agent.getTicket(bayshoreOwner, bayshore.id), "SUPPORT_FORBIDDEN", 403);
});

test("notifications: a customer organization's ticket is given to RFPilot staff and alerts them", async () => {
  // random 0 picks the first of the least-loaded agents.
  const desk = build({ autoAssign: true, random: () => 0 });
  const first = await desk.customer.createTicket(bayshoreOwner, { subject: "First", body: "Help please." });
  // Before the fix the customer's organization had no agents, so the ticket stayed unowned
  // and the alert went to nobody.
  assert.equal(first.ticket.assigneeUserId, STAFF_ONE);
  const created = desk.notifier.events.filter(([name]) => name === "ticketCreated");
  assert.equal(created.length, 1);
  assert.equal(created[0][1].ticket.assigneeUserId, STAFF_ONE);
  assert.equal(created[0][1].ticket.organizationId, BAYSHORE);
  assert.equal(created[0][1].requester.name, "Bea Owner");

  // Workload counts every organization: the next ticket, from another customer, goes to the other agent.
  const second = await desk.customer.createTicket(acmeOwner, { subject: "Second", body: "Help too." });
  assert.equal(second.ticket.assigneeUserId, STAFF_TWO);

  await desk.agent.reply(staff, first.ticket.id, { body: "On it." });
  const replied = await desk.customer.replyToOwnTicket(bayshoreOwner, first.ticket.id, { body: "Thanks, one more thing." });
  assert.equal(replied.ticket.unreadForAgents, 1);
  const customerReplies = desk.notifier.events.filter(([name]) => name === "customerReplied");
  assert.equal(customerReplies.length, 1);
  assert.equal(customerReplies[0][1].ticket.assigneeUserId, STAFF_ONE);
  // The unread count staff see spans organizations.
  assert.equal((await desk.agent.metrics(staff)).unreadForAgents, 2);
});

test("presence and attachments work on a customer organization's ticket", async () => {
  const desk = build();
  const { bayshore } = await openTickets(desk);

  assert.deepEqual(await desk.presence.heartbeat(staff, bayshore.id, { state: "replying" }), { others: [] });
  const seen = await desk.presence.heartbeat(staffTwo, bayshore.id, {});
  assert.deepEqual(seen.others, [{ userId: STAFF_ONE, name: "Dana RFPilot", state: "replying" }]);
  // Keyed by the ticket's organization, so both agents share one entry set.
  assert.ok([...desk.presenceEntries.keys()].every((key) => key.startsWith(`${BAYSHORE}:${bayshore.id}:`)));
  await desk.presence.leave(staff, bayshore.id);
  assert.deepEqual((await desk.presence.heartbeat(staffTwo, bayshore.id, {})).others, []);

  const [upload] = await desk.attachments.uploadForAgent(staff, [
    { localPath: "/tmp/upload-1", originalName: "steps.pdf", mimeType: "application/pdf", sizeBytes: 1024 },
  ]);
  await desk.agent.reply(staff, bayshore.id, { body: "Steps attached.", attachments: [upload.id] });
  const forAgent = await desk.attachments.agentDownload(staffTwo, bayshore.id, upload.id);
  assert.equal(forAgent.attachment.fileName, "steps.pdf");
  const forCustomer = await desk.attachments.customerDownload(bayshoreOwner, bayshore.id, upload.id);
  assert.equal(forCustomer.attachment.id, upload.id);
  await rejects(() => desk.attachments.customerDownload(acmeOwner, bayshore.id, upload.id), "SUPPORT_TICKET_NOT_FOUND", 404);
});

test("the sweeper names the staff owner of a customer organization's overdue ticket", async () => {
  const repository = fakeRepository();
  const notifier = fakeNotifier();
  const now = new Date("2026-11-12T12:00:00.000Z");
  const created = await repository.createTicket({ organizationId: BAYSHORE, requesterUserId: BAYSHORE_OWNER, subject: "Waiting", category: "other", priority: "normal", now: new Date(now.getTime() - 45 * 60_000) });
  await repository.updateTicket(BAYSHORE, created.id, { assigneeUserId: STAFF_ONE });
  repository.backfillServiceLevels = async () => 0;
  repository.listUnansweredSince = async () => [{ ...repository.tickets.get(created.id) }];
  repository.listNeedingCloseReminder = async () => [];
  repository.listDueToAutoResolve = async () => [];
  repository.listResolvedBefore = async () => [];
  const sweeper = createSupportDeskSweeper({ repository, notifier, clock: () => now });

  const result = await sweeper.run();
  assert.equal(result.escalated, 1);
  const [[name, input]] = notifier.events;
  assert.equal(name, "ticketEscalated");
  assert.equal(input.assignee.name, "Dana RFPilot");
  assert.equal(input.ticket.organizationId, BAYSHORE);
});
