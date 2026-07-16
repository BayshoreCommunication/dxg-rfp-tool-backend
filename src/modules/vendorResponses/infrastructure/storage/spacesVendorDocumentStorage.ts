import fs from "fs/promises";
import { uploadToSpaces } from "../../../../../utils/uploadToSpaces";
import type { VendorDocumentStorage } from "../../domain/ports/vendorSubmissionPorts";

export const spacesVendorDocumentStorage: VendorDocumentStorage = {
  upload({ localPath, objectKey }) {
    return uploadToSpaces(localPath, objectKey);
  },
  async cleanup(localPath) {
    try {
      await fs.unlink(localPath);
    } catch {
      // Best-effort cleanup preserves compatibility with the upload middleware.
    }
  },
};
