import {
  createGetOwnedVendorSubmissionDetail,
  createGetOwnedVendorResponse,
  createListOwnedVendorResponseProposals,
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
export const listOwnedVendorResponseProposals =
  createListOwnedVendorResponseProposals(mongoVendorResponseReadRepository);
export const getOwnedVendorResponse = createGetOwnedVendorResponse(
  mongoVendorResponseReadRepository,
  spacesVendorDocumentUrlSigner,
);
export const getOwnedVendorSubmissionDetail =
  createGetOwnedVendorSubmissionDetail(
    mongoVendorResponseReadRepository,
    spacesVendorDocumentUrlSigner,
  );
export const checkVendorResponse = createCheckVendorResponse(
  mongoVendorSubmissionRepository,
);
export const getVendorSubmissionReceipt = createGetVendorSubmissionReceipt(
  mongoVendorSubmissionRepository,
);
const submitVendorResponseVersion = createSubmitVendorResponse({
  repository: mongoVendorSubmissionRepository,
  storage: spacesVendorDocumentStorage,
  notifier: vendorResponseNotificationAdapter,
  confirmation: vendorConfirmationEmailAdapter,
  sourceRegistry: postgresVendorSubmissionSourceRegistry,
  folderName: process.env.DO_FOLDER_NAME || "rfp-tool",
  malwareScan: vendorUploadMalwareScan,
});

type SubmitInput = Parameters<typeof submitVendorResponseVersion>[0];

export const submitPublicVendorResponse = (
  input: Omit<SubmitInput, "channel" | "recordedByUserId">,
) => submitVendorResponseVersion({ ...input, channel: "public_portal" });

/* Planner-entered response, on behalf of a vendor that replied outside the
   portal. Same version chain, same malware scan, same idempotency — only the
   channel, the ownership check, and the notifications differ. */
export const recordManualVendorResponse = (
  input: Omit<SubmitInput, "channel"> & { recordedByUserId: string },
) => submitVendorResponseVersion({ ...input, channel: "planner_upload" });
