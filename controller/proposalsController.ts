import { Response } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../middleware/auth";
import { createNotification } from "../utils/notificationService";
import Proposal from "../modal/proposalsModel";
import Settings from "../modal/settingsModel";
import { uploadToSpaces } from "../utils/uploadToSpaces";

const LIST_PROPOSAL_SELECT = [
  "_id",
  "status",
  "isActive",
  "isFavorite",
  "isAccepted",
  "isOpen",
  "viewsCount",
  "createdAt",
  "updatedAt",
  "event.eventName",
  "contact.contactFirstName",
  "contact.contactLastName",
].join(" ");

const DETAIL_PROPOSAL_SELECT = "-__v";

const SETTINGS_SELECT = [
  "branding.brandName",
  "branding.linkPrefix",
  "branding.defaultFont",
  "branding.signatureColor",
  "branding.logoFile",
  "proposals.proposalLanguage",
  "proposals.defaultCurrency",
  "proposals.expiryDate",
  "proposals.priceSeparator",
  "proposals.dateFormat",
  "proposals.decimalPrecision",
  "proposals.contacts.email.enabled",
  "proposals.contacts.email.value",
  "proposals.contacts.call.enabled",
  "proposals.contacts.call.value",
  "proposals.downloadPreview",
  "proposals.teammateEmail",
  "signatures.signatureType",
  "signatures.signatureImageUrl",
  "signatures.signatureText",
  "signatures.signatureStyle",
].join(" ");

const ALLOWED_SORT_FIELDS = new Set([
  "createdAt",
  "updatedAt",
  "status",
  "viewsCount",
  "event.eventName",
]);

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

const getSettingsByUserId = async (
  userId?: string,
  options?: { createIfMissing?: boolean },
) => {
  if (!userId) return null;

  let settings: any = await Settings.findOne({ userId })
    .select(SETTINGS_SELECT)
    .lean();

  if (!settings && options?.createIfMissing) {
    const createdSettings = await Settings.create({ userId });
    settings = createdSettings.toObject();
  }

  return settings;
};

