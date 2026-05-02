"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.markEmailClicked = exports.markEmailOpened = exports.getEmailStats = exports.deleteEmailCampaignById = exports.deleteEmailCampaignsByProposal = exports.getEmailCampaigns = exports.sendProposalEmailCampaign = void 0;
const crypto_1 = __importDefault(require("crypto"));
const mongoose_1 = __importDefault(require("mongoose"));
const emailModel_1 = __importDefault(require("../modal/emailModel"));
const proposalsModel_1 = __importDefault(require("../modal/proposalsModel"));
const emailService_1 = require("../utils/emailService");
const EMAIL_REGEX = /^\S+@\S+\.\S+$/;
const toSlug = (value) => value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
const firstUrlFromEnv = (value) => value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)[0] || value.trim();
// These are the live production URLs. They are used as the final fallback so that
// email links are never broken even when env vars are absent on the host (e.g. Vercel).
const PRODUCTION_BACKEND_URL = "https://dxg-rfp-tool-backend.vercel.app";
const PRODUCTION_FRONTEND_URL = "https://dxg-rfp-tool-dashboard.vercel.app";
// PUBLIC_API_URL must be the externally reachable backend URL.
// Never use BACKEND_URL or a localhost address in email links — they are unreachable by recipients.
const getApiBaseUrl = () => firstUrlFromEnv(process.env.PUBLIC_API_URL || PRODUCTION_BACKEND_URL).replace(/\/+$/, "");
const getFrontendBaseUrl = () => firstUrlFromEnv(process.env.PUBLIC_FRONTEND_URL ||
    process.env.FRONTEND_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_FRONTEND_URL ||
    PRODUCTION_FRONTEND_URL).replace(/\/+$/, "");
const buildProposalPublicUrl = (proposalSlug) => `${getFrontendBaseUrl()}/proposal/${proposalSlug}?source=email`;
const buildTrackingOpenUrl = (trackingId) => `${getApiBaseUrl()}/api/emails/open/${trackingId}`;
const buildTrackingClickUrl = (trackingId, redirectUrl) => `${getApiBaseUrl()}/api/emails/click/${trackingId}?redirect=${encodeURIComponent(redirectUrl)}`;
const escapeHtml = (value) => value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const cleanEmailMessage = (message) => message
    .split("\n")
    .filter((line) => !/proposal link\s*:/i.test(line))
    .join("\n")
    .trim();
