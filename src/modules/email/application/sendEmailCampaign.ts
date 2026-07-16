import type {
  CampaignEmailDeliveryPort,
  CampaignRecipient,
  EmailCampaignSendingRepository,
} from "../domain/ports/emailCampaignSendingPorts";

const EMAIL_REGEX = /^\S+@\S+\.\S+$/;
const slug = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const cleanMessage = (message: string) =>
  message
    .split("\n")
    .filter((line) => !/proposal link\s*:/i.test(line))
    .join("\n")
    .trim();
const normalizeRecipients = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) =>
          typeof item === "string" ? item.trim().toLowerCase() : "",
        )
        .filter((email) => EMAIL_REGEX.test(email)),
    ),
  ];
};
const trimBase = (value: string) => value.replace(/\/+$/, "");

const emailHtml = (input: {
  title: string;
  message: string;
  proposalUrl: string;
  openUrl: string;
  clickUrl: string;
  reference: string;
  vendorClickUrl: string;
}) => `
  <div style="font-family:Inter,Arial,sans-serif;max-width:620px;margin:0 auto;padding:24px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
    <p style="margin:0 0 8px;color:#0f172a;font-size:14px;">You have received a proposal from DXG.</p>
    <h2 style="margin:0 0 8px;color:#0f172a;font-size:22px;">${escapeHtml(input.title)}</h2>
    <p style="margin:0 0 14px;color:#64748b;font-size:12px;">Reference: ${escapeHtml(input.reference)}</p>
    <div style="margin:0 0 20px;color:#334155;font-size:14px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(input.message)}</div>
    <div style="margin:0 0 18px;padding:14px;border-radius:10px;background:#ffffff;border:1px solid #dbeafe;"><p style="margin:0 0 4px;color:#0f172a;font-size:13px;font-weight:700;">Proposal Preview</p><p style="margin:0;color:#475569;font-size:12px;">${escapeHtml(input.title)}</p></div>
    <a href="${input.clickUrl}" style="display:inline-block;background:#06b6d4;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">View Proposal</a>
    <p style="margin:16px 0 0;color:#64748b;font-size:12px;">If the button does not work, copy this link: <a href="${input.proposalUrl}" style="color:#0284c7;text-decoration:underline;">${input.proposalUrl}</a></p>
    <div style="margin:24px 0 0;padding-top:20px;border-top:1px solid #e2e8f0;"><p style="margin:0 0 10px;color:#334155;font-size:13px;font-weight:600;">Ready to respond to this proposal?</p><a href="${input.vendorClickUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">Submit Your Proposal</a></div>
    <img src="${input.openUrl}" alt="" width="1" height="1" style="display:block;opacity:0;" />
  </div>
`;

export const createSendOwnedEmailCampaign = (dependencies: {
  repository: EmailCampaignSendingRepository;
  delivery: CampaignEmailDeliveryPort;
  frontendBaseUrl: string;
  apiBaseUrl: string;
  trackingId: () => string;
  now?: () => Date;
}) => async (input: {
  ownerUserId: string;
  proposalId?: string;
  recipientEmails: unknown;
  subject?: string;
  message?: string;
}) => {
  if (!input.proposalId) return { kind: "proposal_id_required" as const };
  const emails = normalizeRecipients(input.recipientEmails);
  if (!emails.length) return { kind: "recipients_required" as const };
  const proposal = await dependencies.repository.findOwnedProposal({
    proposalId: input.proposalId,
    ownerUserId: input.ownerUserId,
  });
  if (!proposal) return { kind: "proposal_not_found" as const };
  const proposalSlug = `${slug(proposal.proposalTitle) || "proposal"}-${
    proposal.proposalId
  }`;
  const frontend = trimBase(dependencies.frontendBaseUrl);
  const api = trimBase(dependencies.apiBaseUrl);
  const proposalUrl = `${frontend}/proposal-view/${proposalSlug}?source=email`;
  const vendorUrl = `${frontend}/vendor-response/${proposalSlug}?source=email`;
  const subject =
    input.subject?.trim() ||
    `Proposal for ${proposal.proposalTitle} - DXG RFP Tool`;
  const defaultMessage = `Hi,\n\nPlease review the proposal and let us know your feedback.\n\nBest regards,\nDXG Team`;
  const message = cleanMessage(input.message?.trim() || defaultMessage);
  const reference = `#${proposal.proposalId.slice(-8).toUpperCase()}`;
  const recipients: CampaignRecipient[] = emails.map((email) => ({
    email,
    trackingId: dependencies.trackingId(),
    status: "failed",
  }));
  const { campaignId } = await dependencies.repository.createCampaign({
    ownerUserId: input.ownerUserId,
    proposalId: proposal.proposalId,
    proposalTitle: proposal.proposalTitle,
    proposalSlug,
    subject,
    message,
    recipients,
  });
  let sentCount = 0;
  for (const recipient of recipients) {
    try {
      const openUrl = `${api}/api/emails/open/${recipient.trackingId}`;
      const clickUrl = `${api}/api/emails/click/${recipient.trackingId}?redirect=${encodeURIComponent(proposalUrl)}`;
      const vendorClickUrl = `${api}/api/emails/vendor-click/${recipient.trackingId}?redirect=${encodeURIComponent(vendorUrl)}`;
      await dependencies.delivery.send({
        to: recipient.email,
        subject,
        html: emailHtml({
          title: proposal.proposalTitle,
          message,
          proposalUrl,
          openUrl,
          clickUrl,
          reference,
          vendorClickUrl,
        }),
        text: `${message}\n\nView proposal: ${proposalUrl}`,
      });
      recipient.status = "sent";
      recipient.sentAt = (dependencies.now ?? (() => new Date()))();
      delete recipient.errorMessage;
      sentCount += 1;
    } catch (error) {
      recipient.status = "failed";
      recipient.errorMessage =
        error instanceof Error ? error.message : "Unknown send error";
    }
  }
  const campaign = await dependencies.repository.finalizeCampaign({
    campaignId,
    ownerUserId: input.ownerUserId,
    recipients,
    sentCount,
  });
  const failedRecipients = recipients
    .filter((recipient) => recipient.status === "failed")
    .map((recipient) => ({
      email: recipient.email,
      errorMessage: recipient.errorMessage || "Unknown send error",
    }));
  return {
    kind: sentCount === 0 ? ("all_failed" as const) : ("processed" as const),
    campaign,
    sentCount,
    failedCount: recipients.length - sentCount,
    failedRecipients,
    totalRecipients: recipients.length,
  };
};
