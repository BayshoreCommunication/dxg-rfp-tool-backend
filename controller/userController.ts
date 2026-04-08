import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import User from "../modal/userModel";

const isPrivilegedRole = (role?: string): boolean => {
  const normalizedRole = (role || "").toLowerCase();
  return (
    normalizedRole === "admin" ||
    normalizedRole === "super_admin" ||
    normalizedRole === "superadmin"
  );
};

const getPrimaryAdminEmail = (): string =>
  String(process.env.SUPER_USER_EMAIL || process.env.ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();

const findPrimaryAdminUser = async () => {
  const adminEmail = getPrimaryAdminEmail();
  if (adminEmail) {
    const byEmail = await User.findOne({ email: adminEmail });
    if (byEmail) return byEmail;
  }

  // Fallback: keep a single stable admin target (earliest created user).
  return User.findOne().sort({ createdAt: 1 });
};

// Get all users
export const getUsers = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const users = await User.find()
      .select("-password")
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      message: "Users fetched successfully",
      data: users,
    });
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching users",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Get current authenticated user
export const getCurrentUser = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({
        success: false,
        message: "Unauthorized user",
      });
      return;
    }

    const user = await User.findById(userId).select("-password");
    if (!user) {
      res.status(404).json({
        success: false,
        message: "User not found",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "User fetched successfully",
      data: user,
    });
  } catch (error) {
    console.error("Get current user error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching user",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Get singleton admin profile (one user only)
export const getPrimaryAdminProfile = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const requesterId = req.user?.userId?.toString();
    if (!requesterId) {
      res.status(401).json({
        success: false,
        message: "Unauthorized user",
      });
      return;
    }

    const adminUser = await findPrimaryAdminUser();
    if (!adminUser) {
      res.status(404).json({
        success: false,
        message: "Admin user not found",
      });
      return;
    }

    if (adminUser._id.toString() !== requesterId && !isPrivilegedRole(req.user?.role)) {
      res.status(403).json({
        success: false,
        message: "Only admin can access this profile",
      });
      return;
    }

    const safeAdmin = await User.findById(adminUser._id).select("-password");
    res.status(200).json({
      success: true,
      message: "Admin profile fetched successfully",
      data: safeAdmin,
    });
  } catch (error) {
    console.error("Get primary admin profile error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching admin profile",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Update singleton admin profile (one user only)
export const updatePrimaryAdminProfile = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const requesterId = req.user?.userId?.toString();
    if (!requesterId) {
      res.status(401).json({
        success: false,
        message: "Unauthorized user",
      });
      return;
    }

    const adminUser = await findPrimaryAdminUser();
    if (!adminUser) {
      res.status(404).json({
        success: false,
        message: "Admin user not found",
      });
      return;
    }

    if (adminUser._id.toString() !== requesterId) {
      res.status(403).json({
        success: false,
        message: "Only the primary admin user can update this profile",
      });
      return;
    }

    const { name, email, phone, password, avatar } = req.body;

    if (email && email !== adminUser.email) {
      const existingUser = await User.findOne({ email });
      if (existingUser && existingUser._id.toString() !== adminUser._id.toString()) {
        res.status(400).json({
          success: false,
          message: "Email already in use",
        });
        return;
      }
      adminUser.email = email;
    }

    if (name !== undefined) adminUser.name = name;
    if (phone !== undefined) adminUser.phone = phone;
    if (avatar !== undefined) adminUser.avatar = avatar;
    if (password) adminUser.password = password;

    await adminUser.save();

    const safeAdmin = await User.findById(adminUser._id).select("-password");
    res.status(200).json({
      success: true,
      message: "Admin profile updated successfully",
      data: safeAdmin,
    });
  } catch (error) {
    console.error("Update primary admin profile error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating admin profile",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Get user by ID
export const getUserById = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
    const requesterId = req.user?.userId?.toString();
    const canAccessOthers = isPrivilegedRole(req.user?.role);

    if (!requesterId) {
      res.status(401).json({
        success: false,
        message: "Unauthorized user",
      });
      return;
    }

    if (id !== requesterId && !canAccessOthers) {
      res.status(403).json({
        success: false,
        message: "You can only access your own profile",
      });
      return;
    }

    const user = await User.findById(id).select("-password");

    if (!user) {
      res.status(404).json({
        success: false,
        message: "User not found",
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: user,
    });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching user",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Update current authenticated user
export const updateCurrentUser = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({
        success: false,
        message: "Unauthorized user",
      });
      return;
    }

    const { name, email, phone, password, avatar } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      res.status(404).json({
        success: false,
        message: "User not found",
      });
      return;
    }

    if (email && email !== user.email) {
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        res.status(400).json({
          success: false,
          message: "Email already in use",
        });
        return;
      }
    }

    const updateData: any = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (password) updateData.password = password;
    if (avatar !== undefined) updateData.avatar = avatar;

    const updatedUser = await User.findByIdAndUpdate(userId, updateData, {
      new: true,
      runValidators: true,
    }).select("-password");

    res.status(200).json({
      success: true,
      message: "User updated successfully",
      data: updatedUser,
    });
  } catch (error) {
    console.error("Update current user error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating user",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Update user
export const updateUser = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
    const requesterId = req.user?.userId?.toString();
    const canAccessOthers = isPrivilegedRole(req.user?.role);

    if (!requesterId) {
      res.status(401).json({
        success: false,
        message: "Unauthorized user",
      });
      return;
    }

    if (id !== requesterId && !canAccessOthers) {
      res.status(403).json({
        success: false,
        message: "You can only update your own profile",
      });
      return;
    }

    const { name, email, phone, password, avatar } = req.body;

    // Find user
    const user = await User.findById(id);
    if (!user) {
      res.status(404).json({
        success: false,
        message: "User not found",
      });
      return;
    }

    // Check if email is being changed and if it's already taken
    if (email && email !== user.email) {
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        res.status(400).json({
          success: false,
          message: "Email already in use",
        });
        return;
      }
    }

    // Update user
    const updateData: any = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (password) updateData.password = password;
    if (avatar !== undefined) updateData.avatar = avatar;

    const updatedUser = await User.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    }).select("-password");

    res.status(200).json({
      success: true,
      message: "User updated successfully",
      data: updatedUser,
    });
  } catch (error) {
    console.error("Update user error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating user",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Delete user
export const deleteUser = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
    const requesterId = req.user?.userId?.toString();
    const canAccessOthers = isPrivilegedRole(req.user?.role);

    if (!requesterId) {
      res.status(401).json({
        success: false,
        message: "Unauthorized user",
      });
      return;
    }

    if (id !== requesterId && !canAccessOthers) {
      res.status(403).json({
        success: false,
        message: "You do not have permission to delete this user",
      });
      return;
    }

    // Prevent deleting yourself
    if (id === req.user?.userId || id === req.user?.userId?.toString()) {
      res.status(400).json({
        success: false,
        message: "You cannot delete your own account",
      });
      return;
    }

    // Find and delete user
    const user = await User.findByIdAndDelete(id);
    if (!user) {
      res.status(404).json({
        success: false,
        message: "User not found",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "User deleted successfully",
    });
  } catch (error) {
    console.error("Delete user error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting user",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
