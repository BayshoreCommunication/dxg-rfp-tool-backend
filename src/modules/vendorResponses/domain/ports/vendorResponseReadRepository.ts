import type { VendorResponseCalculationV1 } from "../../../../../contracts/generated/vendor-response-calculation-v1";
import type { VendorResponseQuestionnaireV1 } from "../../../../../contracts/generated/vendor-response-questionnaire-v1";
import type { VendorResponseV1 } from "../../../../../contracts/generated/vendor-response-v1";

export type VendorResponseFormat = "structured_v1" | "legacy_unstructured";

export type StructuredResponseSummary = {
  questionnaire: {
    questionnaireId: string;
    questionnaireVersion: number;
    questionnaireChecksum: string;
    proposalVersion: number;
    decimalPrecision: number;
  };
  calculation: VendorResponseCalculationV1;
  roomCoverage: { total: number; responded: number };
  crewCount: number;
  alternateCount: number;
  referenceCount: number;
  documentCounts: Array<{ purposeId: string; count: number }>;
};

export type VendorSubmissionTimelineVersion = {
  versionId: string;
  versionNumber: number;
  parentVersionId: string | null;
  reason: string;
  sourceSystem: string;
  format: VendorResponseFormat;
  receivedAt: string;
  manifestChecksum: string;
  vendorName: string;
  submittedBy: string;
  email: string;
  message: string;
  questionnaire: VendorResponseQuestionnaireV1 | null;
  structuredResponse: VendorResponseV1 | null;
  calculationSnapshot: VendorResponseCalculationV1 | null;
  retiredDocuments: Array<{
    documentId: string;
    retiredFromVersionId: string;
  }>;
  documents: Array<{
    documentId: string;
    sourceId: string;
    name: string;
    url: string;
    mimeType: string;
    sizeBytes: number | null;
    sha256: string | null;
    scanStatus: "clean" | "skipped" | "legacy_unknown";
    purposeId: string | null;
    scopeType: "proposal" | "room" | "crew_member" | "reference" | null;
    scopeId: string | null;
    versionDisposition: "added" | "inherited" | "legacy";
    inheritedFromVersionId: string | null;
  }>;
};

export interface VendorResponseReadRepository {
  listOwnedProposalSummaries(input: {
    ownerUserId: string;
    search?: string;
    page: number;
    limit: number;
  }): Promise<{
    proposals: Array<{
      proposalId: string;
      proposalTitle: string;
      responseCount: number;
      unreadCount: number;
      latestResponseAt: string;
      latestVendorName: string;
    }>;
    total: number;
    responseCount: number;
    unreadCount: number;
  }>;
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
    filteredUnreadCount: number;
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
    versions: VendorSubmissionTimelineVersion[];
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
