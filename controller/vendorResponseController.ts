import fs from "fs";
import { Request, Response } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../middleware/auth";
import Proposal from "../modal/proposalsModel";
import VendorResponse from "../modal/vendorResponseModel";
import { uploadToSpaces } from "../utils/uploadToSpaces";
import { createNotification } from "../utils/notificationService";

const VENDOR_RESPONSE_SELECT =
  "_id proposalId proposalOwnerId proposalTitle vendorName submittedBy email message documents isRead createdAt updatedAt";

const extractProposalId = (slug: string): string | null => {
  const match = /([a-f0-9]{24})$/i.exec(slug);
  return match ? match[1] : null;
};

export const checkVendorResponseExists = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { proposalId, email } = req.query as { proposalId?: string; email?: string };
    if (!proposalId || !mongoose.isValidObjectId(proposalId) || !email?.trim()) {
      res.status(200).json({ alreadySubmitted: false });
      return;
    }
    const existing = await VendorResponse.findOne({
      proposalId: new mongoose.Types.ObjectId(proposalId),
      email: email.trim().toLowerCase(),
    })
      .select("_id")
      .lean();
    res.status(200).json({ alreadySubmitted: !!existing });
  } catch {
    res.status(200).json({ alreadySubmitted: false });
  }
};

export const submitVendorResponse = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { proposalId, vendorName, submittedBy, email, message } = req.body as {
      proposalId?: string;
      vendorName?: string;
      submittedBy?: string;
      email?: string;
      message?: string;
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

    const existing = await VendorResponse.findOne({
      proposalId: new mongoose.Types.ObjectId(proposalId),
      email: normalizedEmail,
    }).lean();

    if (existing) {
      res.status(409).json({
        success: false,
        alreadySubmitted: true,
        message: "You have already submitted a response for this proposal.",
      });
      return;
    }

    const proposal = await Proposal.findById(proposalId).select(
      "_id userId event",
    );
    if (!proposal) {
      res.status(404).json({ success: false, message: "Proposal not found." });
      return;
    }

    const proposalTitle = proposal.event?.eventName?.trim() || "Untitled Proposal";
    const proposalOwnerId = proposal.userId;

    // Upload documents to Spaces
    const uploadedDocs: { name: string; url: string }[] = [];
    const files = (req as any).files?.documents;
    if (Array.isArray(files)) {
      for (const file of files) {
        try {
          const folder = process.env.DO_FOLDER_NAME || "rfp-tool";
          const objectKey = `${folder}/vendor-responses/${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`;
          const url = await uploadToSpaces(file.path, objectKey);
          uploadedDocs.push({ name: file.originalname, url });
        } catch {
          try { fs.unlinkSync(file.path); } catch { /* ignore */ }
        }
      }
    }

    const vendorResponse = await VendorResponse.create({
      proposalId: proposal._id,
      proposalOwnerId,
      proposalTitle,
      vendorName: vendorName.trim(),
      submittedBy: submittedBy.trim(),
      email: email.trim().toLowerCase(),
      message: message?.trim() || "",
      documents: uploadedDocs,
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
        email: email.trim().toLowerCase(),
      },
    });

    res.status(201).json({
      success: true,
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

    const { page = "1", limit = "20", unreadOnly = "false", proposalId } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const filter: Record<string, unknown> = { proposalOwnerId: new mongoose.Types.ObjectId(userId) };
    if (unreadOnly === "true") filter.isRead = false;
    if (proposalId && mongoose.isValidObjectId(proposalId as string)) {
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
