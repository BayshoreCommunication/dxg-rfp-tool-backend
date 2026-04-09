import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import EmailCampaign from "../modal/emailModel";
import Proposal from "../modal/proposalsModel";
import User from "../modal/userModel";

const isAdminRole = (role?: string): boolean => {
  const normalized = String(role || "").toLowerCase().trim();
  return (
    normalized === "admin" ||
    normalized === "super_admin" ||
    normalized === "superadmin"
  );
};

const CLIENT_ROLE_FILTER = {
  role: { $nin: ["admin", "super_admin", "superadmin"] },
};

export const getAdminOverview = async (
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

    const [totalClients, totalProposals, emailStats, latestClients] =
      await Promise.all([
        User.countDocuments(CLIENT_ROLE_FILTER),
        Proposal.countDocuments({}),
        EmailCampaign.aggregate<{ totalEmailSent: number; totalClick: number }>([
          {
            $group: {
              _id: null,
              totalEmailSent: { $sum: "$sentCount" },
              totalClick: { $sum: "$clickedCount" },
            },
          },
        ]),
        User.aggregate<{
          id: string;
          name: string;
          email: string;
          joinDate: Date;
          totalProposals: number;
          totalEmailSent: number;
        }>([
          { $match: CLIENT_ROLE_FILTER },
          { $sort: { createdAt: -1 } },
          { $limit: 10 },
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
        ]),
      ]);

    const totals = {
      totalClients,
      totalProposals,
      totalEmailSent: emailStats[0]?.totalEmailSent || 0,
      totalClick: emailStats[0]?.totalClick || 0,
    };

    res.status(200).json({
      success: true,
      message: "Admin overview fetched successfully",
      data: {
        totals,
        latestClients,
      },
    });
  } catch (error) {
    console.error("Get admin overview error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching admin overview",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
