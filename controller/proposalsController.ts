import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import Proposal from "../modal/proposalsModel";
import Settings from "../modal/settingsModel";
import { uploadToSpaces } from "../utils/uploadToSpaces";

const buildProposalSettingSnapshot = (settings: any) => ({
  branding: {
    brandName: settings?.branding?.brandName ?? "",
    linkPrefix: settings?.branding?.linkPrefix ?? "",
    defaultFont: settings?.branding?.defaultFont ?? "",
    signatureColor: settings?.branding?.signatureColor ?? "",
    logoFile: settings?.branding?.logoFile ?? null,
  },
  proposals: {
    proposalLanguage: settings?.proposals?.proposalLanguage ?? "",
    defaultCurrency: settings?.proposals?.defaultCurrency ?? "",
    expiryDate: settings?.proposals?.expiryDate ?? "",
    priceSeparator: settings?.proposals?.priceSeparator ?? "",
    dateFormat: settings?.proposals?.dateFormat ?? "",
    decimalPrecision: settings?.proposals?.decimalPrecision ?? "",
    contacts: {
      email: {
        enabled: settings?.proposals?.contacts?.email?.enabled ?? false,
        value: settings?.proposals?.contacts?.email?.value ?? "",
      },
      call: {
        enabled: settings?.proposals?.contacts?.call?.enabled ?? false,
        value: settings?.proposals?.contacts?.call?.value ?? "",
      },
    },
    downloadPreview: settings?.proposals?.downloadPreview ?? "",
    teammateEmail: settings?.proposals?.teammateEmail ?? "",
  },
  signatures: {
    signatureType: settings?.signatures?.signatureType ?? "",
    signatureImageUrl: settings?.signatures?.signatureImageUrl ?? "",
    signatureText: settings?.signatures?.signatureText ?? "",
    signatureStyle: settings?.signatures?.signatureStyle ?? "",
  },
});

const getOrCreateSettingsByUserId = async (userId?: string) => {
  if (!userId) return null;
  let settings = await Settings.findOne({ userId });
  if (!settings) {
    settings = await Settings.create({ userId });
  }
  return settings;
};

const withLiveSettings = (proposal: any, settings: any) => {
  if (!proposal) return proposal;
  const plain = typeof proposal.toObject === "function" ? proposal.toObject() : proposal;
  return {
    ...plain,
    proposalSetting: buildProposalSettingSnapshot(settings),
  };
};

const parseExpiryDays = (expirySetting?: string): number | null => {
  if (!expirySetting || typeof expirySetting !== "string") return null;
  const match = expirySetting.match(/(\d+)/);
  if (!match) return null;
  const days = parseInt(match[1], 10);
  return Number.isFinite(days) && days > 0 ? days : null;
};

const checkAndExpireProposal = async (proposal: any, expirySetting?: string) => {
  if (!proposal || !proposal.isActive) return proposal;

  const days = parseExpiryDays(expirySetting);
  if (!days) return proposal;

  const creationDate = new Date(proposal.createdAt);
  const expiryDate = new Date(
    creationDate.getTime() + days * 24 * 60 * 60 * 1000,
  );

  if (new Date() > expiryDate) {
    try {
      const updated = await Proposal.findByIdAndUpdate(
        proposal._id,
        { isActive: false, isOpen: false, status: "rejected" },
        { new: true },
      ).populate("userId", "name email");

      return updated || proposal;
    } catch (e) {
      console.error(`Auto-expire failed for ${proposal._id}:`, e);
      return proposal;
    }
  }

  return proposal;
};

