import { vendorUploadMalwareScan } from "../../../vendorResponses/infrastructure/security/vendorUploadMalwareScan";
import type { SupportUploadScanner } from "../../domain/ports/supportDeskPorts";

/**
 * Reuses the vendor-upload ClamAV adapter and its fail-closed policy
 * (VENDOR_UPLOAD_SCAN_REQUIRED, production default true): a missing or
 * unreachable scanner blocks uploads in production and logs a skip locally.
 */
export const clamAvSupportUploadScanner: SupportUploadScanner = {
  scan: (localPath) => vendorUploadMalwareScan(localPath),
};
