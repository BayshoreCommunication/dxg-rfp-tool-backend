import { Router } from "express";
import {
  createNotificationSocketTicket,
  getNotifications,
  getUnreadNotificationCount,
  markAllNotificationsAsRead,
  markNotificationAsRead,
} from "../controller/notificationController";
import { authenticate } from "../middleware/auth";

const router = Router();

router.get("/", authenticate, getNotifications);
router.post("/socket-ticket", authenticate, createNotificationSocketTicket);
router.get("/unread-count", authenticate, getUnreadNotificationCount);
router.patch("/read-all", authenticate, markAllNotificationsAsRead);
router.patch("/:id/read", authenticate, markNotificationAsRead);

export default router;
