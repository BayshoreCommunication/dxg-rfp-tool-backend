import {
  SupportDeskError,
  assertAgent,
  parseAttachmentIds,
  parseBody,
  parseCategory,
  parsePage,
  parsePerPage,
  parsePriority,
  parseSearch,
  parseStatus,
  parseSubject,
  parseSupportObjectId,
  ticketIsTerminal,
  type SupportActor,
  type SupportMessageRecord,
  type SupportOrganizationSummary,
  type SupportTicketPatch,
  type SupportTicketRecord,
  type SupportTicketStatus,
  type SupportUserSummary,
} from "../domain";
import type {
  SupportDeskClock,
  SupportDeskNotifier,
  SupportDeskRepository,
} from "../domain/ports/supportDeskPorts";
import { claimAttachmentsForMessage } from "./supportAttachments";
import { agentScopeFor, type AgentScope } from "./agentScope";
import { serviceLevelPatch } from "../serviceLevels";

export type AgentSupportDeskDependencies = {
  repository: SupportDeskRepository;
  notifier: SupportDeskNotifier;
  clock?: SupportDeskClock;
};

const STATUS_LABEL: Record<SupportTicketStatus, string> = {
  open: "Open",
  waiting_on_customer: "Waiting on customer",
  resolved: "Resolved",
  closed: "Closed",
};

const requireTicket = async (scope: AgentScope, ticketId: unknown): Promise<SupportTicketRecord> => {
  const id = parseSupportObjectId(ticketId, "ticket id");
  const ticket = await scope.findTicket(id);
  if (!ticket) {
    throw new SupportDeskError("SUPPORT_TICKET_NOT_FOUND", "The support ticket was not found.", 404);
  }
  return ticket;
};

/** The people on one ticket: its requester inside the ticket's organization, plus agents. */
const peopleOn = (
  scope: AgentScope,
  ticket: Pick<SupportTicketRecord, "organizationId">,
  ids: readonly (string | null)[],
): Promise<Map<string, SupportUserSummary>> =>
  scope.people([{ organizationId: ticket.organizationId, userIds: ids }]);

const organizationOf = (
  names: ReadonlyMap<string, string>,
  ticket: Pick<SupportTicketRecord, "organizationId">,
): SupportOrganizationSummary => ({
  id: ticket.organizationId,
  name: names.get(ticket.organizationId) || null,
});

const timestampsForStatus = (
  status: SupportTicketStatus,
  now: Date,
): Pick<SupportTicketPatch, "resolvedAt" | "closedAt"> => {
  if (status === "resolved") return { resolvedAt: now.toISOString() };
  if (status === "closed") return { closedAt: now.toISOString() };
  return { resolvedAt: null, closedAt: null };
};

/**
 * RFPilot-side helpdesk operations. RFPilot staff (`admins` accounts with a staff
 * role) answer every organization's tickets; any other account that passes the agent
 * check stays inside its own organization (see `agentScopeFor`). Ticket conversations
 * and their attachments only: nothing here reads a customer's proposals.
 */
