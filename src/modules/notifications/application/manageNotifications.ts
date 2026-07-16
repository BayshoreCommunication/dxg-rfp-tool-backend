import type { NotificationRealtimePort } from "../domain/ports/notificationRealtimePort";
import type { NotificationRepository } from "../domain/ports/notificationRepository";

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const createListOwnedNotifications = (
  repository: NotificationRepository,
) => async (input: {
  ownerUserId: string;
  query: { page?: string; limit?: string; unreadOnly?: string };
}) => {
  const page = positiveInteger(input.query.page, 1);
  const limit = Math.min(100, positiveInteger(input.query.limit, 20));
  const result = await repository.listOwned({
    ownerUserId: input.ownerUserId,
    unreadOnly: input.query.unreadOnly === "true",
    page,
    limit,
  });
  return {
    notifications: result.notifications,
    pagination: {
      total: result.total,
      page,
      limit,
      totalPages: Math.ceil(result.total / limit),
    },
    unreadCount: result.unreadCount,
  };
};

export const createGetOwnedUnreadCount = (repository: NotificationRepository) =>
  (ownerUserId: string) => repository.countUnread(ownerUserId);

export const createMarkOwnedNotificationRead = (dependencies: {
  repository: NotificationRepository;
  realtime: NotificationRealtimePort;
  now?: () => Date;
}) => async (input: { notificationId: string; ownerUserId: string }) => {
  const notification = await dependencies.repository.markOwnedRead({
    ...input,
    readAt: (dependencies.now ?? (() => new Date()))(),
  });
  if (!notification) return { kind: "not_found" as const };
  await dependencies.realtime.emitUnreadCount(input.ownerUserId);
  return { kind: "updated" as const, notification };
};

export const createMarkAllOwnedNotificationsRead = (dependencies: {
  repository: NotificationRepository;
  realtime: NotificationRealtimePort;
  now?: () => Date;
}) => async (ownerUserId: string) => {
  await dependencies.repository.markAllOwnedRead({
    ownerUserId,
    readAt: (dependencies.now ?? (() => new Date()))(),
  });
  await dependencies.realtime.emitUnreadCount(ownerUserId);
};
