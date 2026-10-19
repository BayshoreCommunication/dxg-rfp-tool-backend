import User from "../../../../../modal/userModel";
import { createNotification } from "../../../../../utils/notificationService";
import { sendCustomEmail } from "../../../../../utils/emailService";
import type { SupportDeskNotifier } from "../../domain/ports/supportDeskPorts";
import type { SupportTicketRecord, SupportTicketStatus } from "../../domain";

const ADMIN_ROLES = ["admin", "super_admin", "superadmin"];

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const excerpt = (body: string): string => {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 137)}…` : flat;
};

const emailEnabled = (): boolean =>
  process.env.SUPPORT_DESK_EMAIL_NOTIFICATIONS?.trim().toLowerCase() === "true";

const dxgInboxAddress = (): string | null => {
  const value = process.env.SUPPORT_DESK_NOTIFY_EMAIL?.trim();
  return value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
};

const frontendUrl = (): string =>
  (process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_FRONTEND_URL || "").replace(/\/+$/, "");
const adminUrl = (): string => (process.env.ADMIN_FRONTEND_URL || "").replace(/\/+$/, "");

const customerLink = (ticket: SupportTicketRecord): string => `${frontendUrl()}/support/${ticket.id}`;
const agentLink = (ticket: SupportTicketRecord): string => `${adminUrl()}/support/${ticket.id}`;

const label = (ticket: SupportTicketRecord): string => `#${ticket.ticketNumber} ${ticket.subject}`;

const STATUS_LABEL: Record<SupportTicketStatus, string> = {
  open: "open",
  waiting_on_customer: "waiting on you",
  resolved: "resolved",
  closed: "closed",
};

const bestEffort = async (work: () => Promise<unknown>, scope: string): Promise<void> => {
  try {
    await work();
  } catch (error) {
    console.error(`Support desk notification failed (${scope}):`, error instanceof Error ? error.message : error);
  }
};

const notifyAgents = async (
  ticket: SupportTicketRecord,
  title: string,
  message: string,
  dedupeSuffix: string,
): Promise<void> => {
  const agents = await User.find({
    organizationId: ticket.organizationId,
    role: { $in: ADMIN_ROLES },
    isBlocked: { $ne: true },
  })
    .select("_id")
    .lean();
  await Promise.all(
    agents.map((agent) =>
      bestEffort(
        () =>
          createNotification({
            userId: String(agent._id),
            type: "support_ticket",
            title,
            message,
            metadata: { ticketId: ticket.id, ticketNumber: ticket.ticketNumber, audience: "agent" },
            dedupeKey: `support:${ticket.id}:${dedupeSuffix}:${String(agent._id)}`,
          }),
        "agent notification",
      ),
    ),
  );
};

const emailDxg = async (subject: string, lines: string[], link: string): Promise<void> => {
  const to = dxgInboxAddress();
  if (!to || !emailEnabled()) return;
  await bestEffort(
    () =>
      sendCustomEmail({
        to,
        subject,
        text: [...lines, link].join("\n"),
        html: `<p>${lines.map(escapeHtml).join("</p><p>")}</p><p><a href="${escapeHtml(link)}">Open in the DXG admin</a></p>`,
      }),
    "dxg email",
  );
};

const emailRequester = async (
  email: string | null | undefined,
  subject: string,
  lines: string[],
  link: string,
): Promise<void> => {
  if (!email || !emailEnabled()) return;
  await bestEffort(
    () =>
      sendCustomEmail({
        to: email,
        subject,
        text: [...lines, link].join("\n"),
        html: `<p>${lines.map(escapeHtml).join("</p><p>")}</p><p><a href="${escapeHtml(link)}">Open the ticket in RFPilot</a></p>`,
      }),
    "requester email",
  );
};

/**
 * Bell notifications are always attempted; email is opt-in per environment.
 * Nothing here can fail a ticket write: every delivery is best-effort.
 */
export const supportDeskNotifier: SupportDeskNotifier = {
  async ticketCreated({ ticket, requester, message }) {
    const who = requester?.name ?? "A customer";
    await notifyAgents(
      ticket,
      `New support ticket ${label(ticket)}`,
      `${who}: ${excerpt(message.body)}`,
      `created:${message.id}`,
    );
    await emailDxg(
      `[RFPilot support] New ticket ${label(ticket)}`,
      [`${who} opened a support ticket.`, excerpt(message.body)],
      agentLink(ticket),
    );
  },

  async customerReplied({ ticket, requester, message }) {
    const who = requester?.name ?? "The customer";
    await notifyAgents(
      ticket,
      `Reply on ${label(ticket)}`,
      `${who}: ${excerpt(message.body)}`,
      `customer:${message.id}`,
    );
    await emailDxg(
      `[RFPilot support] Reply on ${label(ticket)}`,
      [`${who} replied.`, excerpt(message.body)],
      agentLink(ticket),
    );
  },

  async agentReplied({ ticket, requester, agent, message }) {
    const who = agent?.name ?? "DXG support";
    await bestEffort(
      () =>
        createNotification({
          userId: ticket.requesterUserId,
          type: "support_ticket",
          title: `DXG support replied on ${label(ticket)}`,
          message: `${who}: ${excerpt(message.body)}`,
          metadata: { ticketId: ticket.id, ticketNumber: ticket.ticketNumber, audience: "requester" },
          dedupeKey: `support:${ticket.id}:agent:${message.id}`,
        }),
      "requester notification",
    );
    await emailRequester(
      requester?.email,
      `DXG support replied on ${label(ticket)}`,
      [`${who} replied to your support ticket.`, excerpt(message.body)],
      customerLink(ticket),
    );
  },

  async statusChanged({ ticket, requester, status, byAgent }) {
    if (!byAgent) {
      await notifyAgents(
        ticket,
        `${label(ticket)} marked ${STATUS_LABEL[status]} by the customer`,
        `The customer marked this ticket ${STATUS_LABEL[status]}.`,
        `status:${status}:${ticket.updatedAt}`,
      );
      return;
    }
    await bestEffort(
      () =>
        createNotification({
          userId: ticket.requesterUserId,
          type: "support_ticket",
          title: `${label(ticket)} is now ${STATUS_LABEL[status]}`,
          message: `DXG support changed the status of your ticket to ${STATUS_LABEL[status]}.`,
          metadata: { ticketId: ticket.id, ticketNumber: ticket.ticketNumber, audience: "requester" },
          dedupeKey: `support:${ticket.id}:status:${status}:${ticket.updatedAt}`,
        }),
      "requester status notification",
    );
    await emailRequester(
      requester?.email,
      `Your support ticket ${label(ticket)} is now ${STATUS_LABEL[status]}`,
      [`DXG support changed the status of your ticket to ${STATUS_LABEL[status]}.`],
      customerLink(ticket),
    );
  },
};
