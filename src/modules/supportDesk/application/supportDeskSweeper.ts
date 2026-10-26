import type { SupportTicketRecord } from "../domain";
import type {
  SupportDeskClock,
  SupportDeskNotifier,
  SupportDeskRepository,
} from "../domain/ports/supportDeskPorts";
import {
  AUTO_CLOSE_AFTER_MS,
  AUTO_CLOSE_MIN_NOTICE_MS,
  AUTO_CLOSE_NOTE,
  AUTO_CLOSE_REMINDER_AFTER_MS,
  ESCALATE_AFTER_MS,
  autoCloseReminderBody,
  serviceLevelPatch,
} from "../serviceLevels";

export type SupportDeskSweepResult = {
  backfilled: number;
  escalated: number;
  reminded: number;
  closed: number;
  failed: number;
};

/**
 * The support desk's periodic housekeeping, across every organization:
 *
 * 1. Escalate: a customer message unanswered for 30 minutes alerts every
 *    agent, not just the ticket's owner (once per customer message).
 * 2. Remind: a ticket waiting on the customer for 5 days gets a friendly
 *    message in the thread plus a bell and email to the planner.
 * 3. Close: waiting 7 days, and reminded at least a day earlier, it closes
 *    itself. A customer reply at any point restarts everything.
 *
 * Each ticket is handled on its own so one failure never blocks the rest.
 */
export const createSupportDeskSweeper = (dependencies: {
  repository: SupportDeskRepository;
  notifier: SupportDeskNotifier;
  clock?: SupportDeskClock;
  batchSize?: number;
}) => {
  const { repository, notifier } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());
  const batchSize = dependencies.batchSize ?? 100;

  const each = async (tickets: SupportTicketRecord[], work: (ticket: SupportTicketRecord) => Promise<void>) => {
    let done = 0;
    let failed = 0;
    for (const ticket of tickets) {
      try {
        await work(ticket);
        done += 1;
      } catch (error) {
        failed += 1;
        console.error(
          `Support desk sweep failed for ticket ${ticket.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return { done, failed };
  };

  const person = async (ticket: SupportTicketRecord, userId: string | null) =>
    userId ? (await repository.findUserSummaries(ticket.organizationId, [userId])).get(userId) ?? null : null;

  return {
    async run(): Promise<SupportDeskSweepResult> {
      const now = clock();
      const nowIso = now.toISOString();
      const backfilled = await repository.backfillServiceLevels(now);

      const escalation = await each(
        await repository.listUnansweredSince(new Date(now.getTime() - ESCALATE_AFTER_MS), batchSize),
        async (ticket) => {
          const updated = (await repository.updateTicket(ticket.organizationId, ticket.id, { escalatedAt: nowIso })) ?? ticket;
          const since = Date.parse(ticket.lastCustomerMessageAt ?? ticket.createdAt);
          await notifier.ticketEscalated({
            ticket: updated,
            assignee: await person(ticket, ticket.assigneeUserId),
            waitingMinutes: Math.max(1, Math.round((now.getTime() - since) / 60_000)),
          });
        },
      );

      const reminders = await each(
        await repository.listNeedingCloseReminder(new Date(now.getTime() - AUTO_CLOSE_REMINDER_AFTER_MS), batchSize),
        async (ticket) => {
          const requester = await person(ticket, ticket.requesterUserId);
          // Customer-visible and signed as DXG support, like the first
          // acknowledgement, so it reads as a person checking in.
          const message = await repository.appendMessage({
            organizationId: ticket.organizationId,
            ticketId: ticket.id,
            authorUserId: null,
            authorRole: "system",
            kind: "message",
            body: autoCloseReminderBody(requester?.name),
            attachments: [],
            now,
          });
          const updated =
            (await repository.updateTicket(ticket.organizationId, ticket.id, {
              autoCloseReminderSentAt: nowIso,
              messageCountDelta: 1,
              unreadForRequester: ticket.unreadForRequester + 1,
              lastMessageAt: nowIso,
            })) ?? ticket;
          await notifier.autoCloseReminder({ ticket: updated, requester, message });
        },
      );

      const closures = await each(
        await repository.listDueToAutoClose(
          new Date(now.getTime() - AUTO_CLOSE_AFTER_MS),
          new Date(now.getTime() - AUTO_CLOSE_MIN_NOTICE_MS),
          batchSize,
        ),
        async (ticket) => {
          await repository.appendMessage({
            organizationId: ticket.organizationId,
            ticketId: ticket.id,
            authorUserId: null,
            authorRole: "system",
            kind: "system",
            body: AUTO_CLOSE_NOTE,
            attachments: [],
            now,
          });
          const updated =
            (await repository.updateTicket(ticket.organizationId, ticket.id, {
              status: "closed",
              closedAt: nowIso,
              lastMessageAt: nowIso,
              messageCountDelta: 1,
              ...serviceLevelPatch({ before: ticket, status: "closed", priority: ticket.priority, event: "change", now }),
            })) ?? ticket;
          await notifier.autoClosed({ ticket: updated, requester: await person(ticket, ticket.requesterUserId) });
        },
      );

      return {
        backfilled,
        escalated: escalation.done,
        reminded: reminders.done,
        closed: closures.done,
        failed: escalation.failed + reminders.failed + closures.failed,
      };
    },
  };
};
