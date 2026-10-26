import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import { getAdminOverviewReport, getAdminProposal, listAdminProposals } from "../src/modules/admin/composition";

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

export const getAdminProposals = async (
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

    const result = await listAdminProposals({
      page: req.query.page,
      search: req.query.search,
      view: req.query.view,
    });

    res.status(200).json({
      success: true,
      message: "Proposals fetched successfully",
      ...result,
    });
  } catch (error) {
    console.error("Get admin proposals error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching proposals",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getAdminProposalDetail = async (
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

    const data = await getAdminProposal(req.params.id);
    if (!data) {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    res.status(200).json({ success: true, message: "Proposal fetched successfully", data });
  } catch (error) {
    console.error("Get admin proposal detail error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching proposal",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
