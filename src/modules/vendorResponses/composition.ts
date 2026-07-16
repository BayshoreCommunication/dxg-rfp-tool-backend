import {
  createGetOwnedVendorResponse,
  createListOwnedVendorResponses,
} from "./application/readVendorResponses";
import { mongoVendorResponseReadRepository } from "./infrastructure/mongo/mongoVendorResponseReadRepository";
import {
  createCheckVendorResponse,
  createSubmitVendorResponse,
} from "./application/submitVendorResponse";
import { mongoVendorSubmissionRepository } from "./infrastructure/mongo/mongoVendorSubmissionRepository";
import { spacesVendorDocumentStorage } from "./infrastructure/storage/spacesVendorDocumentStorage";
import { vendorResponseNotificationAdapter } from "./infrastructure/notifications/vendorResponseNotificationAdapter";
import { vendorConfirmationEmailAdapter } from "./infrastructure/email/vendorConfirmationEmailAdapter";

export const listOwnedVendorResponses = createListOwnedVendorResponses(
  mongoVendorResponseReadRepository,
);
export const getOwnedVendorResponse = createGetOwnedVendorResponse(
  mongoVendorResponseReadRepository,
);
export const checkVendorResponse = createCheckVendorResponse(
  mongoVendorSubmissionRepository,
);
export const submitPublicVendorResponse = createSubmitVendorResponse({
  repository: mongoVendorSubmissionRepository,
  storage: spacesVendorDocumentStorage,
  notifier: vendorResponseNotificationAdapter,
  confirmation: vendorConfirmationEmailAdapter,
  folderName: process.env.DO_FOLDER_NAME || "rfp-tool",
});
