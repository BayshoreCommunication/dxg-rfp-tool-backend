export interface SettingsManagementRepository {
  findOrCreateByUserId(userId: string): Promise<Record<string, unknown>>;
  upsertByUserId(input: {
    userId: string;
    updates: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  deleteByUserId(userId: string): Promise<boolean>;
}
