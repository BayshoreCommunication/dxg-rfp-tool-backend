"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteSettings = exports.updateSettings = exports.getSettings = void 0;
const path_1 = __importDefault(require("path"));
const settingsModel_1 = __importDefault(require("../modal/settingsModel"));
const uploadToSpaces_1 = require("../utils/uploadToSpaces");
const buildSpacesKey = (userId, originalName) => {
    const folder = process.env.DO_FOLDER_NAME
        ? process.env.DO_FOLDER_NAME.replace(/^\/+|\/+$/g, "")
        : "";
    const ext = path_1.default.extname(originalName).toLowerCase() || ".png";
    const filename = `logo-${Date.now()}${ext}`;
    const basePath = `settings/${userId}`;
    return folder ? `${folder}/${basePath}/${filename}` : `${basePath}/${filename}`;
};
const getSettings = async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            res.status(401).json({ success: false, message: "Unauthorized" });
            return;
        }
        let settings = await settingsModel_1.default.findOne({ userId });
        if (!settings) {
            settings = await settingsModel_1.default.create({ userId });
        }
        res.status(200).json({
            success: true,
            data: settings,
        });
    }
    catch (error) {
        console.error("Get settings error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching settings",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getSettings = getSettings;
const updateSettings = async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            res.status(401).json({ success: false, message: "Unauthorized" });
            return;
        }
        const body = typeof req.body.settings === "string"
            ? JSON.parse(req.body.settings)
            : req.body;
        const updates = { ...body };
        delete updates._id;
        delete updates.userId;
        delete updates.createdAt;
        delete updates.updatedAt;
        if (req.file) {
            const objectKey = buildSpacesKey(userId, req.file.originalname);
            const logoUrl = await (0, uploadToSpaces_1.uploadToSpaces)(req.file.path, objectKey);
            updates.branding = {
                ...(updates.branding || {}),
                logoFile: logoUrl,
            };
        }
        const settings = await settingsModel_1.default.findOneAndUpdate({ userId }, { $set: updates, $setOnInsert: { userId } }, { new: true, runValidators: true, upsert: true, setDefaultsOnInsert: true });
        res.status(200).json({
            success: true,
            message: "Settings updated successfully",
            data: settings,
        });
    }
    catch (error) {
        console.error("Update settings error:", error);
        res.status(500).json({
            success: false,
            message: "Error updating settings",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.updateSettings = updateSettings;
const deleteSettings = async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            res.status(401).json({ success: false, message: "Unauthorized" });
            return;
        }
        const result = await settingsModel_1.default.findOneAndDelete({ userId });
        if (!result) {
            res.status(404).json({
                success: false,
                message: "Settings not found",
            });
            return;
        }
        res.status(200).json({
            success: true,
            message: "Settings deleted successfully",
        });
    }
    catch (error) {
        console.error("Delete settings error:", error);
        res.status(500).json({
            success: false,
            message: "Error deleting settings",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.deleteSettings = deleteSettings;
//# sourceMappingURL=settingsController.js.map