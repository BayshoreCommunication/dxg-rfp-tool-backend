import { Request, Response } from "express";
import { AuthRequest } from "../middleware/auth";
import Proposal from "../modal/proposalsModel";

/* ─────────────────────────────────────────
   GET /api/proposals
   Get all proposals (with optional filters)
───────────────────────────────────────── */
export const getAllProposals = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const {
      status,
      favorite,
      search,
      page = "1",
      limit = "20",
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const filter: Record<string, any> = {};

    // Restrict to authenticated user's proposals
    if (req.user?.userId) {
      filter.userId = req.user.userId;
    }

    // Filter by status
    if (status && typeof status === "string") {
      filter.status = status;
    }

    // Filter by favorite flag
    if (typeof favorite === "string") {
      if (favorite === "true") filter.isFavorite = true;
      if (favorite === "false") filter.isFavorite = false;
    }

    // Search by event name or contact name/email
    if (search && typeof search === "string") {
      const regex = new RegExp(search, "i");
      filter.$or = [
        { "event.eventName": regex },
        { "contact.contactFirstName": regex },
        { "contact.contactLastName": regex },
        { "contact.contactEmail": regex },
        { "contact.contactOrganization": regex },
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
        .populate("userId", "name email")
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
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;

    const proposal = await Proposal.findOne({
      _id: id,
      userId: req.user?.userId,
    }).populate("userId", "name email");

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
      body.userId = req.user.userId;
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
    delete updates.userId;

    const proposal = await Proposal.findOneAndUpdate(
      { _id: id, userId: req.user?.userId },
      { $set: updates },
      { new: true, runValidators: true }
    ).populate("userId", "name email");

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

    const proposal = await Proposal.findOneAndUpdate(
      { _id: id, userId: req.user?.userId },
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
export const updateProposalMeta = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
    const {
      isActive,
      isFavorite,
      isAccepted,
      isOpen,
      viewsCount,
    } = req.body;

    const updates: Record<string, any> = {};
    if (typeof isActive === "boolean") updates.isActive = isActive;
    if (typeof isFavorite === "boolean") updates.isFavorite = isFavorite;
    if (typeof isAccepted === "boolean") updates.isAccepted = isAccepted;
    if (typeof isOpen === "boolean") updates.isOpen = isOpen;
    if (typeof viewsCount === "number" && viewsCount >= 0) {
      updates.viewsCount = viewsCount;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({
        success: false,
        message:
          "No valid fields provided. Use isActive, isFavorite, isAccepted, isOpen, or viewsCount.",
      });
      return;
    }

    const proposal = await Proposal.findOneAndUpdate(
      { _id: id, userId: req.user?.userId },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!proposal) {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Proposal metadata updated",
      data: proposal,
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
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
    const proposal = await Proposal.findOneAndUpdate(
      { _id: id, userId: req.user?.userId },
      { $inc: { viewsCount: 1 } },
      { new: true }
    );

    if (!proposal) {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Proposal views incremented",
      data: proposal,
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
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;

    const proposal = await Proposal.findOneAndDelete({
      _id: id,
      userId: req.user?.userId,
    });

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
