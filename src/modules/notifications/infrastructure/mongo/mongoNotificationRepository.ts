import Notification from "../../../../../modal/notificationModel";
import type { NotificationRepository } from "../../domain/ports/notificationRepository";
import { tenantFilter } from "../../../shared/tenancy/tenantContext";

const NOTIFICATION_SELECT =
  "_id userId proposalId type title message metadata isRead readAt createdAt updatedAt";

export const mongoNotificationRepository: NotificationRepository = {
  async listOwned({ ownerUserId, unreadOnly, page, limit }) {
    const filter = {
      userId: ownerUserId,
      ...tenantFilter(),
      ...(unreadOnly ? { isRead: false } : {}),
    };
    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(filter)
        .select(NOTIFICATION_SELECT)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Notification.countDocuments(filter),
      Notification.countDocuments({ userId: ownerUserId, isRead: false, ...tenantFilter() }),
    ]);
    return { notifications, total, unreadCount };
  },

  countUnread(ownerUserId) {
    return Notification.countDocuments({ userId: ownerUserId, isRead: false, ...tenantFilter() });
  },

  markOwnedRead({ notificationId, ownerUserId, readAt }) {
    return Notification.findOneAndUpdate(
      { _id: notificationId, userId: ownerUserId, ...tenantFilter() },
      { isRead: true, readAt },
      { new: true },
    )
      .select(NOTIFICATION_SELECT)
      .lean();
  },

  async markAllOwnedRead({ ownerUserId, readAt }) {
    await Notification.updateMany(
      { userId: ownerUserId, isRead: false, ...tenantFilter() },
      { isRead: true, readAt },
    );
  },
};
