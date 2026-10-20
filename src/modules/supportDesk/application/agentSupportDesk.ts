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

const requireTicket = async (
  repository: SupportDeskRepository,
  actor: SupportActor,
  ticketId: unknown,
): Promise<SupportTicketRecord> => {
  const id = parseSupportObjectId(ticketId, "ticket id");
  const ticket = await repository.findTicket(actor.organizationId, id);
  if (!ticket) {
    throw new SupportDeskError("SUPPORT_TICKET_NOT_FOUND", "The support ticket was not found.", 404);
  }
  return ticket;
};

const summaries = async (
  repository: SupportDeskRepository,
  organizationId: string,
  ids: readonly (string | null)[],
): Promise<Map<string, SupportUserSummary>> =>
  repository.findUserSummaries(
    organizationId,
    [...new Set(ids.filter((id): id is string => Boolean(id)))],
  );

const timestampsForStatus = (
  status: SupportTicketStatus,
  now: Date,
): Pick<SupportTicketPatch, "resolvedAt" | "closedAt"> => {
  if (status === "resolved") return { resolvedAt: now.toISOString() };
  if (status === "closed") return { closedAt: now.toISOString() };
  return { resolvedAt: null, closedAt: null };
};

/**
 * DXG-side helpdesk operations. Agents are organization members with an
 * administrative role; every operation is still bounded to the agent's own
 * organization so a tenant can never see another tenant's inbox.
 */
export const createAgentSupportDesk = (dependencies: AgentSupportDeskDependencies) => {
  const { repository, notifier } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  const auditMessage = async (
    actor: SupportActor,
    ticketId: string,
    body: string,
    now: Date,
    customerVisible: boolean,
  ) =>
    repository.appendMessage({
      organizationId: actor.organizationId,
      ticketId,
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
        page?: unknown;
        perPage?: unknown;
      },
    ) {
      assertAgent(actor);
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
      const result = await repository.listTickets(actor.organizationId, {
        status,
        assignee,
        priority: query.priority ? parsePriority(query.priority) : undefined,
        category: query.category ? parseCategory(query.category) : undefined,
        search: parseSearch(query.search),
        page,
        perPage,
      });
      const people = await summaries(
        repository,
        actor.organizationId,
        result.tickets.flatMap((ticket) => [ticket.requesterUserId, ticket.assigneeUserId]),
      );
      const totalPages = Math.max(1, Math.ceil(result.total / perPage));
      return {
        tickets: result.tickets.map((ticket) => ({
          ...ticket,
          requester: people.get(ticket.requesterUserId) ?? null,
          assignee: ticket.assigneeUserId ? people.get(ticket.assigneeUserId) ?? null : null,
        })),
        pagination: { page, perPage, total: result.total, totalPages },
      };
    },

    async getTicket(actor: SupportActor, ticketId: unknown) {
      assertAgent(actor);
      const ticket = await requireTicket(repository, actor, ticketId);
      const messages = await repository.listMessages(actor.organizationId, ticket.id, {
        includeInternal: true,
      });
      const current =
        ticket.unreadForAgents > 0
          ? (await repository.updateTicket(actor.organizationId, ticket.id, { unreadForAgents: 0 })) ?? ticket
          : ticket;
      const people = await summaries(repository, actor.organizationId, [
        ticket.requesterUserId,
        ticket.assigneeUserId,
        ...messages.map((message) => message.authorUserId),
      ]);
      return {
        ticket: current,
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
      assertAgent(actor);
      const ticket = await requireTicket(repository, actor, ticketId);
      const body = parseBody(input.body);
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
      const message = await repository.appendMessage({
        organizationId: actor.organizationId,
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
          organizationId: actor.organizationId,
          ids: attachments.map((item) => item.id),
          ticketId: ticket.id,
          messageId: message.id,
        });
      }
      const updated =
        (await repository.updateTicket(actor.organizationId, ticket.id, {
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
        })) ?? ticket;
      const people = await summaries(repository, actor.organizationId, [
        ticket.requesterUserId,
        actor.userId,
      ]);
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
      assertAgent(actor);
      const ticket = await requireTicket(repository, actor, ticketId);
      const body = parseBody(input.body);
      const now = clock();
      // Internal notes are invisible to the customer, so they never count
      // toward the ticket's message count or move it in the inbox.
      return repository.appendMessage({
        organizationId: actor.organizationId,
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
      assertAgent(actor);
      const ticket = await requireTicket(repository, actor, ticketId);
      const now = clock();
      const patch: SupportTicketPatch & { subject?: string } = {};
      const events: Array<{ body: string; customerVisible: boolean }> = [];
      const people = await summaries(repository, actor.organizationId, [actor.userId]);
      const agentName = people.get(actor.userId)?.name ?? "An agent";

      if (input.assigneeUserId !== undefined) {
        const assigneeUserId =
          input.assigneeUserId === null || input.assigneeUserId === ""
            ? null
            : parseSupportObjectId(input.assigneeUserId, "assignee id");
        if (assigneeUserId) {
          const agents = await repository.listAgents(actor.organizationId);
          if (!agents.some((agent) => agent.id === assigneeUserId)) {
            throw new SupportDeskError("SUPPORT_INVALID_ASSIGNEE", "The assignee must be a support agent.", 400);
          }
        }
        if (assigneeUserId !== ticket.assigneeUserId) {
          patch.assigneeUserId = assigneeUserId;
          const assigneeName = assigneeUserId
            ? (await summaries(repository, actor.organizationId, [assigneeUserId])).get(assigneeUserId)?.name ?? "an agent"
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
      const updated = (await repository.updateTicket(actor.organizationId, ticket.id, patch)) ?? ticket;
      for (const event of events) {
        await auditMessage(actor, ticket.id, event.body, now, event.customerVisible);
      }
      const publicEventCount = events.filter((event) => event.customerVisible).length;
      if (publicEventCount > 0) {
        await repository.updateTicket(actor.organizationId, ticket.id, { messageCountDelta: publicEventCount });
      }
      if (statusChanged) {
        const requester = (await summaries(repository, actor.organizationId, [ticket.requesterUserId])).get(
          ticket.requesterUserId,
        ) ?? null;
        await notifier.statusChanged({ ticket: updated, requester, status: statusChanged, byAgent: true });
      }
      return { ...updated, messageCount: updated.messageCount + publicEventCount };
    },

    async metrics(actor: SupportActor) {
      assertAgent(actor);
      const metrics = await repository.metrics(actor.organizationId);
      const people = await summaries(
        repository,
        actor.organizationId,
        metrics.perAgent.map((row) => row.agentUserId),
      );
      return {
        ...metrics,
        perAgent: metrics.perAgent.map((row) => ({
          ...row,
          agent: people.get(row.agentUserId) ?? null,
        })),
      };
    },

    async listAgents(actor: SupportActor): Promise<SupportUserSummary[]> {
      assertAgent(actor);
      return repository.listAgents(actor.organizationId);
    },

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