const withLiveSettings = (proposal: any, settings: any) => {
  if (!proposal) return proposal;
  return {
    ...proposal,
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

const applyDerivedExpiryState = (proposal: any, expirySetting?: string) => {
  if (!proposal || proposal.isActive === false) return proposal;

  const days = parseExpiryDays(expirySetting);
  if (!days) return proposal;

  const createdAt = new Date(proposal.createdAt);
  if (Number.isNaN(createdAt.getTime())) return proposal;

  const expiresAt = createdAt.getTime() + days * 24 * 60 * 60 * 1000;
  if (Date.now() <= expiresAt) return proposal;

  return {
    ...proposal,
    isActive: false,
    isOpen: false,
    status: "rejected",
  };
};

const normalizeSort = (
  sortBy?: string,
  sortOrder?: string,
): Record<string, 1 | -1> => {
  const safeSortBy =
    sortBy && ALLOWED_SORT_FIELDS.has(sortBy) ? sortBy : "createdAt";

  return {
    [safeSortBy]: sortOrder === "asc" ? 1 : -1,
    _id: sortOrder === "asc" ? 1 : -1,
  };
};

const isValidProposalId = (id?: string) =>
  typeof id === "string" && mongoose.isValidObjectId(id);

const buildCountsAggregation = (
  baseFilter: Record<string, any>,
  expirySetting?: string,
) => {
  const expiryDays = parseExpiryDays(expirySetting);
  const expiredThreshold =
    expiryDays && expiryDays > 0
      ? new Date(Date.now() - expiryDays * 24 * 60 * 60 * 1000)
      : null;

  return [
    { $match: baseFilter },
    {
      $group: {
        _id: null,
        all: { $sum: 1 },
        draft: {
          $sum: {
            $cond: [{ $eq: ["$status", "draft"] }, 1, 0],
          },
        },
        live: {
          $sum: {
            $cond: [
              // A proposal is "live" only when it is submitted AND not manually
              // deactivated AND has not yet expired by date.
              expiredThreshold
                ? {
                    $and: [
                      { $eq: ["$status", "submitted"] },
                      { $ne: ["$isActive", false] },
                      { $gt: ["$createdAt", expiredThreshold] },
                    ],
                  }
                : {
                    $and: [
                      { $eq: ["$status", "submitted"] },
                      { $ne: ["$isActive", false] },
                    ],
                  },
              1,
              0,
            ],
          },
        },
        favorite: {
          $sum: {
            $cond: [{ $eq: ["$isFavorite", true] }, 1, 0],
          },
        },
        expired: {
          $sum: {
            $cond: [
              expiredThreshold
                ? {
                    $or: [
                      { $eq: ["$isActive", false] },
                      {
                        $and: [
                          { $ne: ["$isActive", false] },
                          { $lte: ["$createdAt", expiredThreshold] },
                        ],
                      },
                    ],
                  }
                : { $eq: ["$isActive", false] },
              1,
              0,
            ],
          },
        },
      },
    },
  ];
};

export const getAllProposals = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const {
      status,
      favorite,
      isActive,
      includeCounts,
      search,
      page = "1",
      limit = "20",
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    // Settings must be fetched first so we can derive the expiry threshold
    // and build an accurate filter for the "Expired" tab.
    const settings = await getSettingsByUserId(userId);
    const expirySetting = settings?.proposals?.expiryDate;
    const snapshot = buildProposalSettingSnapshot(settings);
    const expiryDays = parseExpiryDays(expirySetting);
    const expiredThreshold = expiryDays
      ? new Date(Date.now() - expiryDays * 24 * 60 * 60 * 1000)
      : null;

    const filter: Record<string, any> = {};

    if (userId) {
      filter.userId = userId;
    }

    if (status && typeof status === "string") {
      filter.status = status;
    }

    if (typeof isActive === "string") {
      if (isActive === "false") {
        // Include proposals that are either manually deactivated OR expired
        // by date, so that the Expired tab returns exactly what the badge
        // count promises.
        if (expiredThreshold) {
          filter.$or = [
            { isActive: false },
            { isActive: { $ne: false }, createdAt: { $lte: expiredThreshold } },
          ];
        } else {
          filter.isActive = false;
        }
      } else {
        filter.isActive = isActive === "true";
      }
    }

    if (typeof favorite === "string") {
      if (favorite === "true") filter.isFavorite = true;
      if (favorite === "false") filter.isFavorite = false;
    }

    if (search && typeof search === "string") {
      const trimmedSearch = search.trim();
      if (trimmedSearch) {
        const regex = new RegExp(escapeRegex(trimmedSearch), "i");
        const searchConditions = [
          { "event.eventName": regex },
          { "contact.contactFirstName": regex },
          { "contact.contactLastName": regex },
          { "contact.contactEmail": regex },
          { "contact.contactOrganization": regex },
        ];
        // When the expired filter already uses $or, combine with $and so both
        // conditions are required.
        if (filter.$or) {
          filter.$and = [{ $or: filter.$or }, { $or: searchConditions }];
          delete filter.$or;
        } else {
          filter.$or = searchConditions;
        }
      }
    }

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * limitNum;
    const sort = normalizeSort(
      typeof sortBy === "string" ? sortBy : undefined,
      typeof sortOrder === "string" ? sortOrder : undefined,
    );

    const [proposals, total] = await Promise.all([
      Proposal.find(filter)
        .select(LIST_PROPOSAL_SELECT)
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Proposal.countDocuments(filter),
    ]);

    const shouldIncludeCounts = includeCounts === "true";

    let counts:
      | {
          all: number;
          draft: number;
          live: number;
          favorite: number;
          expired: number;
        }
      | undefined;

    if (shouldIncludeCounts) {
      // Aggregation pipelines do NOT apply Mongoose schema casting, so we must
      // explicitly convert userId from string → ObjectId, otherwise $match finds
      // nothing and every count returns 0 even when proposals exist.
      const baseFilter: Record<string, any> = {};
      if (userId && mongoose.isValidObjectId(userId)) {
        baseFilter.userId = new mongoose.Types.ObjectId(userId);
      }
      if (search && typeof search === "string") {
        const trimmedSearch = search.trim();
        if (trimmedSearch) {
          const regex = new RegExp(escapeRegex(trimmedSearch), "i");
          baseFilter.$or = [
            { "event.eventName": regex },
            { "contact.contactFirstName": regex },
            { "contact.contactLastName": regex },
            { "contact.contactEmail": regex },
            { "contact.contactOrganization": regex },
          ];
        }
      }

      const [countsResult] = await Proposal.aggregate<{
        all?: number;
        draft?: number;
        live?: number;
        favorite?: number;
        expired?: number;
      }>(buildCountsAggregation(baseFilter, expirySetting));

      counts = {
        all: countsResult?.all ?? 0,
        draft: countsResult?.draft ?? 0,
        live: countsResult?.live ?? 0,
        favorite: countsResult?.favorite ?? 0,
        expired: countsResult?.expired ?? 0,
      };
    }

    res.status(200).json({
      success: true,
      message: "Proposals fetched successfully",
      data: proposals.map((proposal) => ({
        ...applyDerivedExpiryState(proposal, expirySetting),
        proposalSetting: snapshot,
      })),
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
      ...(counts ? { counts } : {}),
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

    const [settings, proposal] = await Promise.all([
      getSettingsByUserId(userId),
      Proposal.findOne({
        _id: id,
        userId,
      })
        .select(DETAIL_PROPOSAL_SELECT)
        .lean(),
    ]);

    if (!proposal) {
      res.status(404).json({
        success: false,
        message: "Proposal not found",
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: withLiveSettings(
        applyDerivedExpiryState(proposal, settings?.proposals?.expiryDate),
        settings,
      ),
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

    const settings = await getSettingsByUserId(userId, { createIfMissing: true });

    res.status(201).json({
      success: true,
      message: "Proposal created successfully",
      data: withLiveSettings(proposal.toObject(), settings),
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

    if (!isValidProposalId(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid proposal id",
      });
      return;
    }

    delete updates._id;
    delete updates.createdAt;
    delete updates.userId;
    delete updates.proposalSetting;

    const proposal = await Proposal.findOneAndUpdate(
      { _id: id, userId },
      { $set: updates },
      { new: true, runValidators: true },
    )
      .select(DETAIL_PROPOSAL_SELECT)
      .lean();

    if (!proposal) {
      res.status(404).json({
        success: false,
        message: "Proposal not found",
      });
      return;
    }

    const settings = await getSettingsByUserId(userId, { createIfMissing: true });

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

    if (!isValidProposalId(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid proposal id",
      });
      return;
    }

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
    )
      .select(DETAIL_PROPOSAL_SELECT)
      .lean();

    if (!proposal) {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    const settings = await getSettingsByUserId(userId, { createIfMissing: true });

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

    if (!isValidProposalId(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid proposal id",
      });
      return;
    }

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
    )
      .select(DETAIL_PROPOSAL_SELECT)
      .lean();

    if (!proposal) {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    const settings = await getSettingsByUserId(userId, { createIfMissing: true });

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

    if (!isValidProposalId(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid proposal id",
      });
      return;
    }

    const proposal = await Proposal.findOneAndUpdate(
      { _id: id, userId },
      { $inc: { viewsCount: 1 } },
      { new: true },
    )
      .select(DETAIL_PROPOSAL_SELECT)
      .lean();

    if (!proposal) {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    const settings = await getSettingsByUserId(userId);

    if (userId) {
      const proposalTitle = proposal.event?.eventName?.trim() || "Untitled Proposal";
      await createNotification({
        userId,
        proposalId: String(proposal._id),
        type: "proposal_view",
        title: "Proposal viewed",
        message: `"${proposalTitle}" received a new view. Total views: ${proposal.viewsCount}.`,
        metadata: {
          viewsCount: proposal.viewsCount,
        },
      });
    }

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

    if (!isValidProposalId(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid proposal id",
      });
      return;
    }

    const proposal = await Proposal.findOneAndDelete({
      _id: id,
      userId: req.user?.userId,
    }).lean();

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
