import mongoose from "mongoose";
import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import EmailCampaign from "../modal/emailModel";
import Proposal from "../modal/proposalsModel";

export const getDashboardOverview = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    if (!mongoose.isValidObjectId(userId)) {
      res.status(400).json({ success: false, message: "Invalid user id." });
      return;
    }

    const userObjectId = new mongoose.Types.ObjectId(userId);

    const [
      totalProposals,
      emailAgg,
      proposalViewsAgg,
      latestProposals,
    ] = await Promise.all([
      Proposal.countDocuments({ userId: userObjectId }),
      EmailCampaign.aggregate<{
        totalEmailSent: number;
        totalEmailClicked: number;
      }>([
        { $match: { userId: userObjectId } },
        {
          $group: {
            _id: null,
            totalEmailSent: { $sum: "$sentCount" },
            totalEmailClicked: { $sum: "$clickedCount" },
          },
        },
      ]),
      Proposal.aggregate<{ totalProposalViews: number }>([
        { $match: { userId: userObjectId } },
        {
          $group: {
            _id: null,
            totalProposalViews: { $sum: "$viewsCount" },
          },
        },
      ]),
      Proposal.find({ userId: userObjectId })
        .sort({ createdAt: -1 })
        .limit(5)
        .select("_id status isActive isFavorite viewsCount createdAt event contact"),
    ]);

    const totalEmailSent = emailAgg[0]?.totalEmailSent || 0;
    const totalEmailClicked = emailAgg[0]?.totalEmailClicked || 0;
    const totalProposalViews = proposalViewsAgg[0]?.totalProposalViews || 0;

    res.status(200).json({
      success: true,
      message: "Dashboard overview fetched successfully",
      data: {
        totals: {
          totalProposals,
          totalEmailSent,
          totalEmailClicked,
          totalProposalViews,
        },
        latestProposals,
      },
    });
  } catch (error) {
    console.error("Get dashboard overview error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching dashboard overview",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
