import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import User from "../modal/user";

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

// Get user by ID
export const getUserById = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
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

// Update user
export const updateUser = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
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