export const createAgentSupportDesk = (dependencies: AgentSupportDeskDependencies) => {
  const { repository, notifier } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  const auditMessage = async (
    actor: SupportActor,
    ticket: SupportTicketRecord,
    body: string,
    now: Date,
    customerVisible: boolean,
  ) =>
    repository.appendMessage({
      organizationId: ticket.organizationId,
      ticketId: ticket.id,
      authorUserId: actor.userId,
      authorRole: "system",
      kind: customerVisible ? "system" : "internal_note",
      body,
      attachments: [],
      now,
    });

  return {
    async listInbox(
      actor: SupportActor,
      query: {
        status?: unknown;
        assignee?: unknown;
        priority?: unknown;
        category?: unknown;
        search?: unknown;
        organization?: unknown;
        sort?: unknown;
        page?: unknown;
        perPage?: unknown;
      },
    ) {
      const scope = agentScopeFor(repository, actor);
      const page = parsePage(query.page);
      const perPage = parsePerPage(query.perPage);
      const status =
        query.status === undefined || query.status === "" || query.status === null
          ? ("active" as const)
          : query.status === "all"
            ? undefined
            : query.status === "active"
              ? ("active" as const)
              : parseStatus(query.status);
      const assigneeRaw = String(query.assignee ?? "").trim();
      const assignee =
        assigneeRaw === ""
          ? undefined
          : assigneeRaw === "unassigned"
            ? ("unassigned" as const)
            : assigneeRaw === "me"
              ? actor.userId
              : parseSupportObjectId(assigneeRaw, "assignee id");
      const organizationRaw = String(query.organization ?? "").trim();
      const result = await scope.listTickets({
        status,
        assignee,
        // One customer organization's tickets; only the staff inbox spans more than one.
        organizationId: organizationRaw ? parseSupportObjectId(organizationRaw, "organization id") : undefined,
        priority: query.priority ? parsePriority(query.priority) : undefined,
        category: query.category ? parseCategory(query.category) : undefined,
        search: parseSearch(query.search),
        sort: query.sort === "recent" ? "recent" : "urgency",
        page,
        perPage,
      });
      const [people, organizations] = await Promise.all([
        scope.people(
          result.tickets.map((ticket) => ({
            organizationId: ticket.organizationId,
            userIds: [ticket.requesterUserId, ticket.assigneeUserId],
          })),
        ),
        repository.findOrganizationNames(result.tickets.map((ticket) => ticket.organizationId)),
      ]);
      const totalPages = Math.max(1, Math.ceil(result.total / perPage));
      return {
        // Ticket numbers are per organization: with "all_organizations" a number is only
        // unique together with the ticket's organization.
        scope: scope.platform ? ("all_organizations" as const) : ("organization" as const),
        tickets: result.tickets.map((ticket) => ({
          ...ticket,
          organization: organizationOf(organizations, ticket),
          requester: people.get(ticket.requesterUserId) ?? null,
          assignee: ticket.assigneeUserId ? people.get(ticket.assigneeUserId) ?? null : null,
        })),
        pagination: { page, perPage, total: result.total, totalPages },
      };
    },

    async getTicket(actor: SupportActor, ticketId: unknown) {
      const scope = agentScopeFor(repository, actor);
      const ticket = await requireTicket(scope, ticketId);
      const messages = await repository.listMessages(ticket.organizationId, ticket.id, {
        includeInternal: true,
      });
      const current =
        ticket.unreadForAgents > 0
          ? (await repository.updateTicket(ticket.organizationId, ticket.id, { unreadForAgents: 0 })) ?? ticket
          : ticket;
      const [people, organizations] = await Promise.all([
        peopleOn(scope, ticket, [
          ticket.requesterUserId,
          ticket.assigneeUserId,
          ...messages.map((message) => message.authorUserId),
        ]),
        repository.findOrganizationNames([ticket.organizationId]),
      ]);
      return {
        ticket: current,
        organization: organizationOf(organizations, ticket),
        requester: people.get(ticket.requesterUserId) ?? null,
        assignee: current.assigneeUserId ? people.get(current.assigneeUserId) ?? null : null,
        messages: messages.map((message) => ({
          ...message,
          author: message.authorUserId ? people.get(message.authorUserId) ?? null : null,
        })),
      };
    },

    async reply(
      actor: SupportActor,
      ticketId: unknown,
      input: { body?: unknown; attachments?: unknown; status?: unknown },
    ): Promise<{ ticket: SupportTicketRecord; message: SupportMessageRecord }> {
      const scope = agentScopeFor(repository, actor);
      const ticket = await requireTicket(scope, ticketId);
      const body = parseBody(input.body);
      // An agent's uploads are pending under the agent's own account and organization.
      const attachments = await claimAttachmentsForMessage(
        repository,
        actor,
        parseAttachmentIds(input.attachments),
      );
      const nextStatus: SupportTicketStatus =
        input.status === undefined || input.status === null || input.status === ""
          ? "waiting_on_customer"
          : parseStatus(input.status);
      const now = clock();
      // The reply is written into the ticket's organization, where the customer reads it.
      const message = await repository.appendMessage({
        organizationId: ticket.organizationId,
        ticketId: ticket.id,
        authorUserId: actor.userId,
        authorRole: "agent",
        kind: "message",
        body,
        attachments,
        now,
      });
      if (attachments.length) {
        await repository.markAttachmentsUsed({
          // The pending upload rows live under the agent's own organization.
          organizationId: actor.organizationId,
          ids: attachments.map((item) => item.id),
          ticketId: ticket.id,
          messageId: message.id,
        });
      }
      const updated =
        (await repository.updateTicket(ticket.organizationId, ticket.id, {
          messageCountDelta: 1,
          unreadForRequester: ticket.unreadForRequester + 1,
          // Replying implies the agent has read everything the customer sent.
          unreadForAgents: 0,
          lastMessageAt: now.toISOString(),
          lastAgentMessageAt: now.toISOString(),
          firstAgentResponseAt: ticket.firstAgentResponseAt ?? now.toISOString(),
          status: nextStatus,
          ...(ticket.assigneeUserId ? {} : { assigneeUserId: actor.userId }),
          ...timestampsForStatus(nextStatus, now),
          ...serviceLevelPatch({ before: ticket, status: nextStatus, priority: ticket.priority, event: "agent_message", now }),
        })) ?? ticket;
      const people = await peopleOn(scope, ticket, [ticket.requesterUserId, actor.userId]);
      await notifier.agentReplied({
        ticket: updated,
        requester: people.get(ticket.requesterUserId) ?? null,
        agent: people.get(actor.userId) ?? null,
        message,
      });
      if (nextStatus !== ticket.status && ticketIsTerminal(nextStatus)) {
        await notifier.statusChanged({
          ticket: updated,
          requester: people.get(ticket.requesterUserId) ?? null,
          status: nextStatus,
          byAgent: true,
        });
      }
      return { ticket: updated, message };
    },

    async addInternalNote(
      actor: SupportActor,
      ticketId: unknown,
      input: { body?: unknown },
    ): Promise<SupportMessageRecord> {
      const scope = agentScopeFor(repository, actor);
      const ticket = await requireTicket(scope, ticketId);
      const body = parseBody(input.body);
      const now = clock();
      // Internal notes are invisible to the customer, so they never count
      // toward the ticket's message count or move it in the inbox.
      return repository.appendMessage({
        organizationId: ticket.organizationId,
        ticketId: ticket.id,
        authorUserId: actor.userId,
        authorRole: "agent",
        kind: "internal_note",
        body,
        attachments: [],
        now,
      });
    },

    async updateTicket(
      actor: SupportActor,
      ticketId: unknown,
      input: { assigneeUserId?: unknown; priority?: unknown; category?: unknown; status?: unknown; subject?: unknown },
    ): Promise<SupportTicketRecord> {
      const scope = agentScopeFor(repository, actor);
      const ticket = await requireTicket(scope, ticketId);
      const now = clock();
      const patch: SupportTicketPatch & { subject?: string } = {};
      const events: Array<{ body: string; customerVisible: boolean }> = [];
      const people = await peopleOn(scope, ticket, [actor.userId]);
      const agentName = people.get(actor.userId)?.name ?? "An agent";

      if (input.assigneeUserId !== undefined) {
        const assigneeUserId =
          input.assigneeUserId === null || input.assigneeUserId === ""
            ? null
            : parseSupportObjectId(input.assigneeUserId, "assignee id");
        if (assigneeUserId) {
          const agents = await scope.listAgents();
          if (!agents.some((agent) => agent.id === assigneeUserId)) {
            throw new SupportDeskError("SUPPORT_INVALID_ASSIGNEE", "The assignee must be a support agent.", 400);
          }
        }
        if (assigneeUserId !== ticket.assigneeUserId) {
          patch.assigneeUserId = assigneeUserId;
          const assigneeName = assigneeUserId
            ? (await peopleOn(scope, ticket, [assigneeUserId])).get(assigneeUserId)?.name ?? "an agent"
            : null;
          events.push({
            body: assigneeName ? `${agentName} assigned this ticket to ${assigneeName}.` : `${agentName} unassigned this ticket.`,
            customerVisible: false,
          });
        }
      }
      if (input.priority !== undefined) {
        const priority = parsePriority(input.priority);
        if (priority !== ticket.priority) {
          patch.priority = priority;
          events.push({ body: `${agentName} set priority to ${priority}.`, customerVisible: false });
        }
      }
      if (input.category !== undefined) {
        const category = parseCategory(input.category);
        if (category !== ticket.category) {
          patch.category = category;
          events.push({
            body: `${agentName} changed the category to ${category.replace(/_/g, " ")}.`,
            customerVisible: false,
          });
        }
      }
      if (input.subject !== undefined) {
        const subject = parseSubject(input.subject);
        if (subject !== ticket.subject) {
          patch.subject = subject;
          events.push({ body: `${agentName} renamed the ticket.`, customerVisible: false });
        }
      }
      let statusChanged: SupportTicketStatus | null = null;
      if (input.status !== undefined) {
        const status = parseStatus(input.status);
        if (status !== ticket.status) {
          patch.status = status;
          Object.assign(patch, timestampsForStatus(status, now));
          statusChanged = status;
          events.push({
            body: `${agentName} changed the status to ${STATUS_LABEL[status]}.`,
            customerVisible: true,
          });
        }
      }
      if (events.length === 0) return ticket;
      if (statusChanged) patch.lastMessageAt = now.toISOString();
      if (patch.status !== undefined || patch.priority !== undefined) {
        Object.assign(
          patch,
          serviceLevelPatch({
            before: ticket,
            status: patch.status ?? ticket.status,
            priority: patch.priority ?? ticket.priority,
            event: "change",
            now,
          }),
        );
      }
      const updated = (await repository.updateTicket(ticket.organizationId, ticket.id, patch)) ?? ticket;
      for (const event of events) {
        await auditMessage(actor, ticket, event.body, now, event.customerVisible);
      }
      const publicEventCount = events.filter((event) => event.customerVisible).length;
      if (publicEventCount > 0) {
        await repository.updateTicket(ticket.organizationId, ticket.id, { messageCountDelta: publicEventCount });
      }
      if (patch.assigneeUserId && patch.assigneeUserId !== actor.userId) {
        await notifier.ticketAssigned({ ticket: updated, assigneeUserId: patch.assigneeUserId, assignedBy: agentName });
      }
      if (statusChanged) {
        const requester = (await peopleOn(scope, ticket, [ticket.requesterUserId])).get(ticket.requesterUserId) ?? null;
        await notifier.statusChanged({ ticket: updated, requester, status: statusChanged, byAgent: true });
      }
      return { ...updated, messageCount: updated.messageCount + publicEventCount };
    },

    async metrics(actor: SupportActor) {
      const scope = agentScopeFor(repository, actor);
      const metrics = await scope.metrics(clock());
      // Assignees are agents; naming the actor's organization never resolves a customer here.
      const people = await scope.people([
        { organizationId: actor.organizationId, userIds: metrics.perAgent.map((row) => row.agentUserId) },
      ]);
      return {
        ...metrics,
        perAgent: metrics.perAgent.map((row) => ({
          ...row,
          agent: people.get(row.agentUserId) ?? null,
        })),
      };
    },

    async listAgents(actor: SupportActor): Promise<SupportUserSummary[]> {
      return agentScopeFor(repository, actor).listAgents();
    },

    // Canned replies belong to the support team, not to a customer: they stay in the
    // agent's own organization and are usable on any ticket the agent can answer.
    async listCannedReplies(actor: SupportActor) {
      assertAgent(actor);
      return repository.listCannedReplies(actor.organizationId);
    },

    async createCannedReply(actor: SupportActor, input: { title?: unknown; body?: unknown }) {
      assertAgent(actor);
      return repository.createCannedReply({
        organizationId: actor.organizationId,
        title: parseSubject(input.title).slice(0, 120),
        body: parseBody(input.body),
        createdByUserId: actor.userId,
      });
    },

    async updateCannedReply(actor: SupportActor, id: unknown, input: { title?: unknown; body?: unknown }) {
      assertAgent(actor);
      const patch: { title?: string; body?: string } = {};
      if (input.title !== undefined) patch.title = parseSubject(input.title).slice(0, 120);
      if (input.body !== undefined) patch.body = parseBody(input.body);
      const updated = await repository.updateCannedReply(
        actor.organizationId,
        parseSupportObjectId(id, "canned reply id"),
        patch,
      );
      if (!updated) {
        throw new SupportDeskError("SUPPORT_CANNED_REPLY_NOT_FOUND", "The canned reply was not found.", 404);
      }
      return updated;
    },

    async deleteCannedReply(actor: SupportActor, id: unknown): Promise<void> {
      assertAgent(actor);
      const deleted = await repository.deleteCannedReply(
        actor.organizationId,
        parseSupportObjectId(id, "canned reply id"),
      );
      if (!deleted) {
        throw new SupportDeskError("SUPPORT_CANNED_REPLY_NOT_FOUND", "The canned reply was not found.", 404);
      }
    },
  };
};

export type AgentSupportDesk = ReturnType<typeof createAgentSupportDesk>;
