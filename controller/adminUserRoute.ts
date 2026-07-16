import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import {
  getAdminSelfProfile,
  updateAdminSelfProfile,
} from "../src/modules/admin/composition";

const isAdminRole = (role?: string): boolean => {
  const normalized = String(role || "").toLowerCase().trim();
  return (
    normalized === "admin" ||
    normalized === "super_admin" ||
    normalized === "superadmin"
  );
};

export const getSignedInAdminProfile = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Unauthorized user." });
      return;
    }

    if (!isAdminRole(req.user?.role)) {
      res.status(403).json({
        success: false,
        message: "Only admin can access this resource.",
      });
      return;
    }

    const user = await getAdminSelfProfile(userId);
    if (!user) {
      res.status(404).json({ success: false, message: "User not found." });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Admin profile fetched successfully.",
      data: user,
    });
  } catch (error) {
    console.error("Get signed-in admin profile error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching admin profile.",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const updateSignedInAdminProfile = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Unauthorized user." });
      return;
    }

    if (!isAdminRole(req.user?.role)) {
      res.status(403).json({
        success: false,
        message: "Only admin can access this resource.",
      });
      return;
    }

    const result = await updateAdminSelfProfile({
      userId,
      body: (req.body ?? {}) as Record<string, unknown>,
      file: req.file
        ? { localPath: req.file.path, originalName: req.file.originalname }
        : undefined,
    });
    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "User not found." });
      return;
    }
    if (result.kind === "old_password_required") {
      res.status(400).json({
        success: false,
        message: "Old password is required to change password.",
      });
      return;
    }
    if (result.kind === "wrong_old_password") {
      res.status(400).json({ success: false, message: "Old password does not match." });
      return;
    }
    if (result.kind === "invalid_password") {
      res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
      return;
    }
    if (result.kind === "empty_name") {
      res.status(400).json({ success: false, message: "Name cannot be empty." });
      return;
    }
    res.status(200).json({
      success: true,
      message: "Admin profile updated successfully.",
      data: result.user,
    });
  } catch (error) {
    console.error("Update signed-in admin profile error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating admin profile.",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
