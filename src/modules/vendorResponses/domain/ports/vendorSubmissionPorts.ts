export interface VendorDocumentStorage {
  upload(input: { localPath: string; objectKey: string }): Promise<string>;
  inspect(
    localPath: string,
    declaredMimeType?: string,
  ): Promise<{ sizeBytes: number; sha256: string; detectedMimeType?: string | null }>;
  cleanup(localPath: string): Promise<void>;
  delete(objectKey: string): Promise<void>;
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
    versionNumber: number;
    responseFormat: "structured_v1" | "legacy_unstructured";
    grandTotalMinor: number | null;
    currency: string | null;
  }): Promise<void>;
}

export interface VendorConfirmationSender {
  send(input: {
    organizationId: string;
    proposalId: string;
    submissionId: string;
    versionId: string;
    versionNumber: number;
    email: string;
    vendorName: string;
    submittedBy: string;
    proposalTitle: string;
    isUpdate: boolean;
    receivedAt: string;
    manifestChecksum: string;
    questionnaireVersion: number | null;
    grandTotalMinor: number | null;
    currency: string | null;
    currencyDecimalPrecision: number;
    fileCount: number;
  }): Promise<{
    status: "accepted" | "failed";
    attemptedAt: string;
    acceptedAt: string | null;
  }>;
}
