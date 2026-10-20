require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createCustomerSupportDesk,
} = require("../src/modules/supportDesk/application/customerSupportDesk");
const {
  createAgentSupportDesk,
} = require("../src/modules/supportDesk/application/agentSupportDesk");
const { SupportDeskError, canBeReadByRequester } = require("../src/modules/supportDesk/domain");

const ORG = "aaaaaaaaaaaaaaaaaaaaaaaa";
const PLANNER = "bbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_PLANNER = "bbbbbbbbbbbbbbbbbbbbbbbc";
const AGENT = "cccccccccccccccccccccccc";
const AGENT_TWO = "cccccccccccccccccccccccd";

const planner = { userId: PLANNER, organizationId: ORG, role: "customer", roles: ["planner"] };
const otherPlanner = { ...planner, userId: OTHER_PLANNER };
const agent = { userId: AGENT, organizationId: ORG, role: "admin", roles: ["organization_admin"] };

const hex = (n) => n.toString(16).padStart(24, "0");

/**
 * In-memory repository that mirrors the Mongo adapter's contract closely
 * enough to exercise every application rule without a database.
 */
const fakeRepository = () => {
  const tickets = new Map();
  const messages = [];
  const canned = new Map();
  let ticketSeq = 0;
  let messageSeq = 0;
  let cannedSeq = 0;
  const users = new Map([
    [PLANNER, { id: PLANNER, name: "Pat Planner", email: "pat@example.com", company: "Acme", role: "customer" }],
    [OTHER_PLANNER, { id: OTHER_PLANNER, name: "Other", email: "other@example.com", company: null, role: "customer" }],
    [AGENT, { id: AGENT, name: "Dana DXG", email: "dana@example.com", company: null, role: "admin" }],
    [AGENT_TWO, { id: AGENT_TWO, name: "Eli DXG", email: "eli@example.com", company: null, role: "admin" }],
  ]);
  const uploads = new Map();
  return {
    tickets,
    messages,
    uploads,
    async createPendingAttachment(input) {
      uploads.set(input.attachment.id, { ...input.attachment, organizationId: input.organizationId, uploaderUserId: input.uploaderUserId, status: "pending", ticketId: null, messageId: null });
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
        if (u && u.status === "pending") Object.assign(u, { status: "attached", ticketId: input.ticketId, messageId: input.messageId });
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
    async createTicket(input) {
      ticketSeq += 1;
      const id = hex(1000 + ticketSeq);
      const record = {
        id,
        ticketNumber: ticketSeq,
        organizationId: input.organizationId,
        requesterUserId: input.requesterUserId,
        assigneeUserId: null,
        subject: input.subject,
        category: input.category,
        priority: input.priority,
        status: "open",
        messageCount: 0,
        unreadForRequester: 0,
        unreadForAgents: 0,
        lastMessageAt: input.now.toISOString(),
        lastCustomerMessageAt: input.now.toISOString(),
        lastAgentMessageAt: null,
        firstAgentResponseAt: null,
        resolvedAt: null,
        closedAt: null,
        createdAt: input.now.toISOString(),
        updatedAt: input.now.toISOString(),
      };
      tickets.set(id, record);
      return { ...record };
    },
    async findTicket(organizationId, ticketId) {
      const ticket = tickets.get(ticketId);
      return ticket && ticket.organizationId === organizationId ? { ...ticket } : null;
    },
    async listTickets(organizationId, filters) {
      let rows = [...tickets.values()].filter((ticket) => ticket.organizationId === organizationId);
      if (filters.requesterUserId) rows = rows.filter((t) => t.requesterUserId === filters.requesterUserId);
      if (filters.status === "active") rows = rows.filter((t) => t.status === "open" || t.status === "waiting_on_customer");
      else if (filters.status) rows = rows.filter((t) => t.status === filters.status);
      if (filters.assignee === "unassigned") rows = rows.filter((t) => t.assigneeUserId === null);
      else if (filters.assignee) rows = rows.filter((t) => t.assigneeUserId === filters.assignee);
      if (filters.priority) rows = rows.filter((t) => t.priority === filters.priority);
      if (filters.category) rows = rows.filter((t) => t.category === filters.category);
      if (filters.search) rows = rows.filter((t) => t.subject.toLowerCase().includes(filters.search.toLowerCase()));
      rows.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
      const start = (filters.page - 1) * filters.perPage;
      return { tickets: rows.slice(start, start + filters.perPage).map((t) => ({ ...t })), total: rows.length };
    },
    async updateTicket(organizationId, ticketId, patch) {
      const ticket = tickets.get(ticketId);
      if (!ticket || ticket.organizationId !== organizationId) return null;
      const { messageCountDelta, ...rest } = patch;
      for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined) ticket[key] = value;
      }
      if (messageCountDelta) ticket.messageCount += messageCountDelta;
      ticket.updatedAt = new Date(Date.parse(ticket.updatedAt) + 1).toISOString();
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
        id: hex(5000 + messageSeq),
        ticketId: input.ticketId,
        authorUserId: input.authorUserId,
        authorRole: input.authorRole,
        kind: input.kind,
        body: input.body,
        attachments: input.attachments,
        createdAt: input.now.toISOString(),
        organizationId: input.organizationId,
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
    async metrics() {
      return {
        open: 1, waitingOnCustomer: 0, resolved: 0, closed: 0, unassigned: 1, unreadForAgents: 2,
        averageFirstResponseMs: null, averageResolutionMs: null,
        perAgent: [{ agentUserId: AGENT, openTickets: 1 }],
      };
    },
    async listAgents() {
      return [users.get(AGENT), users.get(AGENT_TWO)];
    },
    async findUserSummaries(organizationId, userIds) {
      return new Map(userIds.filter((id) => users.has(id)).map((id) => [id, users.get(id)]));
    },
    async listCannedReplies() {
      return [...canned.values()];
    },
    async createCannedReply(input) {
      cannedSeq += 1;
      const record = { id: hex(9000 + cannedSeq), title: input.title, body: input.body, createdByUserId: input.createdByUserId, createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z" };
      canned.set(record.id, record);
      return { ...record };
    },
    async updateCannedReply(organizationId, id, patch) {
      const record = canned.get(id);
      if (!record) return null;
      Object.assign(record, patch);
      return { ...record };
    },
    async deleteCannedReply(organizationId, id) {
      return canned.delete(id);
    },
  };
};

const fakeNotifier = () => {
  const events = [];
  return {
    events,
    async ticketCreated(input) { events.push(["ticketCreated", input]); },
    async customerReplied(input) { events.push(["customerReplied", input]); },
    async agentReplied(input) { events.push(["agentReplied", input]); },
    async statusChanged(input) { events.push(["statusChanged", input]); },
  };
};

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 18, 12, 0, tick++));

