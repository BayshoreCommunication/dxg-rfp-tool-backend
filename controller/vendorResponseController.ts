import type { Request, Response } from "express";
import mongoose from "mongoose";
import type { AuthRequest } from "../middleware/auth";
import {
  checkVendorResponse,
  getVendorSubmissionReceipt,
  getOwnedVendorSubmissionDetail,
  getOwnedVendorResponse,
  listOwnedVendorResponseProposals,
  listOwnedVendorResponses,
  recordManualVendorResponse,
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

type VendorSubmissionOutcome = Awaited<
  ReturnType<typeof submitPublicVendorResponse>
>;

/* The same outcome is reported to two very different audiences: the vendor who
   filled in the public portal, and the planner who typed the response in for
   them. Only the wording differs. */
type SubmissionCopy = {
  created: string;
  updated: (versionNumber: number) => string;
  replay: string;
};

const vendorSubmissionCopy: SubmissionCopy = {
  created: "Your response has been submitted successfully.",
  updated: (versionNumber) =>
    `Version ${versionNumber} of your response has been received.`,
  replay:
    "This submission was already received. Your original receipt is shown below.",
};

const plannerSubmissionCopy: SubmissionCopy = {
  created: "The vendor response was recorded.",
  updated: (versionNumber) =>
    `Version ${versionNumber} was recorded for this vendor.`,
  replay:
    "This response was already recorded, so the existing version is unchanged.",
};

const missingSubmissionField = (input: {
  vendorName?: string;
  submittedBy?: string;
  email?: string;
}): string | null => {
  if (!input.vendorName?.trim()) return "Vendor name is required.";
  if (!input.submittedBy?.trim()) return "Submitted by is required.";
  if (!input.email?.trim()) return "Email is required.";
  return null;
};

const uploadedVendorDocuments = (req: Request) => {
  const rawFiles = (
    req as Request & {
      files?: {
        documents?: Array<{
          originalname: string;
          path: string;
          mimetype?: string;
          size?: number;
        }>;
      };
    }
  ).files?.documents;
  return Array.isArray(rawFiles)
    ? rawFiles.map(({ originalname, path, mimetype, size }) => ({
        originalname,
        path,
        mimetype,
        size,
      }))
    : [];
};

const sendSubmissionOutcome = (
  res: Response,
  result: VendorSubmissionOutcome,
  copy: SubmissionCopy,
): void => {
  if (result.kind === "proposal_not_found") {
    res.status(404).json({ success: false, message: "Proposal not found." });
    return;
  }
  if (result.kind === "forbidden") {
    res.status(403).json({
      success: false,
      message: "You don't have access to this proposal.",
    });
    return;
  }
  if (result.kind === "infected") {
    res.status(422).json({
      success: false,
      message:
        "One or more uploaded files failed the malware scan and the submission was rejected.",
    });
    return;
  }
  // Fail-closed: the scan could not be performed, so the files are refused
  // rather than stored unscanned. 503 (not 422) because the submission is
  // valid and retrying once the scanner is healthy is the correct action.
  if (result.kind === "scan_unavailable") {
    res.status(503).json({
      success: false,
      message:
        "Uploads cannot be virus-scanned right now, so the submission was not accepted. Please try again shortly.",
    });
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
  const isUpdate = result.submission.versionNumber > 1;
  const isReplay = result.kind === "duplicate";
  res.status(isReplay ? 200 : 201).json({
    success: true,
    isUpdate,
    isReplay,
    message: isReplay
      ? copy.replay
      : isUpdate
        ? copy.updated(result.submission.versionNumber)
        : copy.created,
    data: result.response,
    submission: {
      submissionId: result.submission.submissionId,
      versionId: result.submission.versionId,
      versionNumber: result.submission.versionNumber,
      parentVersionId: result.submission.parentVersionId,
      reason: result.submission.reason,
      receivedAt: result.submission.receivedAt,
      manifestChecksum: result.submission.manifestChecksum,
      sourceRegistration: result.sourceRegistration,
    },
  });
};

export const submitVendorResponse = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const {
      proposalId,
      vendorName,
      submittedBy,
      email,
      message,
      emailTrackingId,
      submissionIdempotencyKey,
      submissionReason,
    } = req.body as {
      proposalId?: string;
      vendorName?: string;
      submittedBy?: string;
      email?: string;
      message?: string;
      emailTrackingId?: string;
      submissionIdempotencyKey?: string;
      submissionReason?: string;
    };

    if (!proposalId || !mongoose.isValidObjectId(proposalId)) {
      res
        .status(400)
        .json({ success: false, message: "Valid proposal id is required." });
      return;
    }
    const missingField = missingSubmissionField({
      vendorName,
      submittedBy,
      email,
    });
    if (missingField) {
      res.status(400).json({ success: false, message: missingField });
      return;
    }

    const result = await submitPublicVendorResponse({
      proposalId,
      vendorName,
      submittedBy,
      email,
      message,
      trackingId: emailTrackingId,
      idempotencyKey:
        submissionIdempotencyKey || req.headers["idempotency-key"],
      reason: submissionReason,
      files: uploadedVendorDocuments(req),
    });
    sendSubmissionOutcome(res, result, vendorSubmissionCopy);
  } catch (error) {
    console.error("Submit vendor response error:", error);
    res.status(500).json({
      success: false,
      message: "Error submitting vendor response",
    });
  }
};

