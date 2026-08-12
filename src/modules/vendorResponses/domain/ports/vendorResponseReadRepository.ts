export interface VendorResponseReadRepository {
  listOwned(input: {
    ownerUserId: string;
    unreadOnly: boolean;
    proposalId?: string;
    campaignId?: string;
    page: number;
    limit: number;
  }): Promise<{
    responses: Record<string, unknown>[];
    total: number;
    unreadCount: number;
  }>;
  markOwnedRead(input: {
    responseId: string;
    ownerUserId: string;
  }): Promise<Record<string, unknown> | null>;
  getOwnedSubmissionTimeline(input: {
    responseId: string;
    ownerUserId: string;
  }): Promise<{
    historyTruncated: boolean;
    submission: {
      submissionId: string;
      status: "active" | "withdrawn" | "archived";
      currentVersionId: string | null;
      currentVersionNumber: number;
      createdAt: string;
      updatedAt: string;
    } | null;
    versions: Array<{
      versionId: string;
      versionNumber: number;
      parentVersionId: string | null;
      reason: string;
      sourceSystem: string;
      receivedAt: string;
      manifestChecksum: string;
      vendorName: string;
      submittedBy: string;
      email: string;
      message: string;
      documents: Array<{
        documentId: string;
        sourceId: string;
        name: string;
        url: string;
        mimeType: string;
        sizeBytes: number | null;
        sha256: string | null;
        scanStatus: "clean" | "skipped" | "legacy_unknown";
        inheritedFromVersionId: string | null;
      }>;
    }>;
  } | null>;
}

/**
 * Maps a stored vendor-document URL to a URL the owner can actually open.
 * Private objects get a short-lived presigned GET URL; legacy public URLs
 * pass through unchanged.
 */
export interface VendorDocumentUrlSigner {
  presignDocumentUrl(url: string): Promise<string>;
}
