import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import User from "../modal/userModel";

const PER_PAGE = 10;

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isAdminRole = (role?: string): boolean => {
  const normalized = String(role || "").toLowerCase().trim();
  return (
    normalized === "admin" ||
    normalized === "super_admin" ||
    normalized === "superadmin"
  );
};

const isSuperAdminRole = (role?: string): boolean => {
  const normalized = String(role || "").toLowerCase().trim();
  return normalized === "super_admin" || normalized === "superadmin";
};

export const getAdminClientsList = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!req.user?.userId || !isAdminRole(req.user.role)) {
      res.status(403).json({
        success: false,
        message: "Only admin can access this resource.",
      });
      return;
    }

    const pageParam = Number.parseInt(String(req.query.page || "1"), 10);
    const page = Number.isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
    const skip = (page - 1) * PER_PAGE;
    const search = String(req.query.search || "").trim();

    const matchStage: {
      role?: { $nin: string[] };
      $or?: { name?: RegExp; email?: RegExp }[];
    } = {
      // Include all non-admin users. This also works for legacy user records
      // where role might be missing or not exactly "customer".
      role: { $nin: ["admin", "super_admin", "superadmin"] },
    };

    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      matchStage.$or = [{ name: regex }, { email: regex }];
    }

    const [result] = await User.aggregate<{
      metadata: { total: number }[];
      data: {
        _id: string;
        name: string;
        email: string;
        company?: string;
        joinDate: Date;
        totalProposals: number;
        totalEmailSent: number;
      }[];
    }>([
      { $match: matchStage },
      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: PER_PAGE },
            {
              $lookup: {
                from: "proposals",
                let: { userId: "$_id" },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ["$userId", "$$userId"] },
                    },
                  },
                  { $count: "count" },
                ],
                as: "proposalStats",
              },
            },
            {
              $lookup: {
                from: "emailcampaigns",
                let: { userId: "$_id" },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ["$userId", "$$userId"] },
                    },
                  },
                  {
                    $group: {
                      _id: null,
                      totalEmailSent: { $sum: "$sentCount" },
                    },
                  },
                ],
                as: "emailStats",
              },
            },
            {
              $project: {
                _id: 0,
                id: "$_id",
                name: 1,
                email: 1,
                company: { $ifNull: ["$company", null] },
                joinDate: "$createdAt",
                isBlocked: { $ifNull: ["$isBlocked", false] },
                totalProposals: {
                  $ifNull: [{ $first: "$proposalStats.count" }, 0],
                },
                totalEmailSent: {
                  $ifNull: [{ $first: "$emailStats.totalEmailSent" }, 0],
                },
              },
            },
          ],
        },
      },
    ]);

    const total = result?.metadata?.[0]?.total || 0;
    const totalPages = Math.ceil(total / PER_PAGE) || 1;

    res.status(200).json({
      success: true,
      message: "Clients fetched successfully",
      data: result?.data || [],
      pagination: {
        page,
        perPage: PER_PAGE,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
      filters: {
        search,
      },
    });
  } catch (error) {
    console.error("Get admin clients list error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching clients list",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const blockClient = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!req.user?.userId || !isSuperAdminRole(req.user.role)) {
      res.status(403).json({
        success: false,
        message: "Only super admin can perform this action.",
      });
      return;
    }

    const { id } = req.params;
    const { isBlocked } = req.body;

    if (typeof isBlocked !== "boolean") {
      res.status(400).json({
        success: false,
        message: "isBlocked must be a boolean.",
      });
      return;
    }

    const user = await User.findById(id);

    if (!user) {
      res.status(404).json({ success: false, message: "Client not found." });
      return;
    }

    if (isAdminRole(user.role)) {
      res.status(400).json({
        success: false,
        message: "Cannot block an admin account.",
      });
      return;
    }

    user.isBlocked = isBlocked;
    await user.save();

    res.status(200).json({
      success: true,
      message: isBlocked
        ? "Client blocked successfully."
        : "Client unblocked successfully.",
      data: { id: user._id, isBlocked: user.isBlocked },
    });
  } catch (error) {
    console.error("Block client error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating client status.",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const deleteClient = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!req.user?.userId || !isSuperAdminRole(req.user.role)) {
      res.status(403).json({
        success: false,
        message: "Only super admin can perform this action.",
      });
      return;
    }

    const { id } = req.params;

    const user = await User.findById(id);

    if (!user) {
      res.status(404).json({ success: false, message: "Client not found." });
      return;
    }

    if (isAdminRole(user.role)) {
      res.status(400).json({
        success: false,
        message: "Cannot delete an admin account.",
      });
      return;
    }

    await user.deleteOne();

    res.status(200).json({
      success: true,
      message: "Client deleted successfully.",
      data: { id },
    });
  } catch (error) {
    console.error("Delete client error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting client.",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
