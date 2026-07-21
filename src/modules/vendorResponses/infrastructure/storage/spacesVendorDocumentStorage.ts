import fs from "fs/promises";
import {
  presignSpacesGetUrl,
  spacesObjectKeyFromUrl,
  uploadPrivateToSpaces,
} from "../../../../../utils/uploadToSpaces";
import type { VendorDocumentStorage } from "../../domain/ports/vendorSubmissionPorts";
import type { VendorDocumentUrlSigner } from "../../domain/ports/vendorResponseReadRepository";

/**
 * Vendor documents arrive via an unauthenticated public endpoint, so new
 * uploads are stored WITHOUT the public-read ACL. The private key prefix
 * below distinguishes them from legacy objects that were uploaded publicly
 * (those keep working via their stored absolute URL, passed through as-is).
 */
export const VENDOR_PRIVATE_KEY_SEGMENT = "/vendor-responses-private/";

const PRESIGN_EXPIRY_SECONDS = 15 * 60; // 15 minutes

export const spacesVendorDocumentStorage: VendorDocumentStorage = {
  upload({ localPath, objectKey }) {
    return uploadPrivateToSpaces(localPath, objectKey);
  },
  async cleanup(localPath) {
    try {
      await fs.unlink(localPath);
    } catch {
      // Best-effort cleanup preserves compatibility with the upload middleware.
    }
  },
};

export const spacesVendorDocumentUrlSigner: VendorDocumentUrlSigner = {
  async presignDocumentUrl(url) {
    if (typeof url !== "string" || !url.includes(VENDOR_PRIVATE_KEY_SEGMENT)) {
      // Legacy public object (pre-dates the private storage change) or
      // unexpected value — pass through unchanged.
      return url;
    }
    const objectKey = spacesObjectKeyFromUrl(url);
    if (!objectKey) return url;
    try {
      return await presignSpacesGetUrl(objectKey, PRESIGN_EXPIRY_SECONDS);
    } catch {
      // If presigning is unavailable (e.g. missing config) fall back to the
      // stored URL rather than breaking the owner inbox.
      return url;
    }
  },
};
