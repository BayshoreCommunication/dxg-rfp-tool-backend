import path from "path";
import type { SettingsAssetStorage } from "../domain/ports/settingsAssetStorage";
import type { SettingsManagementRepository } from "../domain/ports/settingsManagementRepository";

type Dependencies = {
  repository: SettingsManagementRepository;
  storage: SettingsAssetStorage;
  folderName: string;
  now?: () => number;
};

export const createGetOwnedSettings = (repository: SettingsManagementRepository) =>
  (userId: string) => repository.findOrCreateByUserId(userId);

export const createUpdateOwnedSettings = (dependencies: Dependencies) =>
  async (input: {
    userId: string;
    settings: Record<string, unknown>;
    logo?: { originalname: string; path: string };
  }) => {
    const updates = { ...input.settings };
    delete updates._id;
    delete updates.userId;
    delete updates.createdAt;
    delete updates.updatedAt;

    const branding =
      updates.branding && typeof updates.branding === "object"
        ? { ...(updates.branding as Record<string, unknown>) }
        : undefined;
    const logoFile = branding?.logoFile;
    if (
      branding &&
      typeof logoFile === "string" &&
      (logoFile.startsWith("blob:") || logoFile.startsWith("data:"))
    ) {
      delete branding.logoFile;
    }
    if (branding) updates.branding = branding;

    if (input.logo) {
      const ext = path.extname(input.logo.originalname).toLowerCase() || ".png";
      const prefix = dependencies.folderName.replace(/^\/+|\/+$/g, "");
      const relativeKey = `settings/${input.userId}/logo-${
        (dependencies.now ?? Date.now)()
      }${ext}`;
      const objectKey = prefix ? `${prefix}/${relativeKey}` : relativeKey;
      const logoUrl = await dependencies.storage.upload({
        localPath: input.logo.path,
        objectKey,
      });
      updates.branding = { ...(branding ?? {}), logoFile: logoUrl };
    }

    return dependencies.repository.upsertByUserId({
      userId: input.userId,
      updates,
    });
  };

export const createDeleteOwnedSettings = (
  repository: SettingsManagementRepository,
) => (userId: string) => repository.deleteByUserId(userId);