const build = () => {
  const repository = fakeRepository();
  const notifier = fakeNotifier();
  return {
    repository,
    notifier,
    customer: createCustomerSupportDesk({ repository, notifier, clock }),
    agent: createAgentSupportDesk({ repository, notifier, clock }),
  };
};

const rejects = async (work, code, status) => {
  await assert.rejects(work, (error) => {
    assert.ok(error instanceof SupportDeskError, `expected SupportDeskError, got ${error}`);
    assert.equal(error.code, code);
    if (status) assert.equal(error.status, status);
    return true;
  });
};

test("requester visibility hides legacy triage audit messages but keeps public status activity", () => {
  assert.equal(
    canBeReadByRequester({ kind: "system", body: "Dana DXG assigned this ticket to Eli DXG." }),
    false,
  );
  assert.equal(
    canBeReadByRequester({ kind: "system", body: "Dana DXG set priority to urgent." }),
    false,
  );
  assert.equal(
    canBeReadByRequester({ kind: "system", body: "Dana DXG changed the status to Resolved." }),
    true,
  );
  assert.equal(canBeReadByRequester({ kind: "internal_note", body: "Private hand-off" }), false);
});

test("a planner opens a ticket with a numbered subject, first message, and agent notification", async () => {
  const { customer, notifier } = build();
  const { ticket, message } = await customer.createTicket(planner, {
    subject: "  Export   button\ndoes nothing ",
    body: "Clicking export on proposal X shows a spinner forever.",
    category: "bug",
  });
  assert.equal(ticket.ticketNumber, 1);
  assert.equal(ticket.subject, "Export button does nothing");
  assert.equal(ticket.category, "bug");
  assert.equal(ticket.priority, "normal");
  assert.equal(ticket.status, "open");
  assert.equal(ticket.messageCount, 1);
  assert.equal(ticket.unreadForAgents, 1);
  assert.equal(message.authorRole, "customer");
  assert.equal(message.kind, "message");
  assert.equal(notifier.events.length, 1);
  assert.equal(notifier.events[0][0], "ticketCreated");
  assert.equal(notifier.events[0][1].requester.name, "Pat Planner");

  const second = await customer.createTicket(planner, { subject: "Second", body: "Hi" });
  assert.equal(second.ticket.ticketNumber, 2);
  assert.equal(second.ticket.category, "other");
});

