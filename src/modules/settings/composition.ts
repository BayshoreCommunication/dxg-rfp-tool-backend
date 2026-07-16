import {
  createDeleteOwnedSettings,
  createGetOwnedSettings,
  createUpdateOwnedSettings,
} from "./application/manageSettings";
import { mongoSettingsManagementRepository } from "./infrastructure/mongo/mongoSettingsManagementRepository";
import { spacesSettingsAssetStorage } from "./infrastructure/storage/spacesSettingsAssetStorage";

export const getOwnedSettings = createGetOwnedSettings(
  mongoSettingsManagementRepository,
);
export const updateOwnedSettings = createUpdateOwnedSettings({
  repository: mongoSettingsManagementRepository,
  storage: spacesSettingsAssetStorage,
  folderName: process.env.DO_FOLDER_NAME || "",
});
export const deleteOwnedSettings = createDeleteOwnedSettings(
  mongoSettingsManagementRepository,
);
