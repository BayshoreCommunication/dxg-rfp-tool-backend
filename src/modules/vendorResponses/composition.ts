import {
  createGetOwnedVendorResponse,
  createListOwnedVendorResponses,
} from "./application/readVendorResponses";
import { mongoVendorResponseReadRepository } from "./infrastructure/mongo/mongoVendorResponseReadRepository";
import {
  createCheckVendorResponse,
  createGetVendorSubmissionReceipt,
  createSubmitVendorResponse,
} from "./application/submitVendorResponse";
import { mongoVendorSubmissionRepository } from "./infrastructure/mongo/mongoVendorSubmissionRepository";
import {
  spacesVendorDocumentStorage,
  spacesVendorDocumentUrlSigner,
} from "./infrastructure/storage/spacesVendorDocumentStorage";
import { vendorUploadMalwareScan } from "./infrastructure/security/vendorUploadMalwareScan";
import { vendorResponseNotificationAdapter } from "./infrastructure/notifications/vendorResponseNotificationAdapter";
import { vendorConfirmationEmailAdapter } from "./infrastructure/email/vendorConfirmationEmailAdapter";
import { postgresVendorSubmissionSourceRegistry } from "./infrastructure/postgres/postgresVendorSubmissionSourceRegistry";

export const listOwnedVendorResponses = createListOwnedVendorResponses(
  mongoVendorResponseReadRepository,
  spacesVendorDocumentUrlSigner,
);
export const getOwnedVendorResponse = createGetOwnedVendorResponse(
  mongoVendorResponseReadRepository,
  spacesVendorDocumentUrlSigner,
);
export const checkVendorResponse = createCheckVendorResponse(
  mongoVendorSubmissionRepository,
);
export const getVendorSubmissionReceipt = createGetVendorSubmissionReceipt(
  mongoVendorSubmissionRepository,
);
export const submitPublicVendorResponse = createSubmitVendorResponse({
  repository: mongoVendorSubmissionRepository,
  storage: spacesVendorDocumentStorage,
  notifier: vendorResponseNotificationAdapter,
  confirmation: vendorConfirmationEmailAdapter,
  sourceRegistry: postgresVendorSubmissionSourceRegistry,
  folderName: process.env.DO_FOLDER_NAME || "rfp-tool",
  malwareScan: vendorUploadMalwareScan,
});
