import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import {
  deleteUserAccount,
  getPrimaryAdminAccount,
  getUserAccount,
  listUserAccounts,
  updatePrimaryAdminAccount,
  updateUserAccount,
} from "../src/modules/users/composition";

const primaryAdminEmail = (): string =>
  String(process.env.SUPER_USER_EMAIL || process.env.ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown error";

export const getUsers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await listUserAccounts(req.user?.role);
    if (result.kind === "forbidden") {
      res.status(403).json({ success: false, message: "Only admin can access this resource" });
      return;
    }
    res.status(200).json({ success: true, message: "Users fetched successfully", data: result.users });
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({ success: false, message: "Error fetching users", error: errorMessage(error) });
  }
};

export const getCurrentUser = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: "Unauthorized user" });
    return;
  }
  try {
    const result = await getUserAccount(userId, req.user?.role, userId);
    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }
    if (result.kind === "forbidden") {
      res.status(403).json({ success: false, message: "You can only access your own profile" });
      return;
    }
    res.status(200).json({ success: true, message: "User fetched successfully", data: result.user });
  } catch (error) {
    console.error("Get current user error:", error);
    res.status(500).json({ success: false, message: "Error fetching user", error: errorMessage(error) });
  }
};

export const getPrimaryAdminProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  const requesterId = req.user?.userId?.toString();
  if (!requesterId) {
    res.status(401).json({ success: false, message: "Unauthorized user" });
    return;
  }
  try {
    const result = await getPrimaryAdminAccount(requesterId, req.user?.role, primaryAdminEmail());
    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Admin user not found" });
      return;
    }
    if (result.kind === "forbidden") {
      res.status(403).json({ success: false, message: "Only admin can access this profile" });
      return;
    }
    res.status(200).json({ success: true, message: "Admin profile fetched successfully", data: result.user });
  } catch (error) {
    console.error("Get primary admin profile error:", error);
    res.status(500).json({ success: false, message: "Error fetching admin profile", error: errorMessage(error) });
  }
};

export const updatePrimaryAdminProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  const requesterId = req.user?.userId?.toString();
  if (!requesterId) {
    res.status(401).json({ success: false, message: "Unauthorized user" });
    return;
  }
  try {
    const result = await updatePrimaryAdminAccount(
      requesterId,
      primaryAdminEmail(),
      (req.body ?? {}) as Record<string, unknown>,
    );
    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "Admin user not found" });
      return;
    }
    if (result.kind === "forbidden") {
      res.status(403).json({ success: false, message: "Only the primary admin user can update this profile" });
      return;
    }
    if (result.kind === "email_conflict") {
      res.status(400).json({ success: false, message: "Email already in use" });
      return;
    }
    if (result.kind === "invalid_password") {
      res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
      return;
    }
    res.status(200).json({ success: true, message: "Admin profile updated successfully", data: result.user });
  } catch (error) {
    console.error("Update primary admin profile error:", error);
    res.status(500).json({ success: false, message: "Error updating admin profile", error: errorMessage(error) });
  }
};

export const getUserById = async (req: AuthRequest, res: Response): Promise<void> => {
  const requesterId = req.user?.userId?.toString();
  if (!requesterId) {
    res.status(401).json({ success: false, message: "Unauthorized user" });
    return;
  }
  try {
    const result = await getUserAccount(requesterId, req.user?.role, req.params.id);
    if (result.kind === "forbidden") {
      res.status(403).json({ success: false, message: "You can only access your own profile" });
      return;
    }
    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }
    res.status(200).json({ success: true, data: result.user });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ success: false, message: "Error fetching user", error: errorMessage(error) });
  }
};

const updateProfile = async (
  req: AuthRequest,
  res: Response,
  targetId: string,
): Promise<void> => {
  const requesterId = req.user?.userId?.toString();
  if (!requesterId) {
    res.status(401).json({ success: false, message: "Unauthorized user" });
    return;
  }
  const result = await updateUserAccount(
    requesterId,
    req.user?.role,
    targetId,
    (req.body ?? {}) as Record<string, unknown>,
  );
  if (result.kind === "forbidden") {
    res.status(403).json({ success: false, message: "You can only update your own profile" });
    return;
  }
  if (result.kind === "not_found") {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  if (result.kind === "email_conflict") {
    res.status(400).json({ success: false, message: "Email already in use" });
    return;
  }
  if (result.kind === "invalid_password") {
    res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
    return;
  }
  res.status(200).json({ success: true, message: "User updated successfully", data: result.user });
};

export const updateCurrentUser = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: "Unauthorized user" });
    return;
  }
  try {
    await updateProfile(req, res, userId);
  } catch (error) {
    console.error("Update current user error:", error);
    res.status(500).json({ success: false, message: "Error updating user", error: errorMessage(error) });
  }
};

export const updateUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await updateProfile(req, res, req.params.id);
  } catch (error) {
    console.error("Update user error:", error);
    res.status(500).json({ success: false, message: "Error updating user", error: errorMessage(error) });
  }
};

export const deleteUser = async (req: AuthRequest, res: Response): Promise<void> => {
  const requesterId = req.user?.userId?.toString();
  if (!requesterId) {
    res.status(401).json({ success: false, message: "Unauthorized user" });
    return;
  }
  try {
    const result = await deleteUserAccount(requesterId, req.user?.role, req.params.id);
    if (result.kind === "self_delete") {
      res.status(400).json({ success: false, message: "You cannot delete your own account" });
      return;
    }
    if (result.kind === "forbidden") {
      res.status(403).json({ success: false, message: "You do not have permission to delete this user" });
      return;
    }
    if (result.kind === "not_found") {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }
    res.status(200).json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    console.error("Delete user error:", error);
    res.status(500).json({ success: false, message: "Error deleting user", error: errorMessage(error) });
  }
};