test("ticket input is validated and bounded", async () => {
  const { customer } = build();
  await rejects(() => customer.createTicket(planner, { subject: "", body: "x" }), "SUPPORT_INVALID_SUBJECT", 400);
  await rejects(() => customer.createTicket(planner, { subject: "a".repeat(201), body: "x" }), "SUPPORT_INVALID_SUBJECT", 400);
  await rejects(() => customer.createTicket(planner, { subject: "ok", body: "   " }), "SUPPORT_INVALID_BODY", 400);
  await rejects(() => customer.createTicket(planner, { subject: "ok", body: "x".repeat(5001) }), "SUPPORT_INVALID_BODY", 400);
  await rejects(() => customer.createTicket(planner, { subject: "ok", body: "x", category: "weird" }), "SUPPORT_INVALID_CATEGORY", 400);
  await rejects(
    () => customer.createTicket(planner, { subject: "ok", body: "x", attachments: ["nope"] }),
    "SUPPORT_INVALID_ATTACHMENTS",
    400,
  );
  await rejects(
    () => customer.createTicket(planner, { subject: "ok", body: "x", attachments: new Array(4).fill(UPLOAD_ID) }),
    "SUPPORT_TOO_MANY_ATTACHMENTS",
    400,
  );
  // A well-formed id that was never uploaded (or belongs to someone else) is refused.
  await rejects(
    () => customer.createTicket(planner, { subject: "ok", body: "x", attachments: [UPLOAD_ID] }),
    "SUPPORT_INVALID_ATTACHMENTS",
    400,
  );
});

const UPLOAD_ID = "11111111-1111-4111-8111-111111111111";

test("uploads are claimed once, by their uploader, and bound to the message", async () => {
  const { customer, repository } = build();
  await repository.createPendingAttachment({
    organizationId: ORG,
    uploaderUserId: PLANNER,
    attachment: { id: UPLOAD_ID, fileName: "shot.png", mimeType: "image/png", sizeBytes: 1024, objectKey: `support-attachments/${ORG}/${UPLOAD_ID}.png` },
    now: new Date(),
  });
  await rejects(
    () => customer.createTicket(otherPlanner, { subject: "theirs", body: "x", attachments: [UPLOAD_ID] }),
    "SUPPORT_INVALID_ATTACHMENTS",
  );
  const { ticket, message } = await customer.createTicket(planner, { subject: "ok", body: "x", attachments: [UPLOAD_ID] });
  assert.deepEqual(message.attachments.map((a) => a.fileName), ["shot.png"]);
  assert.equal(repository.uploads.get(UPLOAD_ID).status, "attached");
  assert.equal(repository.uploads.get(UPLOAD_ID).ticketId, ticket.id);
  assert.equal(repository.uploads.get(UPLOAD_ID).messageId, message.id);
  await rejects(
    () => customer.replyToOwnTicket(planner, ticket.id, { body: "again", attachments: [UPLOAD_ID] }),
    "SUPPORT_INVALID_ATTACHMENTS",
  );
});

