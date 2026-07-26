import Settings from "../../../../../modal/settingsModel";
import type { SettingsManagementRepository } from "../../domain/ports/settingsManagementRepository";
import { tenantFilter } from "../../../shared/tenancy/tenantContext";

export const mongoSettingsManagementRepository: SettingsManagementRepository = {
  async findOrCreateByUserId(userId) {
    let settings = await Settings.findOne({ userId, ...tenantFilter() });
    if (!settings) settings = await Settings.create({ userId, ...tenantFilter() });
    return settings.toObject() as unknown as Record<string, unknown>;
  },

  async upsertByUserId({ userId, updates }) {
    const settings = await Settings.findOneAndUpdate(
      { userId, ...tenantFilter() },
      { $set: updates, $setOnInsert: { userId, ...tenantFilter() } },
      {
        new: true,
        runValidators: true,
        upsert: true,
        setDefaultsOnInsert: true,
      },
    );
    return settings.toObject() as unknown as Record<string, unknown>;
  },

  async deleteByUserId(userId) {
    return (await Settings.findOneAndDelete({ userId, ...tenantFilter() })) !== null;
  },
};
