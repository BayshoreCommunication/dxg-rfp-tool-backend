import fs from "fs/promises";
import crypto from "node:crypto";
import {
  presignSpacesGetUrl,
  spacesObjectKeyFromUrl,
} from "../../../../../utils/uploadToSpaces";
import {
  presignPrivateDocumentGetUrl,
  s3PrivateDocumentStorage,
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

const detectVendorMimeType = (
  bytes: Buffer,
  declaredMimeType?: string,
): string | null => {
  const declared = declaredMimeType?.trim().toLowerCase();
  if (bytes.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) return "image/png";
  if (
    bytes[0] === 0x50
    && bytes[1] === 0x4b
    && bytes[2] === 0x03
    && bytes[3] === 0x04
  ) {
    const contentTypes = Buffer.from("[Content_Types].xml");
    if (!bytes.includes(contentTypes)) return null;
    if (
      declared
        === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      && bytes.includes(Buffer.from("word/"))
    ) return declared;
    if (
      declared
        === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      && bytes.includes(Buffer.from("xl/"))
    ) return declared;
  }
  if ((declared === "text/plain" || declared === "text/csv") && !bytes.includes(0)) {
    return declared;
  }
  return null;
};

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
  async inspect(localPath, declaredMimeType) {
    const bytes = await fs.readFile(localPath);
    return {
      sizeBytes: bytes.byteLength,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      detectedMimeType: detectVendorMimeType(bytes, declaredMimeType),
    };
  },
  async cleanup(localPath) {
    try {
      await fs.unlink(localPath);
    } catch {
      // Best-effort cleanup preserves compatibility with the upload middleware.
    }
  },
  async delete(objectKey) {
    await s3PrivateDocumentStorage.delete(objectKey);
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
