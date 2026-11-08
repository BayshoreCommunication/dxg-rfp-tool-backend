import { createNotification } from "../../../utils/notificationService";
import { sendTransactionalEmail } from "../../../utils/emailService";
import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import { invitations } from "../invitations/composition";
import { createAccessRequestService, type Notifier } from "./accessRequests";

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const dashboardUrl = (path: string) => `${(process.env.FRONTEND_URL || "http://localhost:3000").trim().replace(/\/+$/, "")}${path}`;

const shell = (heading: string, body: string) => `
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1f2937;">
    <h2 style="color:#0f1b57;margin:0 0 12px;">${heading}</h2>
    ${body}
    <p style="color:#6b7280;font-size:12px;margin-top:24px;">RFPilot</p>
  </div>`;

const notifier: Notifier = {
  async requestCreated(input) {
    const reviewUrl = dashboardUrl("/settings/users");
    const who = `${input.name} (${input.email})`;
    // Bell notifications now; the emails go in the background so SMTP never slows signup.
    await Promise.allSettled(input.recipients.map((recipient) =>
      createNotification({
        userId: recipient.userId,
        type: "access_request",
        title: "New access request",
        message: `${who} asked to join ${input.organizationName}.`,
        metadata: { accessRequestId: input.requestId, organizationId: input.organizationId, link: "/settings/users" },
        dedupeKey: `access-request:${input.requestId}:${recipient.userId}`,
      })));
    void Promise.allSettled(input.recipients.map((recipient) =>
      sendTransactionalEmail({
        to: recipient.email,
        subject: `${input.name} asked to join ${input.organizationName} on RFPilot`,
        text: `${who} signed up with your verified email domain and asked to join ${input.organizationName}. Approve or deny the request in Users: ${reviewUrl}`,
        html: shell(
          "New access request",
          `<p><strong>${escapeHtml(input.name)}</strong> (${escapeHtml(input.email)}) signed up with your verified email domain and asked to join <strong>${escapeHtml(input.organizationName)}</strong>.</p>
           <p><a href="${escapeHtml(reviewUrl)}" style="display:inline-block;background:#0f1b57;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">Review the request</a></p>`,
        ),
      })));
  },
  async requestDenied(input) {
    const signUpUrl = dashboardUrl("/sign-up");
    await sendTransactionalEmail({
      to: input.email,
      subject: `Your request to join ${input.organizationName} on RFPilot`,
      text: `Hi ${input.name}, your request to join ${input.organizationName} on RFPilot wasn't approved. You can still create your own organization: ${signUpUrl}`,
      html: shell(
        "Your access request wasn't approved",
        `<p>Hi ${escapeHtml(input.name)}, your request to join <strong>${escapeHtml(input.organizationName)}</strong> on RFPilot wasn't approved.</p>
         <p>If you think this is a mistake, contact your organization's admin. You can also <a href="${escapeHtml(signUpUrl)}">create your own organization</a>.</p>`,
      ),
    });
  },
};

export const accessRequests = createAccessRequestService({
  invitations: invitations.service,
  notifier,
  audit: (input) => mongoSecurityAuditWriter.append({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: "access_request",
    targetId: input.targetId,
    decision: "allowed",
    reason: input.reason,
    correlationId: input.correlationId,
    metadata: input.metadata,
  }),
});