test("planners see only their own tickets and never internal notes", async () => {
  const { customer, agent, repository } = build();
  const { ticket } = await customer.createTicket(planner, { subject: "Mine", body: "Help" });
  await customer.createTicket(otherPlanner, { subject: "Theirs", body: "Help too" });
  await agent.addInternalNote(agent_(), ticket.id, { body: "Customer is on the enterprise plan." });

  const list = await customer.listOwnTickets(planner, {});
  assert.deepEqual(list.tickets.map((t) => t.subject), ["Mine"]);
  assert.deepEqual(list.pagination, { page: 1, perPage: 20, total: 1, totalPages: 1 });

  await rejects(() => customer.getOwnTicket(otherPlanner, ticket.id), "SUPPORT_TICKET_NOT_FOUND", 404);
  await rejects(() => customer.getOwnTicket(planner, "not-an-id"), "SUPPORT_INVALID_ID", 400);

  const detail = await customer.getOwnTicket(planner, ticket.id);
  assert.deepEqual(detail.messages.map((m) => m.kind), ["message"]);
  assert.equal(repository.messages.filter((m) => m.kind === "internal_note").length, 1);

  function agent_() {
    return agent_ctx;
  }
});
const agent_ctx = agent;

test("agent replies set waiting-on-customer, auto-assign, record first response, and notify", async () => {
  const { customer, agent: desk, notifier } = build();
  const { ticket } = await customer.createTicket(planner, { subject: "Vendors never got the email", body: "Sent yesterday." });
  const reply = await desk.reply(agent, ticket.id, { body: "Checking the delivery log now." });
  assert.equal(reply.ticket.status, "waiting_on_customer");
  assert.equal(reply.ticket.assigneeUserId, AGENT);
  assert.ok(reply.ticket.firstAgentResponseAt);
  assert.equal(reply.ticket.unreadForRequester, 1);
  assert.equal(reply.ticket.messageCount, 2);
  assert.equal(reply.message.authorRole, "agent");
  const kinds = notifier.events.map((e) => e[0]);
  assert.deepEqual(kinds, ["ticketCreated", "agentReplied"]);
  assert.equal(notifier.events[1][1].agent.name, "Dana DXG");

  // The customer reading the thread clears their unread marker and sees the assignee.
  const detail = await customer.getOwnTicket(planner, ticket.id);
  assert.equal(detail.ticket.unreadForRequester, 0);
  assert.deepEqual(detail.assignee, { id: AGENT, name: "Dana DXG" });
  assert.equal(await customer.ownUnreadCount(planner), 0);

  // Replying with a terminal status also notifies the status change.
  const resolved = await desk.reply(agent, ticket.id, { body: "Fixed.", status: "resolved" });
  assert.equal(resolved.ticket.status, "resolved");
  assert.ok(resolved.ticket.resolvedAt);
  assert.equal(notifier.events.at(-1)[0], "statusChanged");
  assert.equal(notifier.events.at(-1)[1].byAgent, true);
});

