"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const notificationController_1 = require("../controller/notificationController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.get("/", auth_1.authenticate, notificationController_1.getNotifications);
router.get("/unread-count", auth_1.authenticate, notificationController_1.getUnreadNotificationCount);
router.patch("/read-all", auth_1.authenticate, notificationController_1.markAllNotificationsAsRead);
router.patch("/:id/read", auth_1.authenticate, notificationController_1.markNotificationAsRead);
exports.default = router;
//# sourceMappingURL=notificationRoute.js.map