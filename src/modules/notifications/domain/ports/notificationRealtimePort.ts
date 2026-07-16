export interface NotificationRealtimePort {
  emitUnreadCount(ownerUserId: string): Promise<void>;
}
