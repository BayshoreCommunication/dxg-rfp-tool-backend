import { Request, Response } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../middleware/auth";
import {
  archiveOwnedProposal,
  copyOwnedProposal,
  createOwnedProposal,
  getOwnedProposal,
  getProposalByLegacyPublicId,
  listOwnedProposals,
  incrementLegacyPublicProposalViews,
  incrementOwnedProposalViews,
  permanentlyDeleteOwnedProposal,
  restoreOwnedProposal,
  updateOwnedProposalMeta,
  updateOwnedProposalStatus,
  updateOwnedProposal,
  presignOwnedProposalFile,
  uploadOwnedProposalFiles,
} from "../src/modules/proposals/composition";
import { ProposalFileAccessError } from "../src/modules/proposals/application/proposalFileAccess";
import { PROPOSAL_STATUSES } from "../src/modules/proposals/application/mutateOwnedProposal";

const isValidProposalId = (id?: string) =>
  typeof id === "string" && mongoose.isValidObjectId(id);

export const getAllProposals = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const stringQuery = Object.fromEntries(
      Object.entries(req.query).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const result = await listOwnedProposals({
      ownerUserId: userId,
      query: stringQuery,
    });

    res.status(200).json({
      success: true,
      message: "Proposals fetched successfully",
      data: result.proposals,
      pagination: result.pagination,
      ...(result.counts ? { counts: result.counts } : {}),
    });
  } catch (error) {
    console.error("Get all proposals error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching proposals",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getProposalById = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { id } = req.params;

    if (!isValidProposalId(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid proposal id",
      });
      return;
    }

    if (!userId) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const result = await getOwnedProposal({
      proposalId: id,
      ownerUserId: userId,
    });

    if (result.kind === "not_found") {
      res.status(404).json({
        success: false,
        message: "Proposal not found",
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: result.proposal,
    });
  } catch (error) {
    console.error("Get proposal error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching proposal",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getProposalByIdPublic = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;

    if (!isValidProposalId(id)) {
      res.status(400).json({ success: false, message: "Invalid proposal id" });
      return;
    }

    const result = await getProposalByLegacyPublicId(id);

    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    res.status(200).json({
      success: true,
      data: result.proposal,
    });
  } catch (error) {
    console.error("Get proposal public error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching proposal",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const incrementProposalViewsPublic = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;

    if (!isValidProposalId(id)) {
      res.status(400).json({ success: false, message: "Invalid proposal id" });
      return;
    }

    const result = await incrementLegacyPublicProposalViews(id);

    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Proposal views incremented",
      data: result.proposal,
    });
  } catch (error) {
    console.error("Increment proposal views public error:", error);
    res.status(500).json({
      success: false,
      message: "Error incrementing proposal views",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const createProposal = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const proposal = await createOwnedProposal({
      ownerUserId: userId,
      proposal: req.body as Record<string, unknown>,
    });

    res.status(201).json({
      success: true,
      message: "Proposal created successfully",
      data: proposal,
    });
  } catch (error: any) {
    console.error("Create proposal error:", error);

    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((e: any) => e.message);
      res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: messages,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Error creating proposal",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const updateProposal = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;

    if (!isValidProposalId(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid proposal id",
      });
      return;
    }

    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const result = await updateOwnedProposal({
      proposalId: id,
      ownerUserId: userId,
      updates: req.body as Record<string, unknown>,
    });

    if (result.kind === "not_found") {
      res.status(404).json({
        success: false,
        message: "Proposal not found",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Proposal updated successfully",
      data: result.proposal,
    });
  } catch (error: any) {
    console.error("Update proposal error:", error);

    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((e: any) => e.message);
      res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: messages,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Error updating proposal",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const updateProposalStatus = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const userId = req.user?.userId;

    if (!isValidProposalId(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid proposal id",
      });
      return;
    }

    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const result = await updateOwnedProposalStatus({
      proposalId: id,
      ownerUserId: userId,
      status,
    });

    if (result.kind === "invalid_status") {
      res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${PROPOSAL_STATUSES.join(", ")}`,
      });
      return;
    }

    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    res.status(200).json({
      success: true,
      message: `Proposal status updated to "${result.status}"`,
      data: result.proposal,
    });
  } catch (error) {
    console.error("Update status error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating proposal status",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const updateProposalMeta = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    const { isActive, isFavorite, isAccepted, isOpen, viewsCount, isDraft } = req.body;

    if (!isValidProposalId(id)) {
      res.status(400).json({ success: false, message: "Invalid proposal id" });
      return;
    }

    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const result = await updateOwnedProposalMeta({
      proposalId: id,
      ownerUserId: userId,
      metadata: { isActive, isFavorite, isAccepted, isOpen, viewsCount, isDraft },
    });

    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    if (result.kind === "no_valid_fields") {
      res.status(400).json({
        success: false,
        message: result.copyRestricted
          ? "Copies cannot be favourited or toggled active. Publish the copy first."
          : "No valid fields provided.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Proposal metadata updated",
      data: result.proposal,
    });
  } catch (error) {
    console.error("Update proposal meta error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating proposal metadata",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const incrementProposalViews = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;

    if (!isValidProposalId(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid proposal id",
      });
      return;
    }

    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const result = await incrementOwnedProposalViews({
      proposalId: id,
      ownerUserId: userId,
    });

    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Proposal views incremented",
      data: result.proposal,
    });
  } catch (error) {
    console.error("Increment proposal views error:", error);
    res.status(500).json({
      success: false,
      message: "Error incrementing proposal views",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const deleteProposal = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;

    if (!isValidProposalId(id)) {
      res.status(400).json({ success: false, message: "Invalid proposal id" });
      return;
    }

    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const result = await archiveOwnedProposal({
      proposalId: id,
      ownerUserId: userId,
    });

    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Proposal archived. It will be permanently deleted after 30 days.",
    });
  } catch (error) {
    console.error("Archive proposal error:", error);
    res.status(500).json({
      success: false,
      message: "Error archiving proposal",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const restoreProposal = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;

    if (!isValidProposalId(id)) {
      res.status(400).json({ success: false, message: "Invalid proposal id" });
      return;
    }

    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const result = await restoreOwnedProposal({
      proposalId: id,
      ownerUserId: userId,
    });

    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Archived proposal not found" });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Proposal restored successfully.",
    });
  } catch (error) {
    console.error("Restore proposal error:", error);
    res.status(500).json({
      success: false,
      message: "Error restoring proposal",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const permanentlyDeleteProposal = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;

    if (!isValidProposalId(id)) {
      res.status(400).json({ success: false, message: "Invalid proposal id" });
      return;
    }

    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const result = await permanentlyDeleteOwnedProposal({
      proposalId: id,
      ownerUserId: userId,
    });

    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Archived proposal not found" });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Proposal permanently deleted.",
    });
  } catch (error) {
    console.error("Permanent delete proposal error:", error);
    res.status(500).json({
      success: false,
      message: "Error permanently deleting proposal",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const copyProposal = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    const { eventName, startDate, endDate, templateId, isDraft } = req.body as {
      eventName?: string;
      startDate?: string;
      endDate?: string;
      templateId?: "template-one" | "template-two";
      isDraft?: boolean;
    };

    if (!isValidProposalId(id)) {
      res.status(400).json({ success: false, message: "Invalid proposal id" });
      return;
    }

    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const result = await copyOwnedProposal({
      proposalId: id,
      ownerUserId: userId,
      overrides: { eventName, startDate, endDate, templateId, isDraft },
    });
    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Source proposal not found" });
      return;
    }

    res.status(201).json({
      success: true,
      message: "Proposal copied successfully",
      data: result.proposal,
    });
  } catch (error: any) {
    console.error("Copy proposal error:", error);
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((e: any) => e.message);
      res.status(400).json({ success: false, message: "Validation failed", errors: messages });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Error copying proposal",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getProposalFileUrl = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const result = await presignOwnedProposalFile({
      requesterUserId: userId,
      url: typeof req.query.url === "string" ? req.query.url : "",
    });
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ProposalFileAccessError) {
      res.status(error.status).json({ success: false, code: error.code, message: error.message });
      return;
    }
    console.error("Presign proposal file error:", error);
    res.status(500).json({ success: false, message: "Error preparing the file link" });
  }
};

export const uploadProposalFiles = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;

    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const uploadFiles = Object.values(files ?? {})
      .flat()
      .map(({ fieldname, originalname, path }) => ({
        fieldname,
        originalname,
        path,
      }));
    const result = await uploadOwnedProposalFiles({
      ownerUserId: userId,
      files: uploadFiles,
    });
    if (result.kind === "no_files") {
      res.status(400).json({ success: false, message: "No files uploaded" });
      return;
    }

    res.status(200).json({
      success: true,
      message: `${result.files.length} file(s) uploaded successfully`,
      data: result.files,
    });
  } catch (error) {
    console.error("Upload proposal files error:", error);
    const uploadError = error as { code?: string; message?: string };
    if (uploadError.code === "MALWARE_DETECTED" || uploadError.code === "MALWARE_SCAN_UNAVAILABLE") {
      res.status(422).json({
        success: false,
        code: uploadError.code,
        message: uploadError.message,
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Error uploading files",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
