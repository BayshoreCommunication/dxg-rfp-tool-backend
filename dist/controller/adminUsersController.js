"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteAdminUser = exports.updateAdminUser = exports.createAdminUser = exports.getAdminUsers = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const userModel_1 = __importDefault(require("../modal/userModel"));
const isSuperAdminRole = (role) => {
    const normalized = String(role || "").toLowerCase().trim().replace(/[\s-]/g, "_");
    return normalized === "super_admin" || normalized === "superadmin";
};
const isAdminRole = (role) => {
    const normalized = String(role || "").toLowerCase().trim().replace(/[\s-]/g, "_");
    return normalized === "admin" || normalized === "super_admin" || normalized === "superadmin";
};
const ALLOWED_ROLES = ["admin", "super_admin"];
// GET /api/admin-users
const getAdminUsers = async (req, res) => {
    try {
        if (!req.user?.userId || !isSuperAdminRole(req.user.role)) {
            res.status(403).json({ success: false, message: "Only super admin can access this resource." });
            return;
        }
        const admins = await userModel_1.default.find({
            role: { $in: ["admin", "super_admin", "superadmin"] },
        })
            .select("-password")
            .sort({ createdAt: -1 });
        res.status(200).json({
            success: true,
            message: "Admin users fetched successfully.",
            data: admins,
        });
    }
    catch (error) {
        console.error("Get admin users error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching admin users.",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getAdminUsers = getAdminUsers;
// POST /api/admin-users
const createAdminUser = async (req, res) => {
    try {
        if (!req.user?.userId || !isSuperAdminRole(req.user.role)) {
            res.status(403).json({ success: false, message: "Only super admin can perform this action." });
            return;
        }
        const { name, email, password, role } = req.body;
        if (!name?.trim() || !email?.trim() || !password?.trim()) {
            res.status(400).json({ success: false, message: "Name, email, and password are required." });
            return;
        }
        if (!ALLOWED_ROLES.includes(role)) {
            res.status(400).json({
                success: false,
                message: `Role must be one of: ${ALLOWED_ROLES.join(", ")}.`,
            });
            return;
        }
        if (password.trim().length < 6) {
            res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
            return;
        }
        const existing = await userModel_1.default.findOne({ email: email.toLowerCase().trim() });
        if (existing) {
            res.status(409).json({ success: false, message: "Email is already in use." });
            return;
        }
        const user = await userModel_1.default.create({
            name: name.trim(),
            email: email.toLowerCase().trim(),
            password: password.trim(),
            role,
        });
        const safeUser = await userModel_1.default.findById(user._id).select("-password");
        res.status(201).json({
            success: true,
            message: "Admin user created successfully.",
            data: safeUser,
        });
    }
    catch (error) {
        console.error("Create admin user error:", error);
        res.status(500).json({
            success: false,
            message: "Error creating admin user.",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.createAdminUser = createAdminUser;
// PUT /api/admin-users/:id
const updateAdminUser = async (req, res) => {
    try {
        if (!req.user?.userId || !isSuperAdminRole(req.user.role)) {
            res.status(403).json({ success: false, message: "Only super admin can perform this action." });
            return;
        }
        const { id } = req.params;
        const { name, phone, role, password } = req.body;
        const user = await userModel_1.default.findById(id).select("+password");
        if (!user) {
            res.status(404).json({ success: false, message: "Admin user not found." });
            return;
        }
        if (!isAdminRole(user.role)) {
            res.status(400).json({ success: false, message: "Target user is not an admin." });
            return;
        }
        if (name !== undefined) {
            const trimmed = name.trim();
            if (!trimmed) {
                res.status(400).json({ success: false, message: "Name cannot be empty." });
                return;
            }
            user.name = trimmed;
        }
        if (phone !== undefined) {
            user.phone = phone.trim();
        }
        if (role !== undefined) {
            if (!ALLOWED_ROLES.includes(role)) {
                res.status(400).json({
                    success: false,
                    message: `Role must be one of: ${ALLOWED_ROLES.join(", ")}.`,
                });
                return;
            }
            user.role = role;
        }
        if (password !== undefined) {
            const trimmed = password.trim();
            if (trimmed.length < 6) {
                res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
                return;
            }
            const salt = await bcryptjs_1.default.genSalt(10);
            user.password = await bcryptjs_1.default.hash(trimmed, salt);
        }
        await user.save({ validateBeforeSave: false });
        const safeUser = await userModel_1.default.findById(user._id).select("-password");
        res.status(200).json({
            success: true,
            message: "Admin user updated successfully.",
            data: safeUser,
        });
    }
    catch (error) {
        console.error("Update admin user error:", error);
        res.status(500).json({
            success: false,
            message: "Error updating admin user.",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.updateAdminUser = updateAdminUser;
// DELETE /api/admin-users/:id
const deleteAdminUser = async (req, res) => {
    try {
        if (!req.user?.userId || !isSuperAdminRole(req.user.role)) {
            res.status(403).json({ success: false, message: "Only super admin can perform this action." });
            return;
        }
        const { id } = req.params;
        if (id === req.user.userId) {
            res.status(400).json({ success: false, message: "You cannot delete your own account." });
            return;
        }
        const user = await userModel_1.default.findById(id);
        if (!user) {
            res.status(404).json({ success: false, message: "Admin user not found." });
            return;
        }
        if (!isAdminRole(user.role)) {
            res.status(400).json({ success: false, message: "Target user is not an admin." });
            return;
        }
        await user.deleteOne();
        res.status(200).json({
            success: true,
            message: "Admin user deleted successfully.",
            data: { id },
        });
    }
    catch (error) {
        console.error("Delete admin user error:", error);
        res.status(500).json({
            success: false,
            message: "Error deleting admin user.",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.deleteAdminUser = deleteAdminUser;
//# sourceMappingURL=adminUsersController.js.map