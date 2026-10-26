import type {
  SupportTicketPatch,
  SupportTicketPriority,
  SupportTicketRecord,
  SupportTicketStatus,
  SupportUserSummary,
} from "./domain";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long an agent has to answer a customer message, by ticket priority. */
export const RESPONSE_TARGET_MS: Record<SupportTicketPriority, number> = {
  urgent: 1 * HOUR,
  high: 2 * HOUR,
  normal: 4 * HOUR,
  low: 8 * HOUR,
};

/** Unanswered this long, a ticket's alerts go to every agent, not just its owner. */
export const ESCALATE_AFTER_MS = 30 * MINUTE;
/** Waiting on the customer this long, they get a "we'll close this soon" reminder. */
export const AUTO_CLOSE_REMINDER_AFTER_MS = 5 * DAY;
/** Waiting on the customer this long, the ticket closes itself. */
export const AUTO_CLOSE_AFTER_MS = 7 * DAY;
/** A reminder always goes out at least this long before an automatic close. */
export const AUTO_CLOSE_MIN_NOTICE_MS = 1 * DAY;

export const responseDueAt = (fromIso: string, priority: SupportTicketPriority): string =>
  new Date(Date.parse(fromIso) + RESPONSE_TARGET_MS[priority]).toISOString();

type ServiceLevelFields = Pick<
  SupportTicketPatch,
  "responseDueAt" | "escalatedAt" | "waitingSince" | "autoCloseReminderSentAt"
>;

/**
 * The service-level fields after a change to a ticket. One place decides them
 * so every path (customer message, agent reply, manual status or priority
 * change, automatic close) keeps the response clock and the auto-close clock
 * consistent:
 *
 * - A customer message on an open ticket starts the response clock; an agent
 *   reply stops it. A priority change re-times a running clock from the
 *   customer's message; reopening by hand starts it from now.
 * - Waiting on the customer starts the auto-close clock (restarted by every
 *   agent reply); leaving that status clears it and its reminder.
 */
export const serviceLevelPatch = (input: {
  before: Pick<
    SupportTicketRecord,
    "status" | "priority" | "responseDueAt" | "waitingSince" | "lastCustomerMessageAt"
  > | null;
  status: SupportTicketStatus;
  priority: SupportTicketPriority;
  event: "customer_message" | "agent_message" | "change";
  now: Date;
}): ServiceLevelFields => {
  const { before, status, priority, event, now } = input;
  const nowIso = now.toISOString();
  const fields: ServiceLevelFields = {};

  if (status === "open") {
    if (event === "customer_message") {
      fields.responseDueAt = responseDueAt(nowIso, priority);
      fields.escalatedAt = null;
    } else if (event === "agent_message") {
      fields.responseDueAt = null;
      fields.escalatedAt = null;
    } else if (before?.status !== "open") {
      fields.responseDueAt = responseDueAt(nowIso, priority);
      fields.escalatedAt = null;
    } else if (before.responseDueAt && before.priority !== priority) {
      fields.responseDueAt = responseDueAt(before.lastCustomerMessageAt ?? nowIso, priority);
    }
  } else {
    fields.responseDueAt = null;
    fields.escalatedAt = null;
  }

  if (status === "waiting_on_customer") {
    if (event === "agent_message" || before?.status !== "waiting_on_customer" || !before.waitingSince) {
      fields.waitingSince = nowIso;
      fields.autoCloseReminderSentAt = null;
    }
  } else {
    fields.waitingSince = null;
    fields.autoCloseReminderSentAt = null;
  }

  return fields;
};

/**
 * The agent who should own a new ticket: the one with the fewest active
 * (open or waiting) tickets, ties broken at random so work spreads evenly.
 */
export const pickAssignee = (
  agents: readonly SupportUserSummary[],
  activeLoads: ReadonlyMap<string, number>,
  random: () => number = Math.random,
): SupportUserSummary | null => {
  if (!agents.length) return null;
  const load = (agent: SupportUserSummary) => activeLoads.get(agent.id) ?? 0;
  const lowest = Math.min(...agents.map(load));
  const candidates = agents.filter((agent) => load(agent) === lowest);
  return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
};

export const autoCloseReminderBody = (requesterName?: string | null): string => {
  const firstName = requesterName?.trim().split(/\s+/)[0];
  return [
    `Hi${firstName ? ` ${firstName}` : ""}, just checking in on this request.`,
    "We haven't heard back from you, so we'll close it in 2 days. If you still need help, reply here and it stays open.",
  ].join("\n\n");
};

export const AUTO_CLOSE_NOTE = "Closed automatically after 7 days without a reply from the customer.";
