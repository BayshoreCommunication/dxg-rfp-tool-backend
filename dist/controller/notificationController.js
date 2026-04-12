"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.markAllNotificationsAsRead = exports.markNotificationAsRead = exports.getUnreadNotificationCount = exports.getNotifications = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const notificationModel_1 = __importDefault(require("../modal/notificationModel"));
const notificationService_1 = require("../utils/notificationService");
const NOTIFICATION_SELECT = "_id userId proposalId type title message metadata isRead readAt createdAt updatedAt";
const getNotifications = async (req, res) => {
    try {
        const userId = req.user?.userId;
        const { page = "1", limit = "20", unreadOnly = "false" } = req.query;
        if (!userId) {
            res.status(401).json({
                success: false,
                message: "Authentication required",
            });
            return;
        }
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
        const skip = (pageNum - 1) * limitNum;
        const filter = { userId };
        if (unreadOnly === "true") {
            filter.isRead = false;
        }
        const [notifications, total, unreadCount] = await Promise.all([
            notificationModel_1.default.find(filter)
                .select(NOTIFICATION_SELECT)
                .sort({ createdAt: -1, _id: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean(),
            notificationModel_1.default.countDocuments(filter),
            notificationModel_1.default.countDocuments({ userId, isRead: false }),
        ]);
        res.status(200).json({
            success: true,
            data: notifications,
            pagination: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum),
            },
            unreadCount,
            websocket: {
                path: "/api/notifications/ws",
                auth: "Provide access token in the `token` query parameter.",
            },
        });
    }
    catch (error) {
        console.error("Get notifications error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching notifications",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getNotifications = getNotifications;
const getUnreadNotificationCount = async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            res.status(401).json({
                success: false,
                message: "Authentication required",
            });
            return;
        }
        const unreadCount = await notificationModel_1.default.countDocuments({
            userId,
            isRead: false,
        });
        res.status(200).json({
            success: true,
            data: { unreadCount },
        });
    }
    catch (error) {
        console.error("Get unread notification count error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching unread count",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getUnreadNotificationCount = getUnreadNotificationCount;
const markNotificationAsRead = async (req, res) => {
    try {
        const userId = req.user?.userId;
        const { id } = req.params;
        if (!userId) {
            res.status(401).json({
                success: false,
                message: "Authentication required",
            });
            return;
        }
        if (!mongoose_1.default.isValidObjectId(id)) {
            res.status(400).json({
                success: false,
                message: "Invalid notification id",
            });
            return;
        }
        const notification = await notificationModel_1.default.findOneAndUpdate({ _id: id, userId }, { isRead: true, readAt: new Date() }, { new: true })
            .select(NOTIFICATION_SELECT)
            .lean();
        if (!notification) {
            res.status(404).json({
                success: false,
                message: "Notification not found",
            });
            return;
        }
        await (0, notificationService_1.emitUnreadNotificationCount)(userId);
        res.status(200).json({
            success: true,
            message: "Notification marked as read",
            data: notification,
        });
    }
    catch (error) {
        console.error("Mark notification read error:", error);
        res.status(500).json({
            success: false,
            message: "Error updating notification",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.markNotificationAsRead = markNotificationAsRead;
const markAllNotificationsAsRead = async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            res.status(401).json({
                success: false,
                message: "Authentication required",
            });
            return;
        }
        await notificationModel_1.default.updateMany({ userId, isRead: false }, { isRead: true, readAt: new Date() });
        await (0, notificationService_1.emitUnreadNotificationCount)(userId);
        res.status(200).json({
            success: true,
            message: "All notifications marked as read",
        });
    }
    catch (error) {
        console.error("Mark all notifications read error:", error);
        res.status(500).json({
            success: false,
            message: "Error updating notifications",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.markAllNotificationsAsRead = markAllNotificationsAsRead;
//# sourceMappingURL=notificationController.js.map