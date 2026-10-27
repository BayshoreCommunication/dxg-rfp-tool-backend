import {
  SupportDeskError,
  canBeReadByRequester,
  presentToRequester,
  parseAttachmentIds,
  parseBody,
  parseCategory,
  parsePage,
  parsePerPage,
  parseStatus,
  parseSubject,
  parseSupportObjectId,
  ticketIsTerminal,
  type SupportActor,
  type SupportMessageRecord,
  type SupportTicketRecord,
} from "../domain";
import type {
  SupportDeskClock,
  SupportDeskNotifier,
  SupportDeskRepository,
} from "../domain/ports/supportDeskPorts";
import { claimAttachmentsForMessage } from "./supportAttachments";
import { pickAssignee, serviceLevelPatch } from "../serviceLevels";

export type CustomerSupportDeskDependencies = {
  repository: SupportDeskRepository;
  notifier: SupportDeskNotifier;
  clock?: SupportDeskClock;
  /** Give new tickets to the least-loaded agent (default on). */
  autoAssign?: boolean;
  /** Tie-breaker for automatic assignment; injectable for tests. */
  random?: () => number;
};

const requireOwnTicket = async (
  repository: SupportDeskRepository,
  actor: SupportActor,
  ticketId: unknown,
): Promise<SupportTicketRecord> => {
  const id = parseSupportObjectId(ticketId, "ticket id");
  const ticket = await repository.findTicket(actor.organizationId, id);
  if (!ticket || ticket.requesterUserId !== actor.userId) {
    throw new SupportDeskError("SUPPORT_TICKET_NOT_FOUND", "The support ticket was not found.", 404);
  }
  return ticket;
};

const bindAttachments = async (
  repository: SupportDeskRepository,
  actor: SupportActor,
  attachments: readonly { id: string }[],
  ticketId: string,
  messageId: string,
): Promise<void> => {
  if (attachments.length === 0) return;
  await repository.markAttachmentsUsed({
    organizationId: actor.organizationId,
    ids: attachments.map((item) => item.id),
    ticketId,
    messageId,
  });
};

const requesterSummary = async (
  repository: SupportDeskRepository,
  actor: SupportActor,
) => (await repository.findUserSummaries(actor.organizationId, [actor.userId])).get(actor.userId) ?? null;

/**
 * The automatic first reply on every new ticket, so the planner immediately
 * sees that the request was received (like a hosting provider's helpdesk). It
 * is authored by "system" so it never counts as the first agent response,
 * never changes the ticket status and never notifies anyone.
 */
export const autoAcknowledgementBody = (ticketNumber: number, requesterName?: string | null): string => {
  const firstName = requesterName?.trim().split(/\s+/)[0];
  return [
    `Hi${firstName ? ` ${firstName}` : ""}, thanks for contacting RFPilot support.`,
    `We've received your request (ticket #${ticketNumber}) and a member of our team will reply here as soon as possible. You'll also get an email when we respond.`,
    "If you have more details, screenshots or documents that could help, add them to this conversation.",
  ].join("\n\n");
};

/**
 * Planner-side helpdesk operations. Every read and write is bounded to the
 * actor's own organization and own tickets; internal agent notes never leave
 * the repository through this path.
 */
