export interface NotificationRepository {
  listOwned(input: {
    ownerUserId: string;
    unreadOnly: boolean;
    page: number;
    limit: number;
  }): Promise<{
    notifications: Record<string, unknown>[];
    total: number;
    unreadCount: number;
  }>;
  countUnread(ownerUserId: string): Promise<number>;
  markOwnedRead(input: {
    notificationId: string;
    ownerUserId: string;
    readAt: Date;
  }): Promise<Record<string, unknown> | null>;
  markAllOwnedRead(input: {
    ownerUserId: string;
    readAt: Date;
  }): Promise<void>;
}
