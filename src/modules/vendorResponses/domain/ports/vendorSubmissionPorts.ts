export interface VendorDocumentStorage {
  upload(input: { localPath: string; objectKey: string }): Promise<string>;
  cleanup(localPath: string): Promise<void>;
}

/**
 * "unavailable" means the scan could not be performed (scanner unconfigured,
 * down, or errored) while scanning is required. It blocks the submission, the
 * same as "infected". "skipped" occurs when scanning is explicitly optional,
 * including the safe local/test default when no scanner is configured.
 */
export type VendorUploadScanOutcome = "clean" | "infected" | "skipped" | "unavailable";

/** Optional inline malware scan of an uploaded file before it is stored. */
export type VendorUploadMalwareScan = (
  localPath: string,
) => Promise<VendorUploadScanOutcome>;

export interface VendorResponseNotifier {
  notifyPlanner(input: {
    ownerUserId: string;
    organizationId: string;
    proposalId: string;
    responseId: string;
    proposalTitle: string;
    vendorName: string;
    submittedBy: string;
    email: string;
  }): Promise<void>;
}

export interface VendorConfirmationSender {
  send(input: {
    email: string;
    vendorName: string;
    submittedBy: string;
    proposalTitle: string;
    isUpdate: boolean;
  }): Promise<void>;
}
