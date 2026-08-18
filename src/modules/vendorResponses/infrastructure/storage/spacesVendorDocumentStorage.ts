import fs from "fs/promises";
import crypto from "node:crypto";
import {
  presignSpacesGetUrl,
  spacesObjectKeyFromUrl,
} from "../../../../../utils/uploadToSpaces";
import {
  presignPrivateDocumentGetUrl,
  uploadPrivateDocumentFile,
} from "../../../documentIngestion/s3PrivateDocumentStorage";
import type { VendorDocumentStorage } from "../../domain/ports/vendorSubmissionPorts";
import type { VendorDocumentUrlSigner } from "../../domain/ports/vendorResponseReadRepository";

/**
 * Vendor documents arrive via an unauthenticated public endpoint, so new
 * uploads are stored WITHOUT the public-read ACL. The private key prefix
 * below distinguishes them from legacy objects that were uploaded publicly
 * (those keep working via their stored absolute URL, passed through as-is).
 */
export const VENDOR_PRIVATE_KEY_SEGMENT = "/vendor-responses-private/";
export const GOVERNED_VENDOR_OBJECT_PREFIX = "rfpilot-private:";

const PRESIGN_EXPIRY_SECONDS = 15 * 60; // 15 minutes

export const governedVendorObjectUrl = (objectKey: string) =>
  `${GOVERNED_VENDOR_OBJECT_PREFIX}${encodeURIComponent(objectKey)}`;

export const governedVendorObjectKey = (url: string) => {
  if (!url.startsWith(GOVERNED_VENDOR_OBJECT_PREFIX)) return null;
  try {
    const objectKey = decodeURIComponent(url.slice(GOVERNED_VENDOR_OBJECT_PREFIX.length));
    return objectKey || null;
  } catch {
    return null;
  }
};

export const spacesVendorDocumentStorage: VendorDocumentStorage = {
  async upload({ localPath, objectKey }) {
    await uploadPrivateDocumentFile({ localPath, objectKey });
    return governedVendorObjectUrl(objectKey);
  },
  async inspect(localPath) {
    const bytes = await fs.readFile(localPath);
    return {
      sizeBytes: bytes.byteLength,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
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
    if (typeof url !== "string") return url;
    const governedObjectKey = governedVendorObjectKey(url);
    if (governedObjectKey) {
      try {
        return await presignPrivateDocumentGetUrl(governedObjectKey, PRESIGN_EXPIRY_SECONDS);
      } catch {
        return url;
      }
    }
    if (!url.includes(VENDOR_PRIVATE_KEY_SEGMENT)) {
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
