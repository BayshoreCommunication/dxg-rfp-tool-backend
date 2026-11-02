import type { InvitationEmail } from "../domain/ports";

const ROLE_LABELS: Record<InvitationEmail["role"], string> = {
  organization_admin: "Admin",
  team_manager: "Team Manager",
  planner: "Planner",
  viewer: "Viewer",
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);

// Names come from people (an organization or user name), so they're escaped and, in the subject
// and plain text, kept to one short line so a crafted name can't add headers or fake content.
const oneLine = (value: string, max = 120): string => value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);

const formatDate = (date: Date): string =>
  date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export type RenderedInvitationEmail = { subject: string; html: string; text: string };

export const renderInvitationEmail = (email: InvitationEmail): RenderedInvitationEmail => {
  const organization = oneLine(email.organizationName);
  const inviter = email.inviterName ? oneLine(email.inviterName, 80) : null;
  const role = ROLE_LABELS[email.role];
  const team = email.teamName ? oneLine(email.teamName, 80) : null;
  const expires = formatDate(email.expiresAt);
  const reminder = email.kind === "reminder";

  const subject = reminder
    ? `Reminder: your invitation to join ${organization} on RFPilot expires tomorrow`
    : inviter
      ? `${inviter} invited you to join ${organization} on RFPilot`
      : `You're invited to join ${organization} on RFPilot`;

  const who = inviter ? `${inviter} invited you` : "You've been invited";
  const lead = `${who} to join ${organization} on RFPilot as a ${role}${team ? ` in the ${team} team` : ""}.`;
  const replaced = email.kind === "invite" ? "" : "This link replaces any earlier invitation link we sent you.";

  const text = [
    reminder ? "Your RFPilot invitation expires tomorrow." : "",
    lead,
    "",
    `Accept the invitation: ${email.acceptUrl}`,
    "",
    `The link works once and expires on ${expires}.`,
    replaced,
    "If you weren't expecting this, you can ignore this email.",
  ].filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== "")).join("\n").trim();

  const url = escapeHtml(email.acceptUrl);
  const html = `
    <div style="font-family:Inter,sans-serif;max-width:520px;margin:auto;padding:32px;background:#f9f9f9;border-radius:12px;">
      <h2 style="color:#0f1b57;margin:0 0 8px;">${reminder ? "Your invitation expires tomorrow" : `Join ${escapeHtml(organization)} on RFPilot`}</h2>
      <p style="color:#555;margin:0 0 24px;line-height:1.5;">${escapeHtml(lead)}</p>
      <p style="margin:0 0 24px;">
        <a href="${url}" style="display:inline-block;background:#0f1b57;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">Accept invitation</a>
      </p>
      <p style="color:#888;font-size:12px;margin:0 0 8px;">Or paste this link into your browser:<br><span style="word-break:break-all;">${url}</span></p>
      <p style="color:#888;font-size:12px;margin:0 0 8px;">The link works once and expires on ${escapeHtml(expires)}.${replaced ? ` ${escapeHtml(replaced)}` : ""}</p>
      <p style="color:#888;font-size:12px;margin:0;">If you weren't expecting this, you can ignore this email.</p>
    </div>
  `;
  return { subject, html, text };
};
