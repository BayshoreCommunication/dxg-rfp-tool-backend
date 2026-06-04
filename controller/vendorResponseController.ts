import fs from "fs";
import { Request, Response } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../middleware/auth";
import EmailCampaign from "../modal/emailModel";
import Proposal from "../modal/proposalsModel";
import VendorResponse from "../modal/vendorResponseModel";
import { uploadToSpaces } from "../utils/uploadToSpaces";
import { createNotification } from "../utils/notificationService";
import { sendCustomEmail } from "../utils/emailService";

const VENDOR_RESPONSE_SELECT =
  "_id proposalId proposalOwnerId proposalTitle vendorName submittedBy email message documents isRead createdAt updatedAt";

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const buildVendorConfirmationHtml = (params: {
  vendorName: string;
  submittedBy: string;
  proposalTitle: string;
  isUpdate: boolean;
}): string => `
  <div style="font-family:Inter,Arial,sans-serif;max-width:580px;margin:0 auto;padding:24px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
    <div style="text-align:center;margin-bottom:20px;">
      <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;background:#d1fae5;border-radius:50%;">
        <span style="font-size:28px;line-height:1;">&#10003;</span>
      </div>
      <h2 style="margin:12px 0 0;color:#0f172a;font-size:20px;">
        Response ${params.isUpdate ? "Updated" : "Submitted"} Successfully
      </h2>
    </div>
    <p style="color:#334155;font-size:14px;margin:0 0 12px;">
      Hi <strong>${escapeHtml(params.vendorName)}</strong>,
    </p>
    <p style="color:#334155;font-size:14px;margin:0 0 16px;">
      Your proposal response for <strong>&ldquo;${escapeHtml(params.proposalTitle)}&rdquo;</strong> has been
      ${params.isUpdate ? "updated" : "received"} successfully.
    </p>
    <div style="margin:0 0 18px;padding:14px;background:#ffffff;border:1px solid #dbeafe;border-radius:10px;">
      <p style="margin:0 0 6px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;">Submission Details</p>
      <p style="margin:0 0 4px;color:#0f172a;font-size:13px;"><strong>Submitted by:</strong> ${escapeHtml(params.submittedBy)}</p>
      <p style="margin:0;color:#0f172a;font-size:13px;"><strong>For proposal:</strong> ${escapeHtml(params.proposalTitle)}</p>
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

const sendVendorConfirmation = async (params: {
  email: string;
  vendorName: string;
  submittedBy: string;
  proposalTitle: string;
  isUpdate: boolean;
}): Promise<void> => {
  const action = params.isUpdate ? "updated" : "submitted";
  console.log(`[VendorConfirmation] Sending ${action} confirmation to: ${params.email}`);
  try {
    await sendCustomEmail({
      to: params.email,
      subject: `Your response has been ${action} — ${params.proposalTitle}`,
      html: buildVendorConfirmationHtml(params),
      text: `Hi ${params.vendorName},\n\nYour proposal response for "${params.proposalTitle}" has been ${action} successfully.\n\nSubmitted by: ${params.submittedBy}\n\nThe event planner will review your response and reach out if they are interested.\n\nDXG RFP Tool`,
    });
    console.log(`[VendorConfirmation] Confirmation email delivered to: ${params.email}`);
  } catch (err) {
    console.error(`[VendorConfirmation] Failed to send confirmation to ${params.email}:`, err);
  }
};

export const checkVendorResponseExists = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { proposalId, email } = req.query as {
      proposalId?: string;
      email?: string;
    };
    if (!proposalId || !mongoose.isValidObjectId(proposalId) || !email?.trim()) {
      res.status(200).json({ alreadySubmitted: false, existingResponse: null });
      return;
    }
    const existing = await VendorResponse.findOne({
      proposalId: new mongoose.Types.ObjectId(proposalId),
      email: email.trim().toLowerCase(),
    })
      .select("_id vendorName submittedBy email message documents createdAt updatedAt")
      .lean();

    res.status(200).json({
      alreadySubmitted: !!existing,
      existingResponse: existing ?? null,
    });
  } catch {
    res.status(200).json({ alreadySubmitted: false, existingResponse: null });
  }
};

export const submitVendorResponse = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { proposalId, vendorName, submittedBy, email, message, emailTrackingId } = req.body as {
      proposalId?: string;
      vendorName?: string;
      submittedBy?: string;
      email?: string;
      message?: string;
      emailTrackingId?: string;
    };

    if (!proposalId || !mongoose.isValidObjectId(proposalId)) {
      res.status(400).json({ success: false, message: "Valid proposal id is required." });
      return;
    }
    if (!vendorName?.trim()) {
      res.status(400).json({ success: false, message: "Vendor name is required." });
      return;
    }
    if (!submittedBy?.trim()) {
      res.status(400).json({ success: false, message: "Submitted by is required." });
      return;
    }
    if (!email?.trim()) {
      res.status(400).json({ success: false, message: "Email is required." });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedTid = emailTrackingId?.trim() || null;

    // Upload any new documents first
    const newDocs: { name: string; url: string }[] = [];
    const files = (req as any).files?.documents;
    if (Array.isArray(files)) {
      for (const file of files) {
        try {
          const folder = process.env.DO_FOLDER_NAME || "rfp-tool";
          const objectKey = `${folder}/vendor-responses/${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`;
          const url = await uploadToSpaces(file.path, objectKey);
          newDocs.push({ name: file.originalname, url });
        } catch {
          try { fs.unlinkSync(file.path); } catch { /* ignore */ }
        }
      }
    }

    // Check for existing response by email+proposalId or trackingId
    const orConditions: Record<string, unknown>[] = [
      { proposalId: new mongoose.Types.ObjectId(proposalId), email: normalizedEmail },
    ];
    if (normalizedTid) orConditions.push({ emailTrackingId: normalizedTid });

    const existing = await VendorResponse.findOne({ $or: orConditions });

    if (existing) {
      // Update existing response — append new docs, update text fields
      existing.vendorName = vendorName.trim();
      existing.submittedBy = submittedBy.trim();
      existing.message = message?.trim() || "";
      if (newDocs.length > 0) {
        existing.documents.push(...newDocs);
      }
      // Move the response to the new campaign's tracking ID so that the
      // latest send is credited — not the original campaign.
      if (normalizedTid && existing.emailTrackingId !== normalizedTid) {
        existing.emailTrackingId = normalizedTid;
      }
      await existing.save();

      // Send update confirmation (non-blocking)
      void sendVendorConfirmation({
        email: normalizedEmail,
        vendorName: vendorName.trim(),
        submittedBy: submittedBy.trim(),
        proposalTitle: existing.proposalTitle || "Untitled Proposal",
        isUpdate: true,
      });

      res.status(200).json({
        success: true,
        isUpdate: true,
        message: "Your response has been updated successfully.",
        data: existing,
      });
      return;
    }

    // New submission
    const proposal = await Proposal.findById(proposalId).select("_id userId event");
    if (!proposal) {
      res.status(404).json({ success: false, message: "Proposal not found." });
      return;
    }

    const proposalTitle = proposal.event?.eventName?.trim() || "Untitled Proposal";
    const proposalOwnerId = proposal.userId;

    const vendorResponse = await VendorResponse.create({
      proposalId: proposal._id,
      proposalOwnerId,
      proposalTitle,
      vendorName: vendorName.trim(),
      submittedBy: submittedBy.trim(),
      email: normalizedEmail,
      message: message?.trim() || "",
      documents: newDocs,
      ...(normalizedTid ? { emailTrackingId: normalizedTid } : {}),
    });

    await createNotification({
      userId: String(proposalOwnerId),
      proposalId: String(proposal._id),
      type: "vendor_response",
      title: "New Vendor Response",
      message: `${vendorName.trim()} submitted a response for "${proposalTitle}".`,
      metadata: {
        vendorResponseId: String(vendorResponse._id),
        vendorName: vendorName.trim(),
        submittedBy: submittedBy.trim(),
        email: normalizedEmail,
      },
    });

    // Send submission confirmation (non-blocking)
    void sendVendorConfirmation({
      email: normalizedEmail,
      vendorName: vendorName.trim(),
      submittedBy: submittedBy.trim(),
      proposalTitle,
      isUpdate: false,
    });

    res.status(201).json({
      success: true,
      isUpdate: false,
      message: "Your response has been submitted successfully.",
      data: vendorResponse,
    });
  } catch (error) {
    console.error("Submit vendor response error:", error);
    res.status(500).json({
      success: false,
      message: "Error submitting vendor response",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getVendorResponses = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const { page = "1", limit = "20", unreadOnly = "false", proposalId, campaignId } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const filter: Record<string, unknown> = { proposalOwnerId: new mongoose.Types.ObjectId(userId) };
    if (unreadOnly === "true") filter.isRead = false;

    if (campaignId && mongoose.isValidObjectId(campaignId as string)) {
      // Filter to only responses that came through this specific campaign's tracking links
      const campaign = await EmailCampaign.findOne({
        _id: new mongoose.Types.ObjectId(campaignId as string),
        userId: new mongoose.Types.ObjectId(userId),
      }).select("recipients.trackingId").lean();

      const trackingIds = (campaign?.recipients ?? [])
        .map((r) => r.trackingId)
        .filter(Boolean);

      // No tracking IDs means no responses can belong to this campaign — return empty immediately
      if (trackingIds.length === 0) {
        res.status(200).json({
          success: true,
          data: [],
          pagination: { total: 0, page: pageNum, limit: limitNum, totalPages: 0 },
          unreadCount: 0,
        });
        return;
      }

      filter.emailTrackingId = { $in: trackingIds };
    } else if (proposalId && mongoose.isValidObjectId(proposalId as string)) {
      filter.proposalId = new mongoose.Types.ObjectId(proposalId as string);
    }

    const [responses, total, unreadCount] = await Promise.all([
      VendorResponse.find(filter)
        .select(VENDOR_RESPONSE_SELECT)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      VendorResponse.countDocuments(filter),
      VendorResponse.countDocuments({ proposalOwnerId: new mongoose.Types.ObjectId(userId), isRead: false }),
    ]);

    res.status(200).json({
      success: true,
      data: responses,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
      unreadCount,
    });
  } catch (error) {
    console.error("Get vendor responses error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching vendor responses",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getVendorResponseById = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ success: false, message: "Invalid response id" });
      return;
    }

    const response = await VendorResponse.findOneAndUpdate(
      { _id: id, proposalOwnerId: new mongoose.Types.ObjectId(userId) },
      { isRead: true },
      { new: true },
    )
      .select(VENDOR_RESPONSE_SELECT)
      .lean();

    if (!response) {
      res.status(404).json({ success: false, message: "Vendor response not found" });
      return;
    }

    res.status(200).json({ success: true, data: response });
  } catch (error) {
    console.error("Get vendor response by id error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching vendor response",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const markVendorResponseRead = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ success: false, message: "Invalid response id" });
      return;
    }

    const response = await VendorResponse.findOneAndUpdate(
      { _id: id, proposalOwnerId: new mongoose.Types.ObjectId(userId) },
      { isRead: true },
      { new: true },
    )
      .select(VENDOR_RESPONSE_SELECT)
      .lean();

    if (!response) {
      res.status(404).json({ success: false, message: "Vendor response not found" });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Marked as read",
      data: response,
    });
  } catch (error) {
    console.error("Mark vendor response read error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating vendor response",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