const buildProposalEmailHtml = (params) => `
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
    <p style="margin:16px 0 0;color:#64748b;font-size:12px;">
      If the button does not work, copy this link:
      <a href="${params.proposalUrl}" style="color:#0284c7;text-decoration:underline;">${params.proposalUrl}</a>
    </p>
    <img src="${params.trackingOpenUrl}" alt="" width="1" height="1" style="display:block;opacity:0;" />
  </div>
`;
const cleanEmailList = (emails) => {
    if (!Array.isArray(emails))
        return [];
    const normalized = emails
        .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
        .filter((email) => EMAIL_REGEX.test(email));
    return [...new Set(normalized)];
};
const sendProposalEmailCampaign = async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            res.status(401).json({ success: false, message: "Unauthorized" });
            return;
        }
        const { proposalId, recipientEmails, subject, message } = req.body;
        if (!proposalId) {
            res.status(400).json({
                success: false,
                message: "Proposal id is required.",
            });
            return;
        }
        const recipients = cleanEmailList(recipientEmails);
        if (recipients.length === 0) {
            res.status(400).json({
                success: false,
                message: "At least one valid recipient email is required.",
            });
            return;
        }
        const proposal = await proposalsModel_1.default.findOne({
            _id: proposalId,
            userId,
        }).select("_id event contact");
        if (!proposal) {
            res.status(404).json({
                success: false,
                message: "Proposal not found.",
            });
            return;
        }
        const proposalTitle = proposal.event?.eventName?.trim() || "Untitled Proposal";
        const proposalSlug = `${toSlug(proposalTitle) || "proposal"}-${proposal._id}`;
        const proposalUrl = buildProposalPublicUrl(proposalSlug);
        const finalSubject = subject?.trim() || `Proposal for ${proposalTitle} - DXG RFP Tool`;
        const defaultMessage = `Hi,

Please review the proposal and let us know your feedback.

Best regards,
DXG Team`;
        const finalMessage = cleanEmailMessage(message?.trim() || defaultMessage);
        const proposalReference = `#${String(proposal._id).slice(-8).toUpperCase()}`;
        const recipientDocs = recipients.map((email) => ({
            email,
            trackingId: crypto_1.default.randomBytes(16).toString("hex"),
            status: "failed",
        }));
        const campaign = await emailModel_1.default.create({
            userId,
            proposalId: proposal._id,
            proposalTitle,
            proposalSlug,
            subject: finalSubject,
            message: finalMessage,
            recipients: recipientDocs,
            totalRecipients: recipientDocs.length,
            sentCount: 0,
            openedCount: 0,
            clickedCount: 0,
        });
        let sentCount = 0;
        for (const recipient of campaign.recipients) {
            try {
                const openUrl = buildTrackingOpenUrl(recipient.trackingId);
                const clickUrl = buildTrackingClickUrl(recipient.trackingId, proposalUrl);
                const html = buildProposalEmailHtml({
                    title: proposalTitle,
                    message: finalMessage,
                    proposalUrl,
                    trackingOpenUrl: openUrl,
                    trackingClickUrl: clickUrl,
                    proposalReference,
                });
                await (0, emailService_1.sendCustomEmail)({
                    to: recipient.email,
                    subject: finalSubject,
                    html,
                    text: `${finalMessage}\n\nView proposal: ${proposalUrl}`,
                });
                recipient.status = "sent";
                recipient.sentAt = new Date();
                recipient.errorMessage = undefined;
                sentCount += 1;
            }
            catch (error) {
                recipient.status = "failed";
                recipient.errorMessage =
                    error instanceof Error ? error.message : "Unknown send error";
            }
        }
        campaign.sentCount = sentCount;
        await campaign.save();
        const failedCount = Math.max(0, campaign.totalRecipients - sentCount);
        const failedRecipients = campaign.recipients
            .filter((entry) => entry.status === "failed")
            .map((entry) => ({
            email: entry.email,
            errorMessage: entry.errorMessage || "Unknown send error",
        }));
        if (sentCount === 0) {
            res.status(502).json({
                success: false,
                message: "Email campaign created, but delivery failed for all recipients. Check SMTP configuration.",
                data: campaign,
                sentCount,
                failedCount,
                failedRecipients,
            });
            return;
        }
        const partialDeliveryNote = failedCount > 0 ? ` Partial delivery: ${failedCount} failed.` : "";
        res.status(201).json({
            success: true,
            message: `Email campaign processed. ${sentCount}/${campaign.totalRecipients} emails sent.${partialDeliveryNote}`,
            data: campaign,
            sentCount,
            failedCount,
            failedRecipients,
        });
    }
    catch (error) {
        console.error("Send proposal email campaign error:", error);
        res.status(500).json({
            success: false,
            message: "Error sending proposal emails",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.sendProposalEmailCampaign = sendProposalEmailCampaign;
const getEmailCampaigns = async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            res.status(401).json({ success: false, message: "Unauthorized" });
            return;
        }
        const { proposalId, page = "1", limit = "20" } = req.query;
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
        const skip = (pageNum - 1) * limitNum;
        const filter = { userId };
        if (proposalId && typeof proposalId === "string") {
            filter.proposalId = proposalId;
        }
        const [campaigns, total] = await Promise.all([
            emailModel_1.default.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limitNum),
            emailModel_1.default.countDocuments(filter),
        ]);
        res.status(200).json({
            success: true,
            message: "Email campaigns fetched successfully",
            data: campaigns,
            pagination: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum),
            },
        });
    }
    catch (error) {
        console.error("Get email campaigns error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching email campaigns",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getEmailCampaigns = getEmailCampaigns;
const deleteEmailCampaignsByProposal = async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            res.status(401).json({ success: false, message: "Unauthorized" });
            return;
        }
        const { proposalId } = req.params;
        if (!proposalId || !mongoose_1.default.isValidObjectId(proposalId)) {
            res.status(400).json({
                success: false,
                message: "Valid proposal id is required.",
            });
            return;
        }
        const result = await emailModel_1.default.deleteMany({
            userId,
            proposalId: new mongoose_1.default.Types.ObjectId(proposalId),
        });
        if (!result.deletedCount) {
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
    }
    catch (error) {
        console.error("Delete email campaigns error:", error);
        res.status(500).json({
            success: false,
            message: "Error deleting email campaigns",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.deleteEmailCampaignsByProposal = deleteEmailCampaignsByProposal;
const deleteEmailCampaignById = async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            res.status(401).json({ success: false, message: "Unauthorized" });
            return;
        }
        const { campaignId } = req.params;
        if (!campaignId || !mongoose_1.default.isValidObjectId(campaignId)) {
            res.status(400).json({
                success: false,
                message: "Valid campaign id is required.",
            });
            return;
        }
        const deleted = await emailModel_1.default.findOneAndDelete({
            _id: campaignId,
            userId: new mongoose_1.default.Types.ObjectId(userId),
        });
        if (!deleted) {
            res.status(404).json({
                success: false,
                message: "Email campaign not found.",
            });
            return;
        }
        res.status(200).json({
            success: true,
            message: "Email campaign deleted successfully.",
            data: { campaignId: deleted._id },
        });
    }
    catch (error) {
        console.error("Delete email campaign by id error:", error);
        res.status(500).json({
            success: false,
            message: "Error deleting email campaign",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.deleteEmailCampaignById = deleteEmailCampaignById;
const getEmailStats = async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            res.status(401).json({ success: false, message: "Unauthorized" });
            return;
        }
        if (!mongoose_1.default.isValidObjectId(userId)) {
            res.status(400).json({ success: false, message: "Invalid user id." });
            return;
        }
        const { proposalId } = req.query;
        const matchStage = {
            userId: new mongoose_1.default.Types.ObjectId(userId),
        };
        if (proposalId && typeof proposalId === "string") {
            if (!mongoose_1.default.isValidObjectId(proposalId)) {
                res.status(400).json({
                    success: false,
                    message: "Invalid proposal id.",
                });
                return;
            }
            matchStage.proposalId = new mongoose_1.default.Types.ObjectId(proposalId);
        }
        const [summary] = await emailModel_1.default.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: null,
                    totalCampaigns: { $sum: 1 },
                    totalRecipients: { $sum: "$totalRecipients" },
                    totalSent: { $sum: "$sentCount" },
                    totalOpened: { $sum: "$openedCount" },
                    totalClicked: { $sum: "$clickedCount" },
                },
            },
        ]);
        const byProposal = await emailModel_1.default.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: "$proposalId",
                    proposalTitle: { $first: "$proposalTitle" },
                    totalSent: { $sum: "$sentCount" },
                    totalOpened: { $sum: "$openedCount" },
                    totalClicked: { $sum: "$clickedCount" },
                },
            },
            { $sort: { totalSent: -1 } },
            { $limit: 20 },
            {
                $project: {
                    _id: 0,
                    proposalId: { $toString: "$_id" },
                    proposalTitle: 1,
                    totalSent: 1,
                    totalOpened: 1,
                    totalClicked: 1,
                },
            },
        ]);
        const totals = summary || {
            totalCampaigns: 0,
            totalRecipients: 0,
            totalSent: 0,
            totalOpened: 0,
            totalClicked: 0,
        };
        const openRate = totals.totalSent > 0
            ? Number(((totals.totalOpened / totals.totalSent) * 100).toFixed(2))
            : 0;
        const clickRate = totals.totalSent > 0
            ? Number(((totals.totalClicked / totals.totalSent) * 100).toFixed(2))
            : 0;
        res.status(200).json({
            success: true,
            message: "Email stats fetched successfully",
            data: {
                ...totals,
                openRate,
                clickRate,
                totalViews: totals.totalOpened,
                byProposal,
            },
        });
    }
    catch (error) {
        console.error("Get email stats error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching email stats",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getEmailStats = getEmailStats;
const markEmailOpened = async (req, res) => {
    try {
        const { trackingId } = req.params;
        if (!trackingId) {
            res.status(400).end();
            return;
        }
        const campaign = await emailModel_1.default.findOne({
            "recipients.trackingId": trackingId,
        });
        if (campaign) {
            const recipient = campaign.recipients.find((entry) => entry.trackingId === trackingId);
            if (recipient && !recipient.openedAt) {
                recipient.openedAt = new Date();
                campaign.openedCount += 1;
                await campaign.save();
            }
        }
        const transparentGif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
        res.setHeader("Content-Type", "image/gif");
        res.setHeader("Content-Length", transparentGif.length);
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
        res.status(200).send(transparentGif);
    }
    catch (error) {
        console.error("Mark email opened error:", error);
        res.status(200).end();
    }
};
exports.markEmailOpened = markEmailOpened;
const markEmailClicked = async (req, res) => {
    try {
        const { trackingId } = req.params;
        const redirectParam = typeof req.query.redirect === "string" ? req.query.redirect : "";
        const campaign = await emailModel_1.default.findOne({
            "recipients.trackingId": trackingId,
        });
        let redirectUrl = getFrontendBaseUrl();
        if (campaign) {
            const recipient = campaign.recipients.find((entry) => entry.trackingId === trackingId);
            if (recipient && !recipient.clickedAt) {
                recipient.clickedAt = new Date();
                campaign.clickedCount += 1;
                await campaign.save();
            }
            const proposalUrl = buildProposalPublicUrl(campaign.proposalSlug);
            redirectUrl = proposalUrl;
        }
        if (!campaign && /^https?:\/\//i.test(redirectParam)) {
            redirectUrl = redirectParam;
        }
        res.redirect(302, redirectUrl);
    }
    catch (error) {
        console.error("Mark email clicked error:", error);
        res.redirect(302, getFrontendBaseUrl());
    }
};
exports.markEmailClicked = markEmailClicked;
//# sourceMappingURL=emailController.js.map