export const getAllProposals = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const settings = await getOrCreateSettingsByUserId(userId);
    const expirySetting = settings?.proposals?.expiryDate;

    const {
      status,
      favorite,
      isActive,
      search,
      page = "1",
      limit = "20",
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const filter: Record<string, any> = {};

    if (userId) {
      filter.userId = userId;
    }

    if (status && typeof status === "string") {
      filter.status = status;
    }

    if (typeof isActive === "string") {
      filter.isActive = isActive === "true";
    }

    if (typeof favorite === "string") {
      if (favorite === "true") filter.isFavorite = true;
      if (favorite === "false") filter.isFavorite = false;
    }

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

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
    const skip = (pageNum - 1) * limitNum;
    const sort: Record<string, 1 | -1> = {
      [sortBy as string]: sortOrder === "asc" ? 1 : -1,
    };

    let [proposals, total] = await Promise.all([
      Proposal.find(filter)
        .populate("userId", "name email")
        .sort(sort)
        .skip(skip)
        .limit(limitNum),
      Proposal.countDocuments(filter),
    ]);

    proposals = await Promise.all(
      proposals.map((p) => checkAndExpireProposal(p, expirySetting)),
    );

    res.status(200).json({
      success: true,
      message: "Proposals fetched successfully",
      data: proposals.map((p) => withLiveSettings(p, settings)),
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

export const getProposalById = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const settings = await getOrCreateSettingsByUserId(userId);
    const expirySetting = settings?.proposals?.expiryDate;
    const { id } = req.params;

    let proposal = await Proposal.findOne({
      _id: id,
      userId,
    }).populate("userId", "name email");

    if (!proposal) {
      res.status(404).json({
        success: false,
        message: "Proposal not found",
      });
      return;
    }

    proposal = await checkAndExpireProposal(proposal, expirySetting);

    res.status(200).json({
      success: true,
      data: withLiveSettings(proposal, settings),
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

export const createProposal = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const body = req.body as Record<string, any>;
    const userId = req.user?.userId;

    if (userId) {
      body.userId = userId;
    }

    delete body.proposalSetting;

    const proposal = new Proposal(body);
    await proposal.save();

    const settings = await getOrCreateSettingsByUserId(userId);

    res.status(201).json({
      success: true,
      message: "Proposal created successfully",
      data: withLiveSettings(proposal, settings),
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
    const updates = req.body as Record<string, any>;
    const userId = req.user?.userId;

    delete updates._id;
    delete updates.createdAt;
    delete updates.userId;
    delete updates.proposalSetting;

    const proposal = await Proposal.findOneAndUpdate(
      { _id: id, userId },
      { $set: updates },
      { new: true, runValidators: true },
    ).populate("userId", "name email");

    if (!proposal) {
      res.status(404).json({
        success: false,
        message: "Proposal not found",
      });
      return;
    }

    const settings = await getOrCreateSettingsByUserId(userId);

    res.status(200).json({
      success: true,
      message: "Proposal updated successfully",
      data: withLiveSettings(proposal, settings),
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

    const allowed = ["draft", "submitted", "reviewed", "approved", "rejected"];
    if (!allowed.includes(status)) {
      res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${allowed.join(", ")}`,
      });
      return;
    }

    const proposal = await Proposal.findOneAndUpdate(
      { _id: id, userId },
      { status },
      { new: true },
    );

    if (!proposal) {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    const settings = await getOrCreateSettingsByUserId(userId);

    res.status(200).json({
      success: true,
      message: `Proposal status updated to "${status}"`,
      data: withLiveSettings(proposal, settings),
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
    const { isActive, isFavorite, isAccepted, isOpen, viewsCount } = req.body;

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
      { _id: id, userId },
      { $set: updates },
      { new: true, runValidators: true },
    );

    if (!proposal) {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    const settings = await getOrCreateSettingsByUserId(userId);

    res.status(200).json({
      success: true,
      message: "Proposal metadata updated",
      data: withLiveSettings(proposal, settings),
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

    const proposal = await Proposal.findOneAndUpdate(
      { _id: id, userId },
      { $inc: { viewsCount: 1 } },
      { new: true },
    );

    if (!proposal) {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    const settings = await getOrCreateSettingsByUserId(userId);

    res.status(200).json({
      success: true,
      message: "Proposal views incremented",
      data: withLiveSettings(proposal, settings),
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

export const uploadProposalFiles = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId || "anonymous";
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;

    if (!files || Object.keys(files).length === 0) {
      res.status(400).json({ success: false, message: "No files uploaded" });
      return;
    }

    const { DO_FOLDER_NAME = "DXG-RFP-Tool" } = process.env;
    const results: Array<{ fieldname: string; originalname: string; url: string }> = [];

    for (const fieldname of Object.keys(files)) {
      for (const file of files[fieldname]) {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
        const objectKey = `${DO_FOLDER_NAME}/proposals/${userId}/${Date.now()}-${safeName}`;

        const url = await uploadToSpaces(file.path, objectKey);
        results.push({ fieldname, originalname: file.originalname, url });
      }
    }

    res.status(200).json({
      success: true,
      message: `${results.length} file(s) uploaded successfully`,
      data: results,
    });
  } catch (error) {
    console.error("Upload proposal files error:", error);
    res.status(500).json({
      success: false,
      message: "Error uploading files",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
