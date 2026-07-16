import { emitUnreadNotificationCount } from "../../../../../utils/notificationService";
import type { NotificationRealtimePort } from "../../domain/ports/notificationRealtimePort";

export const legacyNotificationRealtimeAdapter: NotificationRealtimePort = {
  emitUnreadCount: emitUnreadNotificationCount,
};
