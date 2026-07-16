import { Response } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../middleware/auth";
import {
  getOwnedUnreadCount,
  listOwnedNotifications,
  markAllOwnedNotificationsRead,
  markOwnedNotificationRead,
} from "../src/modules/notifications/composition";

export const getNotifications = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
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

    const result = await listOwnedNotifications({
      ownerUserId: userId,
      query: {
        page: typeof page === "string" ? page : undefined,
        limit: typeof limit === "string" ? limit : undefined,
        unreadOnly: typeof unreadOnly === "string" ? unreadOnly : undefined,
      },
    });

    res.status(200).json({
      success: true,
      data: result.notifications,
      pagination: result.pagination,
      unreadCount: result.unreadCount,
      websocket: {
        path: "/api/notifications/ws",
        auth: "Provide access token in the `token` query parameter.",
      },
    });
  } catch (error) {
    console.error("Get notifications error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching notifications",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getUnreadNotificationCount = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const unreadCount = await getOwnedUnreadCount(userId);

    res.status(200).json({
      success: true,
      data: { unreadCount },
    });
  } catch (error) {
    console.error("Get unread notification count error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching unread count",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const markNotificationAsRead = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
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

    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid notification id",
      });
      return;
    }

    const result = await markOwnedNotificationRead({
      notificationId: id,
      ownerUserId: userId,
    });

    if (result.kind === "not_found") {
      res.status(404).json({
        success: false,
        message: "Notification not found",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Notification marked as read",
      data: result.notification,
    });
  } catch (error) {
    console.error("Mark notification read error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating notification",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const markAllNotificationsAsRead = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    await markAllOwnedNotificationsRead(userId);

    res.status(200).json({
      success: true,
      message: "All notifications marked as read",
    });
  } catch (error) {
    console.error("Mark all notifications read error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating notifications",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