/* Planner records a response a vendor sent outside the portal (email, courier,
   in person). It joins the same submission/version chain the portal writes, so
   a vendor that later submits online continues from this version. */
export const recordVendorResponseOnBehalf = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res
        .status(401)
        .json({ success: false, message: "Authentication required" });
      return;
    }
    const {
      proposalId,
      vendorName,
      submittedBy,
      email,
      message,
      submissionIdempotencyKey,
      submissionReason,
    } = req.body as {
      proposalId?: string;
      vendorName?: string;
      submittedBy?: string;
      email?: string;
      message?: string;
      submissionIdempotencyKey?: string;
      submissionReason?: string;
    };

    if (!proposalId || !mongoose.isValidObjectId(proposalId)) {
      res
        .status(400)
        .json({ success: false, message: "Valid proposal id is required." });
      return;
    }
    const missingField = missingSubmissionField({
      vendorName,
      submittedBy,
      email,
    });
    if (missingField) {
      res.status(400).json({ success: false, message: missingField });
      return;
    }

    const result = await recordManualVendorResponse({
      proposalId,
      vendorName,
      submittedBy,
      email,
      message,
      idempotencyKey:
        submissionIdempotencyKey || req.headers["idempotency-key"],
      reason: submissionReason,
      recordedByUserId: userId,
      files: uploadedVendorDocuments(req),
    });
    sendSubmissionOutcome(res, result, plannerSubmissionCopy);
  } catch (error) {
    console.error("Record vendor response error:", error);
    res.status(500).json({
      success: false,
      message: "Error recording vendor response",
    });
  }
};

export const getVendorResponseReceipt = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const proposalId =
      typeof req.query.proposalId === "string" ? req.query.proposalId : "";
    const email =
      typeof req.query.email === "string"
        ? req.query.email.trim().toLowerCase()
        : "";
    const versionId = req.params.versionId;
    if (
      !mongoose.isValidObjectId(proposalId) ||
      !mongoose.isValidObjectId(versionId) ||
      !email
    ) {
      res
        .status(400)
        .json({
          success: false,
          message: "A valid proposal, receipt, and vendor email are required.",
        });
      return;
    }
    const receipt = await getVendorSubmissionReceipt({
      proposalId,
      versionId,
      email,
    });
    if (!receipt) {
      res
        .status(404)
        .json({ success: false, message: "Submission receipt not found." });
      return;
    }
    res.status(200).json({
      success: true,
      data: {
        submissionId: receipt.submissionId,
        versionId: receipt.versionId,
        versionNumber: receipt.versionNumber,
        parentVersionId: receipt.parentVersionId,
        reason: receipt.reason,
        receivedAt: receipt.receivedAt,
        manifestChecksum: receipt.manifestChecksum,
        proposalId: receipt.proposalId,
        proposalTitle: receipt.proposalTitle,
        vendorName: receipt.vendorName,
        submittedBy: receipt.submittedBy,
        email: receipt.email,
        documents: receipt.documents.map((document) => ({
          documentId: document.documentId,
          name: document.name,
          sizeBytes: document.sizeBytes,
          sha256: document.sha256,
          scanStatus: document.scanStatus,
        })),
      },
    });
  } catch {
    res
      .status(500)
      .json({
        success: false,
        message: "Submission receipt is temporarily unavailable.",
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
      res
        .status(401)
        .json({ success: false, message: "Authentication required" });
      return;
    }

    const { page, limit, unreadOnly, proposalId, campaignId } = req.query;
    if (
      (typeof proposalId === "string" && !mongoose.isValidObjectId(proposalId)) ||
      (typeof campaignId === "string" && !mongoose.isValidObjectId(campaignId))
    ) {
      res.status(400).json({
        success: false,
        message: "Invalid vendor response filter",
      });
      return;
    }
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
      filteredUnreadCount: result.filteredUnreadCount,
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

export const getVendorResponseProposals = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res
        .status(401)
        .json({ success: false, message: "Authentication required" });
      return;
    }

    const { page, limit, search } = req.query;
    const result = await listOwnedVendorResponseProposals({
      ownerUserId: userId,
      query: {
        page: typeof page === "string" ? page : undefined,
        limit: typeof limit === "string" ? limit : undefined,
        search: typeof search === "string" ? search : undefined,
      },
    });
    res.status(200).json({
      success: true,
      data: result.proposals,
      pagination: result.pagination,
      responseCount: result.responseCount,
      unreadCount: result.unreadCount,
    });
  } catch (error) {
    console.error("Get vendor response proposals error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching vendor response proposals",
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
      res
        .status(401)
        .json({ success: false, message: "Authentication required" });
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
      res
        .status(404)
        .json({ success: false, message: "Vendor response not found" });
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

export const getVendorSubmissionDetail = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res
        .status(401)
        .json({ success: false, message: "Authentication required" });
      return;
    }
    const result = await getOwnedVendorSubmissionDetail({
      responseId: req.params.id,
      ownerUserId: userId,
    });
    if (result.kind === "not_found") {
      res
        .status(404)
        .json({ success: false, message: "Vendor response not found" });
      return;
    }
    res.status(200).json({ success: true, data: result.detail });
  } catch (error) {
    console.error("Get vendor submission detail error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching vendor submission detail",
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
      res
        .status(401)
        .json({ success: false, message: "Authentication required" });
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
      res
        .status(404)
        .json({ success: false, message: "Vendor response not found" });
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
