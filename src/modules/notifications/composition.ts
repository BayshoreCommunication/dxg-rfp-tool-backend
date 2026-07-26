import {
  createGetOwnedUnreadCount,
  createListOwnedNotifications,
  createMarkAllOwnedNotificationsRead,
  createMarkOwnedNotificationRead,
} from "./application/manageNotifications";
import { mongoNotificationRepository } from "./infrastructure/mongo/mongoNotificationRepository";
import { legacyNotificationRealtimeAdapter } from "./infrastructure/realtime/legacyNotificationRealtimeAdapter";
import { generateNotificationSocketTicket } from "../../../config/jwt";

export const listOwnedNotifications = createListOwnedNotifications(
  mongoNotificationRepository,
);
export const getOwnedUnreadCount = createGetOwnedUnreadCount(
  mongoNotificationRepository,
);
export const markOwnedNotificationRead = createMarkOwnedNotificationRead({
  repository: mongoNotificationRepository,
  realtime: legacyNotificationRealtimeAdapter,
});
export const markAllOwnedNotificationsRead =
  createMarkAllOwnedNotificationsRead({
    repository: mongoNotificationRepository,
    realtime: legacyNotificationRealtimeAdapter,
  });

export const issueNotificationSocketTicket =
  generateNotificationSocketTicket;
