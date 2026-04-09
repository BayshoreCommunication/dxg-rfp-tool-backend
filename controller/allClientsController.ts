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
                joinDate: "$createdAt",
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