export const createCustomerSupportDesk = (dependencies: CustomerSupportDeskDependencies) => {
  const { repository, notifier } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  return {
    async createTicket(
      actor: SupportActor,
      input: { subject?: unknown; category?: unknown; body?: unknown; attachments?: unknown },
    ): Promise<{ ticket: SupportTicketRecord; message: SupportMessageRecord }> {
      const subject = parseSubject(input.subject);
      const category = input.category === undefined || input.category === null || input.category === ""
        ? "other"
        : parseCategory(input.category);
      const body = parseBody(input.body);
      const attachments = await claimAttachmentsForMessage(
        repository,
        actor,
        parseAttachmentIds(input.attachments),
      );
      const now = clock();
      const created = await repository.createTicket({
        organizationId: actor.organizationId,
        requesterUserId: actor.userId,
        subject,
        category,
        priority: "normal",
        now,
      });
      const message = await repository.appendMessage({
        organizationId: actor.organizationId,
        ticketId: created.id,
        authorUserId: actor.userId,
        authorRole: "customer",
        kind: "message",
        body,
        attachments,
        now,
      });
      await bindAttachments(repository, actor, attachments, created.id, message.id);
      const requester = await requesterSummary(repository, actor);
      await repository.appendMessage({
        organizationId: actor.organizationId,
        ticketId: created.id,
        authorUserId: null,
        authorRole: "system",
        kind: "message",
        body: autoAcknowledgementBody(created.ticketNumber, requester?.name),
        attachments: [],
        // One millisecond after the customer's message so it always sorts below it.
        now: new Date(now.getTime() + 1),
      });
      // Give the ticket to the agent with the fewest active tickets, so new
      // work spreads evenly and its alerts reach one owner, not everyone.
      const assignee =
        dependencies.autoAssign === false
          ? null
          : pickAssignee(
              await repository.listAgents(actor.organizationId),
              await repository.agentLoads(actor.organizationId),
              dependencies.random,
            );
      const ticket =
        (await repository.updateTicket(actor.organizationId, created.id, {
          messageCountDelta: 2,
          unreadForAgents: 1,
          lastMessageAt: now.toISOString(),
          lastCustomerMessageAt: now.toISOString(),
          ...(assignee ? { assigneeUserId: assignee.id } : {}),
          ...serviceLevelPatch({ before: null, status: "open", priority: created.priority, event: "customer_message", now }),
        })) ?? created;
      if (assignee) {
        await repository.appendMessage({
          organizationId: actor.organizationId,
          ticketId: created.id,
          authorUserId: null,
          authorRole: "system",
          kind: "internal_note",
          body: `Assigned automatically to ${assignee.name} (fewest open tickets).`,
          attachments: [],
          now: new Date(now.getTime() + 2),
        });
      }
      await notifier.ticketCreated({ ticket, requester, message });
      return { ticket, message };
    },

    async listOwnTickets(
      actor: SupportActor,
      query: { status?: unknown; page?: unknown; perPage?: unknown },
    ) {
      const page = parsePage(query.page);
      const perPage = parsePerPage(query.perPage);
      const status =
        query.status === undefined || query.status === "" || query.status === null
          ? undefined
          : query.status === "active"
            ? ("active" as const)
            : parseStatus(query.status);
      const result = await repository.listTickets(actor.organizationId, {
        requesterUserId: actor.userId,
        status,
        page,
        perPage,
      });
      const totalPages = Math.max(1, Math.ceil(result.total / perPage));
      return {
        tickets: result.tickets,
        pagination: { page, perPage, total: result.total, totalPages },
      };
    },

    async getOwnTicket(actor: SupportActor, ticketId: unknown) {
      const ticket = await requireOwnTicket(repository, actor, ticketId);
      const messages = (
        await repository.listMessages(actor.organizationId, ticket.id, { includeInternal: false })
      ).filter(canBeReadByRequester).map(presentToRequester);
      const current =
        ticket.unreadForRequester > 0
          ? (await repository.updateTicket(actor.organizationId, ticket.id, { unreadForRequester: 0 })) ?? ticket
          : ticket;
      const assignee = current.assigneeUserId
        ? (await repository.findUserSummaries(actor.organizationId, [current.assigneeUserId])).get(
            current.assigneeUserId,
          ) ?? null
        : null;
      return {
        ticket: current,
        messages,
        // Planners only need to know someone is on it, not who.
        assignee: assignee ? { id: assignee.id, name: "RFPilot support" } : null,
      };
    },

    async replyToOwnTicket(
      actor: SupportActor,
      ticketId: unknown,
      input: { body?: unknown; attachments?: unknown },
    ): Promise<{ ticket: SupportTicketRecord; message: SupportMessageRecord }> {
      const ticket = await requireOwnTicket(repository, actor, ticketId);
      // Resolved is a grace period: a reply reopens it. Closed (3 days after
      // resolving, or by an agent) is final. RFPilot agents can still reopen any
      // ticket from the admin.
      if (ticket.status === "closed") {
        throw new SupportDeskError(
          "SUPPORT_TICKET_CLOSED",
          "This request is closed and can no longer be replied to.",
          409,
        );
      }
      const body = parseBody(input.body);
      const attachments = await claimAttachmentsForMessage(
        repository,
        actor,
        parseAttachmentIds(input.attachments),
      );
      const now = clock();
      const message = await repository.appendMessage({
        organizationId: actor.organizationId,
        ticketId: ticket.id,
        authorUserId: actor.userId,
        authorRole: "customer",
        kind: "message",
        body,
        attachments,
        now,
      });
      await bindAttachments(repository, actor, attachments, ticket.id, message.id);
      const reopened = ticket.status === "waiting_on_customer" || ticket.status === "resolved";
      const updated =
        (await repository.updateTicket(actor.organizationId, ticket.id, {
          messageCountDelta: 1,
          unreadForAgents: ticket.unreadForAgents + 1,
          lastMessageAt: now.toISOString(),
          lastCustomerMessageAt: now.toISOString(),
          ...(reopened ? { status: "open", resolvedAt: null } : {}),
          ...serviceLevelPatch({ before: ticket, status: "open", priority: ticket.priority, event: "customer_message", now }),
        })) ?? ticket;
      if (ticket.status === "resolved") {
        await repository.appendMessage({
          organizationId: actor.organizationId,
          ticketId: ticket.id,
          authorUserId: null,
          authorRole: "system",
          kind: "system",
          body: "Ticket reopened by the customer.",
          attachments: [],
          now: new Date(now.getTime() + 1),
        });
        await repository.updateTicket(actor.organizationId, ticket.id, { messageCountDelta: 1 });
      }
      await notifier.customerReplied({
        ticket: updated,
        requester: await requesterSummary(repository, actor),
        message,
      });
      return { ticket: updated, message };
    },

    async resolveOwnTicket(actor: SupportActor, ticketId: unknown): Promise<SupportTicketRecord> {
      const ticket = await requireOwnTicket(repository, actor, ticketId);
      if (ticketIsTerminal(ticket.status)) return ticket;
      const now = clock();
      const updated =
        (await repository.updateTicket(actor.organizationId, ticket.id, {
          status: "resolved",
          resolvedAt: now.toISOString(),
          lastMessageAt: now.toISOString(),
          ...serviceLevelPatch({ before: ticket, status: "resolved", priority: ticket.priority, event: "change", now }),
        })) ?? ticket;
      await repository.appendMessage({
        organizationId: actor.organizationId,
        ticketId: ticket.id,
        authorUserId: null,
        authorRole: "system",
        kind: "system",
        body: "Marked as resolved by the customer.",
        attachments: [],
        now,
      });
      await notifier.statusChanged({
        ticket: updated,
        requester: await requesterSummary(repository, actor),
        status: "resolved",
        byAgent: false,
      });
      return updated;
    },

    async ownUnreadCount(actor: SupportActor): Promise<number> {
      return repository.countRequesterUnread(actor.organizationId, actor.userId);
    },
  };
};

export type CustomerSupportDesk = ReturnType<typeof createCustomerSupportDesk>;
