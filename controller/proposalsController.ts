import { Request, Response } from "express";
import { AuthRequest } from "../middleware/auth";
import Proposal from "../modal/proposalsModel";

/* ─────────────────────────────────────────
   GET /api/proposals
   Get all proposals (with optional filters)
───────────────────────────────────────── */
export const getAllProposals = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const {
      status,
      search,
      page = "1",
      limit = "20",
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const filter: Record<string, any> = {};

    // Filter by status
    if (status && typeof status === "string") {
      filter.status = status;
    }

    // Search by event name or contact name/email
    if (search && typeof search === "string") {
      const regex = new RegExp(search, "i");
      filter.$or = [
        { eventName: regex },
        { contactFirstName: regex },
        { contactLastName: regex },
        { contactEmail: regex },
        { contactOrganization: regex },
      ];
    }

    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(100, parseInt(limit as string));
    const skip = (pageNum - 1) * limitNum;
    const sort: Record<string, 1 | -1> = {
      [sortBy as string]: sortOrder === "asc" ? 1 : -1,
    };

    const [proposals, total] = await Promise.all([
      Proposal.find(filter)
        .populate("createdBy", "name email")
        .sort(sort)
        .skip(skip)
        .limit(limitNum),
      Proposal.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      message: "Proposals fetched successfully",
      data: proposals,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
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

/* ─────────────────────────────────────────
   GET /api/proposals/:id
   Get single proposal by ID
───────────────────────────────────────── */
export const getProposalById = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;

    const proposal = await Proposal.findById(id).populate(
      "createdBy",
      "name email"
    );

    if (!proposal) {
      res.status(404).json({
        success: false,
        message: "Proposal not found",
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: proposal,
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

/* ─────────────────────────────────────────
   POST /api/proposals
   Create a new proposal
───────────────────────────────────────── */
export const createProposal = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const body = req.body;

    // Attach the authenticated user if available
    if (req.user?.userId) {
      body.createdBy = req.user.userId;
    }

    const proposal = new Proposal(body);
    await proposal.save();

    res.status(201).json({
      success: true,
      message: "Proposal created successfully",
      data: proposal,
    });
  } catch (error: any) {
    console.error("Create proposal error:", error);

    // Mongoose validation errors → readable format
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map(
        (e: any) => e.message
      );
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

/* ─────────────────────────────────────────
   PUT /api/proposals/:id
   Update an existing proposal (full or partial)
───────────────────────────────────────── */
export const updateProposal = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Prevent overwriting immutable fields
    delete updates._id;
    delete updates.createdAt;
    delete updates.createdBy;

    const proposal = await Proposal.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    ).populate("createdBy", "name email");

    if (!proposal) {
      res.status(404).json({
        success: false,
        message: "Proposal not found",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Proposal updated successfully",
      data: proposal,
    });
  } catch (error: any) {
    console.error("Update proposal error:", error);

    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map(
        (e: any) => e.message
      );
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

/* ─────────────────────────────────────────
   PATCH /api/proposals/:id/status
   Update proposal status only
───────────────────────────────────────── */
export const updateProposalStatus = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowed = ["draft", "submitted", "reviewed", "approved", "rejected"];
    if (!allowed.includes(status)) {
      res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${allowed.join(", ")}`,
      });
      return;
    }

    const proposal = await Proposal.findByIdAndUpdate(
      id,
      { status },
      { new: true }
    );

    if (!proposal) {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    res.status(200).json({
      success: true,
      message: `Proposal status updated to "${status}"`,
      data: proposal,
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

/* ─────────────────────────────────────────
   DELETE /api/proposals/:id
   Delete a proposal
───────────────────────────────────────── */
export const deleteProposal = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;

    const proposal = await Proposal.findByIdAndDelete(id);

    if (!proposal) {
      res.status(404).json({
        success: false,
        message: "Proposal not found",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Proposal deleted successfully",
    });
  } catch (error) {
    console.error("Delete proposal error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting proposal",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
