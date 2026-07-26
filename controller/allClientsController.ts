import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import {
  deleteAdminClient,
  listAdminClients,
  setAdminClientBlocked,
} from "../src/modules/admin/composition";

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

    const result = await listAdminClients({
      page: req.query.page,
      search: req.query.search,
    });

    res.status(200).json({
      success: true,
      message: "Clients fetched successfully",
      ...result,
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

    const result = await setAdminClientBlocked(id, isBlocked);
    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Client not found." });
      return;
    }

    if (result.kind === "admin_target") {
      res.status(400).json({
        success: false,
        message: "Cannot block an admin account.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: isBlocked
        ? "Client blocked successfully."
        : "Client unblocked successfully.",
      data: { id: result.id, isBlocked: result.isBlocked },
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

    const result = await deleteAdminClient(id);
    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Client not found." });
      return;
    }

    if (result.kind === "admin_target") {
      res.status(400).json({
        success: false,
        message: "Cannot delete an admin account.",
      });
      return;
    }

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
