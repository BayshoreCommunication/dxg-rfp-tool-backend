import { uploadToSpaces } from "../../../../../utils/uploadToSpaces";
import type { AdminAvatarStorage } from "../../domain/ports/adminSelfProfilePorts";

export const spacesAdminAvatarStorage: AdminAvatarStorage = {
  async upload({ localPath, objectKey }) {
    return uploadToSpaces(localPath, objectKey);
  },
};
