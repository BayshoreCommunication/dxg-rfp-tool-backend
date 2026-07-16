import { uploadToSpaces } from "../../../../../utils/uploadToSpaces";
import type { SettingsAssetStorage } from "../../domain/ports/settingsAssetStorage";

export const spacesSettingsAssetStorage: SettingsAssetStorage = {
  upload({ localPath, objectKey }) {
    return uploadToSpaces(localPath, objectKey);
  },
};
