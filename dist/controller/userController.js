"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteUser = exports.updateUser = exports.updateCurrentUser = exports.getUserById = exports.updatePrimaryAdminProfile = exports.getPrimaryAdminProfile = exports.getCurrentUser = exports.getUsers = void 0;
const userModel_1 = __importDefault(require("../modal/userModel"));
const isPrivilegedRole = (role) => {
    const normalizedRole = (role || "").toLowerCase();
    return (normalizedRole === "admin" ||
        normalizedRole === "super_admin" ||
        normalizedRole === "superadmin");
};
const getPrimaryAdminEmail = () => String(process.env.SUPER_USER_EMAIL || process.env.ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();
const findPrimaryAdminUser = async () => {
    const adminEmail = getPrimaryAdminEmail();
    if (adminEmail) {
        const byEmail = await userModel_1.default.findOne({ email: adminEmail });
        if (byEmail)
            return byEmail;
    }
    // Fallback: keep a single stable admin target (earliest created user).
    return userModel_1.default.findOne().sort({ createdAt: 1 });
};
// Get all users
const getUsers = async (req, res) => {
    try {
        const users = await userModel_1.default.find()
            .select("-password")
            .sort({ createdAt: -1 });
        res.status(200).json({
            success: true,
            message: "Users fetched successfully",
            data: users,
        });
    }
    catch (error) {
        console.error("Get users error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching users",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getUsers = getUsers;
// Get current authenticated user
const getCurrentUser = async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            res.status(401).json({
                success: false,
                message: "Unauthorized user",
            });
            return;
        }
        const user = await userModel_1.default.findById(userId).select("-password");
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
    }
    catch (error) {
        console.error("Get current user error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching user",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getCurrentUser = getCurrentUser;
// Get singleton admin profile (one user only)
const getPrimaryAdminProfile = async (req, res) => {
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
        const safeAdmin = await userModel_1.default.findById(adminUser._id).select("-password");
        res.status(200).json({
            success: true,
            message: "Admin profile fetched successfully",
            data: safeAdmin,
        });
    }
    catch (error) {
        console.error("Get primary admin profile error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching admin profile",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getPrimaryAdminProfile = getPrimaryAdminProfile;
// Update singleton admin profile (one user only)
const updatePrimaryAdminProfile = async (req, res) => {
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
            const existingUser = await userModel_1.default.findOne({ email });
            if (existingUser && existingUser._id.toString() !== adminUser._id.toString()) {
                res.status(400).json({
                    success: false,
                    message: "Email already in use",
                });
                return;
            }
            adminUser.email = email;
        }
        if (name !== undefined)
            adminUser.name = name;
        if (phone !== undefined)
            adminUser.phone = phone;
        if (avatar !== undefined)
            adminUser.avatar = avatar;
        if (password)
            adminUser.password = password;
        await adminUser.save();
        const safeAdmin = await userModel_1.default.findById(adminUser._id).select("-password");
        res.status(200).json({
            success: true,
            message: "Admin profile updated successfully",
            data: safeAdmin,
        });
    }
    catch (error) {
        console.error("Update primary admin profile error:", error);
        res.status(500).json({
            success: false,
            message: "Error updating admin profile",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.updatePrimaryAdminProfile = updatePrimaryAdminProfile;
// Get user by ID
const getUserById = async (req, res) => {
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
        const user = await userModel_1.default.findById(id).select("-password");
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
    }
    catch (error) {
        console.error("Get user error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching user",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getUserById = getUserById;
// Update current authenticated user
const updateCurrentUser = async (req, res) => {
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
        const user = await userModel_1.default.findById(userId);
        if (!user) {
            res.status(404).json({
                success: false,
                message: "User not found",
            });
            return;
        }
        if (email && email !== user.email) {
            const existingUser = await userModel_1.default.findOne({ email });
            if (existingUser) {
                res.status(400).json({
                    success: false,
                    message: "Email already in use",
                });
                return;
            }
        }
        const updateData = {};
        if (name)
            updateData.name = name;
        if (email)
            updateData.email = email;
        if (phone !== undefined)
            updateData.phone = phone;
        if (password)
            updateData.password = password;
        if (avatar !== undefined)
            updateData.avatar = avatar;
        const updatedUser = await userModel_1.default.findByIdAndUpdate(userId, updateData, {
            new: true,
            runValidators: true,
        }).select("-password");
        res.status(200).json({
            success: true,
            message: "User updated successfully",
            data: updatedUser,
        });
    }
    catch (error) {
        console.error("Update current user error:", error);
        res.status(500).json({
            success: false,
            message: "Error updating user",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.updateCurrentUser = updateCurrentUser;
// Update user
const updateUser = async (req, res) => {
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
        const user = await userModel_1.default.findById(id);
        if (!user) {
            res.status(404).json({
                success: false,
                message: "User not found",
            });
            return;
        }
        // Check if email is being changed and if it's already taken
        if (email && email !== user.email) {
            const existingUser = await userModel_1.default.findOne({ email });
            if (existingUser) {
                res.status(400).json({
                    success: false,
                    message: "Email already in use",
                });
                return;
            }
        }
        // Update user
        const updateData = {};
        if (name)
            updateData.name = name;
        if (email)
            updateData.email = email;
        if (phone !== undefined)
            updateData.phone = phone;
        if (password)
            updateData.password = password;
        if (avatar !== undefined)
            updateData.avatar = avatar;
        const updatedUser = await userModel_1.default.findByIdAndUpdate(id, updateData, {
            new: true,
            runValidators: true,
        }).select("-password");
        res.status(200).json({
            success: true,
            message: "User updated successfully",
            data: updatedUser,
        });
    }
    catch (error) {
        console.error("Update user error:", error);
        res.status(500).json({
            success: false,
            message: "Error updating user",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.updateUser = updateUser;
// Delete user
const deleteUser = async (req, res) => {
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
        const user = await userModel_1.default.findByIdAndDelete(id);
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
    }
    catch (error) {
        console.error("Delete user error:", error);
        res.status(500).json({
            success: false,
            message: "Error deleting user",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.deleteUser = deleteUser;
//# sourceMappingURL=userController.js.map