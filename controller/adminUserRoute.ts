import { Response } from "express";
import path from "path";
import { AuthRequest } from "../middleware/auth";
import User from "../modal/userModel";
import { uploadToSpaces } from "../utils/uploadToSpaces";

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

    const user = await User.findById(userId).select("-password");
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

type UpdateAdminProfilePayload = {
  name?: string;
  phone?: string;
  avatar?: string;
  oldPassword?: string;
  password?: string;
  newPassword?: string;
};

const buildAdminAvatarKey = (userId: string, originalName: string) => {
  const folder = process.env.DO_FOLDER_NAME
    ? process.env.DO_FOLDER_NAME.replace(/^\/+|\/+$/g, "")
    : "";
  const ext = path.extname(originalName).toLowerCase() || ".png";
  const fileName = `avatar-${Date.now()}${ext}`;
  const basePath = `admin/${userId}`;

  return folder ? `${folder}/${basePath}/${fileName}` : `${basePath}/${fileName}`;
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

    const { name, phone, avatar, oldPassword, password, newPassword } =
      (req.body || {}) as UpdateAdminProfilePayload;

    const nextPassword = (newPassword || password || "").trim();
    const hasPasswordChange = Boolean(nextPassword);

    const user = await User.findById(userId).select("+password");
    if (!user) {
      res.status(404).json({ success: false, message: "User not found." });
      return;
    }

    if (hasPasswordChange) {
      if (!oldPassword || !oldPassword.trim()) {
        res.status(400).json({
          success: false,
          message: "Old password is required to change password.",
        });
        return;
      }

      const isOldPasswordValid = await user.comparePassword(oldPassword);
      if (!isOldPasswordValid) {
        res.status(400).json({
          success: false,
          message: "Old password does not match.",
        });
        return;
      }

      user.password = nextPassword;
    }

    if (name !== undefined) {
      const trimmedName = String(name).trim();
      if (!trimmedName) {
        res.status(400).json({
          success: false,
          message: "Name cannot be empty.",
        });
        return;
      }
      user.name = trimmedName;
    }

    if (phone !== undefined) {
      user.phone = String(phone).trim();
    }

    if (avatar !== undefined) {
      user.avatar = String(avatar).trim();
    }

    if (req.file) {
      const objectKey = buildAdminAvatarKey(userId, req.file.originalname);
      const avatarUrl = await uploadToSpaces(req.file.path, objectKey);
      user.avatar = avatarUrl;
    }

    await user.save();

    const safeUser = await User.findById(user._id).select("-password");
    res.status(200).json({
      success: true,
      message: "Admin profile updated successfully.",
      data: safeUser,
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
