import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import {
  createAdministrativeUser,
  deleteAdministrativeUser,
  listAdministrativeUsers,
  updateAdministrativeUser,
} from "../src/modules/admin/composition";

const isSuperAdminRole = (role?: string): boolean => {
  const normalized = String(role || "").toLowerCase().trim().replace(/[\s-]/g, "_");
  return normalized === "super_admin" || normalized === "superadmin";
};

const ALLOWED_ROLES = ["admin", "super_admin"] as const;

const validationMessage = (code: string): string => {
  if (code === "required") return "Name, email, and password are required.";
  if (code === "invalid_role") return `Role must be one of: ${ALLOWED_ROLES.join(", ")}.`;
  if (code === "empty_name") return "Name cannot be empty.";
  return "Password must be at least 8 characters.";
};

// GET /api/admin-users
export const getAdminUsers = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!req.user?.userId || !isSuperAdminRole(req.user.role)) {
      res.status(403).json({ success: false, message: "Only super admin can access this resource." });
      return;
    }

    const admins = await listAdministrativeUsers();

    res.status(200).json({
      success: true,
      message: "Admin users fetched successfully.",
      data: admins,
    });
  } catch (error) {
    console.error("Get admin users error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching admin users.",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// POST /api/admin-users
export const createAdminUser = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!req.user?.userId || !isSuperAdminRole(req.user.role)) {
      res.status(403).json({ success: false, message: "Only super admin can perform this action." });
      return;
    }

    const result = await createAdministrativeUser(req.body ?? {});
    if (result.kind === "validation") {
      res.status(400).json({ success: false, message: validationMessage(result.code) });
      return;
    }
    if (result.kind === "email_conflict") {
      res.status(409).json({ success: false, message: "Email is already in use." });
      return;
    }

    res.status(201).json({
      success: true,
      message: "Admin user created successfully.",
      data: result.user,
    });
  } catch (error) {
    console.error("Create admin user error:", error);
    res.status(500).json({
      success: false,
      message: "Error creating admin user.",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// PUT /api/admin-users/:id
export const updateAdminUser = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!req.user?.userId || !isSuperAdminRole(req.user.role)) {
      res.status(403).json({ success: false, message: "Only super admin can perform this action." });
      return;
    }

    const { id } = req.params;
    const result = await updateAdministrativeUser(id, req.body ?? {});
    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Admin user not found." });
      return;
    }
    if (result.kind === "non_admin_target") {
      res.status(400).json({ success: false, message: "Target user is not an admin." });
      return;
    }
    if (result.kind === "validation") {
      res.status(400).json({ success: false, message: validationMessage(result.code) });
      return;
    }
    res.status(200).json({
      success: true,
      message: "Admin user updated successfully.",
      data: result.user,
    });
  } catch (error) {
    console.error("Update admin user error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating admin user.",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// DELETE /api/admin-users/:id
export const deleteAdminUser = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!req.user?.userId || !isSuperAdminRole(req.user.role)) {
      res.status(403).json({ success: false, message: "Only super admin can perform this action." });
      return;
    }

    const { id } = req.params;

    const result = await deleteAdministrativeUser(req.user.userId, id);
    if (result.kind === "self_delete") {
      res.status(400).json({ success: false, message: "You cannot delete your own account." });
      return;
    }
    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Admin user not found." });
      return;
    }
    if (result.kind === "non_admin_target") {
      res.status(400).json({ success: false, message: "Target user is not an admin." });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Admin user deleted successfully.",
      data: { id },
    });
  } catch (error) {
    console.error("Delete admin user error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting admin user.",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