test("a customer reply reopens a resolved ticket and marks it unread for agents", async () => {
  const { customer, agent: desk, repository, notifier } = build();
  const { ticket } = await customer.createTicket(planner, { subject: "Login", body: "Cannot sign in." });
  await desk.reply(agent, ticket.id, { body: "Reset your password.", status: "resolved" });
  const reply = await customer.replyToOwnTicket(planner, ticket.id, { body: "Still broken." });
  assert.equal(reply.ticket.status, "open");
  assert.equal(reply.ticket.resolvedAt, null);
  assert.equal(reply.ticket.unreadForAgents, 1);
  assert.equal(repository.messages.at(-1).kind, "system");
  assert.match(repository.messages.at(-1).body, /reopened/);
  assert.equal(notifier.events.at(-1)[0], "customerReplied");

  const own = await customer.resolveOwnTicket(planner, ticket.id);
  assert.equal(own.status, "resolved");
  assert.equal(notifier.events.at(-1)[0], "statusChanged");
  assert.equal(notifier.events.at(-1)[1].byAgent, false);
  assert.equal((await customer.resolveOwnTicket(planner, ticket.id)).status, "resolved");
});

test("only administrative roles reach the agent desk", async () => {
  const { customer, agent: desk } = build();
  const { ticket } = await customer.createTicket(planner, { subject: "x", body: "y" });
  for (const work of [
    () => desk.listInbox(planner, {}),
    () => desk.getTicket(planner, ticket.id),
    () => desk.reply(planner, ticket.id, { body: "hi" }),
    () => desk.addInternalNote(planner, ticket.id, { body: "hi" }),
    () => desk.updateTicket(planner, ticket.id, { priority: "high" }),
    () => desk.metrics(planner),
    () => desk.listAgents(planner),
    () => desk.createCannedReply(planner, { title: "t", body: "b" }),
  ]) {
    await rejects(work, "SUPPORT_FORBIDDEN", 403);
  }
  const superAdmin = { ...agent, role: "super-admin" };
  assert.equal((await desk.listInbox(superAdmin, {})).tickets.length, 1);
});

test("the inbox resolves filters, defaults to active tickets, and attaches people", async () => {
  const { customer, agent: desk } = build();
  const a = await customer.createTicket(planner, { subject: "Alpha billing", body: "1", category: "billing" });
  const b = await customer.createTicket(otherPlanner, { subject: "Beta bug", body: "2", category: "bug" });
  await desk.reply(agent, b.ticket.id, { body: "Closing.", status: "closed" });

  const active = await desk.listInbox(agent, {});
  assert.deepEqual(active.tickets.map((t) => t.subject), ["Alpha billing"]);
  assert.equal(active.tickets[0].requester.name, "Pat Planner");
  assert.equal(active.tickets[0].assignee, null);

  const all = await desk.listInbox(agent, { status: "all" });
  assert.equal(all.tickets.length, 2);
  assert.equal(all.tickets.find((t) => t.id === b.ticket.id).assignee.name, "Dana DXG");

  assert.equal((await desk.listInbox(agent, { status: "closed" })).tickets.length, 1);
  assert.equal((await desk.listInbox(agent, { status: "all", assignee: "me" })).tickets.length, 1);
  assert.equal((await desk.listInbox(agent, { assignee: "unassigned" })).tickets[0].id, a.ticket.id);
  assert.equal((await desk.listInbox(agent, { status: "all", category: "bug" })).tickets.length, 1);
  assert.equal((await desk.listInbox(agent, { status: "all", search: "beta" })).tickets.length, 1);
  await rejects(() => desk.listInbox(agent, { status: "bogus" }), "SUPPORT_INVALID_STATUS");
  await rejects(() => desk.listInbox(agent, { assignee: "zzz" }), "SUPPORT_INVALID_ID");
  const paged = await desk.listInbox(agent, { status: "all", perPage: "1", page: "2" });
  assert.equal(paged.tickets.length, 1);
  assert.deepEqual(paged.pagination, { page: 2, perPage: 1, total: 2, totalPages: 2 });
});

