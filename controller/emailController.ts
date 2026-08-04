import { Request, Response } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../middleware/auth";
import {
  deleteOwnedEmailCampaignById,
  deleteOwnedEmailCampaignsByProposal,
  getOwnedEmailStats,
  listOwnedEmailCampaigns,
  sendOwnedEmailCampaign,
  trackEmailOpen,
  trackProposalClick,
  trackVendorResponseClick,
} from "../src/modules/email/composition";

const EMAIL_REGEX = /^\S+@\S+\.\S+$/;

const toSlug = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const firstUrlFromEnv = (value: string): string =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)[0] || value.trim();

const getApiBaseUrl = (): string =>
  firstUrlFromEnv(process.env.BACKEND_URL || process.env.API_URL || "http://localhost:5000").replace(/\/+$/, "");

const getFrontendBaseUrl = (): string =>
  firstUrlFromEnv(process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "");

const buildProposalPublicUrl = (proposalSlug: string): string =>
  `${getFrontendBaseUrl()}/proposal-view/${proposalSlug}?source=email`;

const buildVendorResponseUrl = (proposalSlug: string): string =>
  `${getFrontendBaseUrl()}/vendor-response/${proposalSlug}?source=email`;

const buildVendorResponseTrackingClickUrl = (
  trackingId: string,
  redirectUrl: string,
): string =>
  `${getApiBaseUrl()}/api/emails/vendor-click/${trackingId}?redirect=${encodeURIComponent(redirectUrl)}`;

const buildTrackingOpenUrl = (trackingId: string): string =>
  `${getApiBaseUrl()}/api/emails/open/${trackingId}`;

const buildTrackingClickUrl = (
  trackingId: string,
  redirectUrl: string,
): string =>
  `${getApiBaseUrl()}/api/emails/click/${trackingId}?redirect=${encodeURIComponent(
    redirectUrl,
  )}`;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const cleanEmailMessage = (message: string): string =>
  message
    .split("\n")
    .filter((line) => !/proposal link\s*:/i.test(line))
    .join("\n")
    .trim();

const buildProposalEmailHtml = (params: {
  title: string;
  message: string;
  proposalUrl: string;
  trackingOpenUrl: string;
  trackingClickUrl: string;
  proposalReference: string;
  vendorResponseTrackingClickUrl: string;
}): string => `
  <div style="font-family:Inter,Arial,sans-serif;max-width:620px;margin:0 auto;padding:24px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
    <p style="margin:0 0 8px;color:#0f172a;font-size:14px;">You have received a proposal from DXG.</p>
    <h2 style="margin:0 0 8px;color:#0f172a;font-size:22px;">${escapeHtml(params.title)}</h2>
    <p style="margin:0 0 14px;color:#64748b;font-size:12px;">Reference: ${escapeHtml(params.proposalReference)}</p>
    <div style="margin:0 0 20px;color:#334155;font-size:14px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(params.message)}</div>
    <div style="margin:0 0 18px;padding:14px;border-radius:10px;background:#ffffff;border:1px solid #dbeafe;">
      <p style="margin:0 0 4px;color:#0f172a;font-size:13px;font-weight:700;">Proposal Preview</p>
      <p style="margin:0;color:#475569;font-size:12px;">${escapeHtml(params.title)}</p>
    </div>
    <a href="${params.trackingClickUrl}" style="display:inline-block;background:#06b6d4;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">
      View Proposal
    </a>
    <div style="margin:24px 0 0;padding-top:20px;border-top:1px solid #e2e8f0;">
      <p style="margin:0 0 10px;color:#334155;font-size:13px;font-weight:600;">Ready to respond to this proposal?</p>
      <a href="${params.vendorResponseTrackingClickUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">
        Submit Your Proposal
      </a>
    </div>
    <p style="margin:16px 0 0;color:#64748b;font-size:12px;">
      If the button does not work, copy this link:
      <a href="${params.proposalUrl}" style="color:#0284c7;text-decoration:underline;">${params.proposalUrl}</a>
    </p>
    <img src="${params.trackingOpenUrl}" alt="" width="1" height="1" style="display:block;opacity:0;" />
  </div>
`;

const cleanEmailList = (emails: unknown): string[] => {
  if (!Array.isArray(emails)) return [];

  const normalized = emails
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter((email) => EMAIL_REGEX.test(email));

  return [...new Set(normalized)];
};

