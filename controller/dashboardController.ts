import mongoose from "mongoose";
import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import { getOwnedDashboardOverview } from "../src/modules/dashboard/composition";

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

    const data = await getOwnedDashboardOverview(userId);

    res.status(200).json({
      success: true,
      message: "Dashboard overview fetched successfully",
      data,
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
