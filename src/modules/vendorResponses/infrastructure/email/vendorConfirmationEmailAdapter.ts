import { sendCustomEmail } from "../../../../../utils/emailService";
import type { VendorConfirmationSender } from "../../domain/ports/vendorSubmissionPorts";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const buildHtml = (input: {
  vendorName: string;
  submittedBy: string;
  proposalTitle: string;
  isUpdate: boolean;
}) => `
  <div style="font-family:Inter,Arial,sans-serif;max-width:580px;margin:0 auto;padding:24px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
    <div style="text-align:center;margin-bottom:20px;">
      <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;background:#d1fae5;border-radius:50%;">
        <span style="font-size:28px;line-height:1;">&#10003;</span>
      </div>
      <h2 style="margin:12px 0 0;color:#0f172a;font-size:20px;">
        Response ${input.isUpdate ? "Updated" : "Submitted"} Successfully
      </h2>
    </div>
    <p style="color:#334155;font-size:14px;margin:0 0 12px;">
      Hi <strong>${escapeHtml(input.vendorName)}</strong>,
    </p>
    <p style="color:#334155;font-size:14px;margin:0 0 16px;">
      Your proposal response for <strong>&ldquo;${escapeHtml(input.proposalTitle)}&rdquo;</strong> has been
      ${input.isUpdate ? "updated" : "received"} successfully.
    </p>
    <div style="margin:0 0 18px;padding:14px;background:#ffffff;border:1px solid #dbeafe;border-radius:10px;">
      <p style="margin:0 0 6px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;">Submission Details</p>
      <p style="margin:0 0 4px;color:#0f172a;font-size:13px;"><strong>Submitted by:</strong> ${escapeHtml(input.submittedBy)}</p>
      <p style="margin:0;color:#0f172a;font-size:13px;"><strong>For proposal:</strong> ${escapeHtml(input.proposalTitle)}</p>
    </div>
    <p style="color:#64748b;font-size:13px;margin:0 0 8px;">
      The event planner will review your response and reach out if they are interested.
      You can update your response at any time by revisiting the original link.
    </p>
    <p style="color:#94a3b8;font-size:11px;margin:20px 0 0;padding-top:16px;border-top:1px solid #e2e8f0;">
      This is an automated confirmation from DXG RFP Tool. Please do not reply to this email.
    </p>
  </div>
`;

export const vendorConfirmationEmailAdapter: VendorConfirmationSender = {
  async send(input) {
    const action = input.isUpdate ? "updated" : "submitted";
    try {
      await sendCustomEmail({
        to: input.email,
        subject: `Your response has been ${action} — ${input.proposalTitle}`,
        html: buildHtml(input),
        text: `Hi ${input.vendorName},\n\nYour proposal response for "${input.proposalTitle}" has been ${action} successfully.\n\nSubmitted by: ${input.submittedBy}\n\nThe event planner will review your response and reach out if they are interested.\n\nDXG RFP Tool`,
      });
    } catch (error) {
      console.error(
        `[VendorConfirmation] Failed to send confirmation to ${input.email}:`,
        error,
      );
    }
  },
};