export const sendProposalEmailCampaign = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const { proposalId, recipientEmails, subject, message } = req.body as {
      proposalId?: string;
      recipientEmails?: unknown;
      subject?: string;
      message?: string;
    };

    const result = await sendOwnedEmailCampaign({
      ownerUserId: userId,
      proposalId,
      recipientEmails,
      subject,
      message,
    });
    if (result.kind === "proposal_id_required") {
      res.status(400).json({
        success: false,
        message: "Proposal id is required.",
      });
      return;
    }
    if (result.kind === "recipients_required") {
      res.status(400).json({
        success: false,
        message: "At least one valid recipient email is required.",
      });
      return;
    }
    if (result.kind === "proposal_not_found") {
      res.status(404).json({
        success: false,
        message: "Proposal not found.",
      });
      return;
    }
    if (result.kind === "all_failed") {
      res.status(502).json({
        success: false,
        message:
          "Email campaign created, but delivery failed for all recipients. Check SMTP configuration.",
        data: result.campaign,
        sentCount: result.sentCount,
        failedCount: result.failedCount,
        failedRecipients: result.failedRecipients,
      });
      return;
    }

    const partialDeliveryNote =
      result.failedCount > 0
        ? ` Partial delivery: ${result.failedCount} failed.`
        : "";

    res.status(201).json({
      success: true,
      message: `Email campaign processed. ${result.sentCount}/${result.totalRecipients} emails sent.${partialDeliveryNote}`,
      data: result.campaign,
      sentCount: result.sentCount,
      failedCount: result.failedCount,
      failedRecipients: result.failedRecipients,
    });
  } catch (error) {
    console.error("Send proposal email campaign error:", error);
    res.status(500).json({
      success: false,
      message: "Error sending proposal emails",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getEmailCampaigns = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const { proposalId, page, limit } = req.query;
    const result = await listOwnedEmailCampaigns({
      ownerUserId: userId,
      query: {
        proposalId: typeof proposalId === "string" ? proposalId : undefined,
        page: typeof page === "string" ? page : undefined,
        limit: typeof limit === "string" ? limit : undefined,
      },
    });

    res.status(200).json({
      success: true,
      message: "Email campaigns fetched successfully",
      data: result.campaigns,
      pagination: result.pagination,
    });
  } catch (error) {
    console.error("Get email campaigns error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching email campaigns",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const deleteEmailCampaignsByProposal = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const { proposalId } = req.params;
    if (!proposalId || !mongoose.isValidObjectId(proposalId)) {
      res.status(400).json({
        success: false,
        message: "Valid proposal id is required.",
      });
      return;
    }

    const result = await deleteOwnedEmailCampaignsByProposal({
      ownerUserId: userId,
      proposalId,
    });

    if (result.kind === "not_found") {
      res.status(404).json({
        success: false,
        message: "No email campaign found for this proposal.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: `Deleted ${result.deletedCount} email campaign(s).`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("Delete email campaigns error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting email campaigns",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const deleteEmailCampaignById = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const { campaignId } = req.params;
    if (!campaignId || !mongoose.isValidObjectId(campaignId)) {
      res.status(400).json({
        success: false,
        message: "Valid campaign id is required.",
      });
      return;
    }

    const result = await deleteOwnedEmailCampaignById({
      campaignId,
      ownerUserId: userId,
    });

    if (result.kind === "not_found") {
      res.status(404).json({
        success: false,
        message: "Email campaign not found.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Email campaign deleted successfully.",
      data: { campaignId: result.campaignId },
    });
  } catch (error) {
    console.error("Delete email campaign by id error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting email campaign",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getEmailStats = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }
    if (!mongoose.isValidObjectId(userId)) {
      res.status(400).json({ success: false, message: "Invalid user id." });
      return;
    }

    const { proposalId } = req.query;
    if (proposalId && typeof proposalId === "string") {
      if (!mongoose.isValidObjectId(proposalId)) {
        res.status(400).json({
          success: false,
          message: "Invalid proposal id.",
        });
        return;
      }
    }
    const data = await getOwnedEmailStats({
      ownerUserId: userId,
      proposalId: typeof proposalId === "string" ? proposalId : undefined,
    });

    res.status(200).json({
      success: true,
      message: "Email stats fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Get email stats error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching email stats",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const markEmailOpened = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { trackingId } = req.params;
    if (!trackingId) {
      res.status(400).end();
      return;
    }

    await trackEmailOpen(trackingId);

    const transparentGif = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      "base64",
    );

    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Content-Length", transparentGif.length);
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, private",
    );
    res.status(200).send(transparentGif);
  } catch (error) {
    console.error("Mark email opened error:", error);
    res.status(200).end();
  }
};

export const markEmailClicked = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { trackingId } = req.params;
    const redirectParam =
      typeof req.query.redirect === "string" ? req.query.redirect : "";

    const redirectUrl = await trackProposalClick({
      trackingId,
      fallbackRedirect: redirectParam,
    });

    res.redirect(302, redirectUrl);
  } catch (error) {
    console.error("Mark email clicked error:", error);
    res.redirect(302, getFrontendBaseUrl());
  }
};

export const markVendorResponseClicked = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { trackingId } = req.params;
    const redirectParam =
      typeof req.query.redirect === "string" ? req.query.redirect : "";

    const redirectUrl = await trackVendorResponseClick({
      trackingId,
      fallbackRedirect: redirectParam,
    });

    res.redirect(302, redirectUrl);
  } catch (error) {
    console.error("Mark vendor response clicked error:", error);
    res.redirect(302, getFrontendBaseUrl());
  }
};
