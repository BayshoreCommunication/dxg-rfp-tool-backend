import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import { getAdminOverviewReport } from "../src/modules/admin/composition";

const isAdminRole = (role?: string): boolean => {
  const normalized = String(role || "").toLowerCase().trim();
  return (
    normalized === "admin" ||
    normalized === "super_admin" ||
    normalized === "superadmin"
  );
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

    const data = await getAdminOverviewReport();

    res.status(200).json({
      success: true,
      message: "Admin overview fetched successfully",
      data,
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
