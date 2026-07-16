import { Request, Response } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../middleware/auth";
import {
  checkVendorResponse,
  getOwnedVendorResponse,
  listOwnedVendorResponses,
  submitPublicVendorResponse,
} from "../src/modules/vendorResponses/composition";

export const checkVendorResponseExists = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { proposalId, email, emailTrackingId } = req.query as {
      proposalId?: string;
      email?: string;
      emailTrackingId?: string;
    };

    if (
      !emailTrackingId?.trim() &&
      (!proposalId || !mongoose.isValidObjectId(proposalId) || !email?.trim())
    ) {
      res.status(200).json({ alreadySubmitted: false, existingResponse: null });
      return;
    }
    const result = await checkVendorResponse({
      proposalId,
      email,
      trackingId: emailTrackingId,
    });
    res.status(200).json(result);
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

    const rawFiles = (req as Request & {
      files?: { documents?: Array<{ originalname: string; path: string }> };
    }).files?.documents;
    const result = await submitPublicVendorResponse({
      proposalId,
      vendorName,
      submittedBy,
      email,
      message,
      trackingId: emailTrackingId,
      files: Array.isArray(rawFiles)
        ? rawFiles.map(({ originalname, path }) => ({ originalname, path }))
        : [],
    });
    if (result.kind === "proposal_not_found") {
      res.status(404).json({ success: false, message: "Proposal not found." });
      return;
    }
    if (result.kind === "invalid") {
      const labels = {
        vendorName: "Vendor name",
        submittedBy: "Submitted by",
        email: "Email",
      };
      res.status(400).json({
        success: false,
        message: `${labels[result.field]} is required.`,
      });
      return;
    }
    const isUpdate = result.kind === "updated";
    res.status(isUpdate ? 200 : 201).json({
      success: true,
      isUpdate,
      message: isUpdate
        ? "Your response has been updated successfully."
        : "Your response has been submitted successfully.",
      data: result.response,
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

    const { page, limit, unreadOnly, proposalId, campaignId } = req.query;
    const result = await listOwnedVendorResponses({
      ownerUserId: userId,
      query: {
        page: typeof page === "string" ? page : undefined,
        limit: typeof limit === "string" ? limit : undefined,
        unreadOnly: typeof unreadOnly === "string" ? unreadOnly : undefined,
        proposalId:
          typeof proposalId === "string" && mongoose.isValidObjectId(proposalId)
            ? proposalId
            : undefined,
        campaignId:
          typeof campaignId === "string" && mongoose.isValidObjectId(campaignId)
            ? campaignId
            : undefined,
      },
    });

    res.status(200).json({
      success: true,
      data: result.responses,
      pagination: result.pagination,
      unreadCount: result.unreadCount,
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

    const result = await getOwnedVendorResponse({
      responseId: id,
      ownerUserId: userId,
    });

    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Vendor response not found" });
      return;
    }

    res.status(200).json({ success: true, data: result.response });
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

    const result = await getOwnedVendorResponse({
      responseId: id,
      ownerUserId: userId,
    });

    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Vendor response not found" });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Marked as read",
      data: result.response,
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