test("agents can assign, prioritise, recategorise, and change status with an audit trail", async () => {
  const { customer, agent: desk, repository, notifier } = build();
  const { ticket } = await customer.createTicket(planner, { subject: "Slow PDF", body: "Takes minutes." });

  await rejects(
    () => desk.updateTicket(agent, ticket.id, { assigneeUserId: PLANNER }),
    "SUPPORT_INVALID_ASSIGNEE",
    400,
  );
  const unchanged = await desk.updateTicket(agent, ticket.id, { priority: "normal" });
  assert.equal(unchanged.messageCount, 1);

  const updated = await desk.updateTicket(agent, ticket.id, {
    assigneeUserId: AGENT_TWO,
    priority: "urgent",
    category: "bug",
    status: "waiting_on_customer",
  });
  assert.equal(updated.assigneeUserId, AGENT_TWO);
  assert.equal(updated.priority, "urgent");
  assert.equal(updated.category, "bug");
  assert.equal(updated.status, "waiting_on_customer");
  assert.equal(updated.messageCount, 2);
  const trail = repository.messages.filter((m) => m.kind !== "message").map((m) => m.body);
  assert.deepEqual(trail, [
    "Dana DXG assigned this ticket to Eli DXG.",
    "Dana DXG set priority to urgent.",
    "Dana DXG changed the category to bug.",
    "Dana DXG changed the status to Waiting on customer.",
  ]);
  assert.equal(notifier.events.at(-1)[0], "statusChanged");

  const customerDetail = await customer.getOwnTicket(planner, ticket.id);
  assert.deepEqual(customerDetail.messages.map((message) => message.body), [
    "Takes minutes.",
    "Dana DXG changed the status to Waiting on customer.",
  ]);
  assert.equal(customerDetail.ticket.messageCount, 2);

  const closed = await desk.updateTicket(agent, ticket.id, { status: "closed", assigneeUserId: null });
  assert.equal(closed.status, "closed");
  assert.ok(closed.closedAt);
  assert.equal(closed.assigneeUserId, null);
  assert.match(repository.messages.at(-2).body, /unassigned/);

  const detail = await desk.getTicket(agent, ticket.id);
  assert.equal(detail.ticket.unreadForAgents, 0);
  assert.equal(detail.requester.email, "pat@example.com");
  assert.equal(detail.messages[0].author.name, "Pat Planner");
  assert.ok(detail.messages.some((m) => m.kind === "system"));
});

test("internal notes stay private and metrics attach agent summaries", async () => {
  const { customer, agent: desk, notifier } = build();
  const { ticket } = await customer.createTicket(planner, { subject: "x", body: "y" });
  const note = await desk.addInternalNote(agent, ticket.id, { body: "Escalate to engineering." });
  assert.equal(note.kind, "internal_note");
  assert.deepEqual(notifier.events.map((e) => e[0]), ["ticketCreated"]);
  const metrics = await desk.metrics(agent);
  assert.equal(metrics.perAgent[0].agent.name, "Dana DXG");
  assert.deepEqual((await desk.listAgents(agent)).map((a) => a.name), ["Dana DXG", "Eli DXG"]);
});

test("canned replies are organization-owned and validated", async () => {
  const { agent: desk } = build();
  const created = await desk.createCannedReply(agent, { title: " Password reset ", body: "Use Forgot password on the sign-in page." });
  assert.equal(created.title, "Password reset");
  assert.equal((await desk.listCannedReplies(agent)).length, 1);
  const updated = await desk.updateCannedReply(agent, created.id, { body: "Updated body." });
  assert.equal(updated.body, "Updated body.");
  await rejects(() => desk.updateCannedReply(agent, hex(1), { body: "x" }), "SUPPORT_CANNED_REPLY_NOT_FOUND", 404);
  await rejects(() => desk.createCannedReply(agent, { title: "", body: "x" }), "SUPPORT_INVALID_SUBJECT");
  await desk.deleteCannedReply(agent, created.id);
  await rejects(() => desk.deleteCannedReply(agent, created.id), "SUPPORT_CANNED_REPLY_NOT_FOUND", 404);
});
