import type { VendorResponseQuestionnaireV1 } from "../../../../contracts/generated/vendor-response-questionnaire-v1";
import type { VendorResponseV1 } from "../../../../contracts/generated/vendor-response-v1";

export const VENDOR_RESPONSE_DRAFT_RETENTION_DAYS_DEFAULT = 30;
export const VENDOR_RESPONSE_DRAFT_RETENTION_DAYS_MAXIMUM = 90;

export type VendorDraftDocumentScopeType =
  | "proposal"
  | "room"
  | "crew_member"
  | "reference";

export type VendorDraftDocument = {
  documentId: string;
  sourceId: string;
  purposeId: string;
  scopeType: VendorDraftDocumentScopeType;
  scopeId?: string;
  name: string;
  url: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  scanStatus: "clean" | "skipped";
  status: "active" | "retired";
  uploadedAt: string;
  retiredAt?: string | null;
  objectDeletedAt?: string | null;
};

export type VendorSubmissionDraftScope = {
  organizationId: string;
  proposalId: string;
  grantId: string;
  grantSubjectHash: string;
};

export type VendorSubmissionDraftRecord = VendorSubmissionDraftScope & {
  draftId: string;
  submissionId?: string | null;
  questionnaire: VendorResponseQuestionnaireV1;
  response: VendorResponseV1;
  documents: VendorDraftDocument[];
  draftRevision: number;
  status: "active" | "submitted" | "abandoned";
  lastSavedAt: string;
  expiresAt: string;
  abandonedAt?: string | null;
  cleanupCompletedAt?: string | null;
};

export type VendorSubmissionDraftDto = {
  draftId: string;
  draftRevision: number;
  status: "active" | "submitted" | "abandoned";
  lastSavedAt: string;
  response: VendorResponseV1;
};

export type VendorSubmissionDraftDetailDto = VendorSubmissionDraftDto & {
  documentManifest: VendorDraftDocumentDto[];
};

export type VendorDraftDocumentDto = Omit<
  VendorDraftDocument,
  "url" | "objectKey" | "status" | "retiredAt" | "objectDeletedAt"
>;

export const createEmptyStructuredVendorResponse = (
  questionnaire: VendorResponseQuestionnaireV1,
): VendorResponseV1 => ({
  schemaVersion: "vendor-response.v1",
  questionnaire: {
    questionnaireId: questionnaire.questionnaireId,
    questionnaireVersion: questionnaire.questionnaireVersion,
    questionnaireChecksum: questionnaire.questionnaireChecksum,
    proposalId: questionnaire.proposalId,
    proposalVersion: questionnaire.proposalVersion,
  },
  identity: { vendorName: "", submittedBy: "", email: "" },
  acknowledgements: [],
  companyProfile: {
    legalName: "",
    headquarters: "",
    largestComparableEvent: "",
    clientMix: [],
  },
  platformIntegrationPlan: "",
  rooms: [],
  crew: [],
  travel: { lodgingRequests: [] },
  pricing: {
    travelSubtotal: {
      amountMinor: 0,
      currency: questionnaire.pricing.currency,
    },
    fees: [],
    discount: { amountMinor: 0, currency: questionnaire.pricing.currency },
    assumptionsExclusions: [],
  },
  alternates: [],
  references: [],
  documents: [],
  valueAdds: "",
});

export const toVendorSubmissionDraftDto = (
  draft: VendorSubmissionDraftRecord,
): VendorSubmissionDraftDto => ({
  draftId: draft.draftId,
  draftRevision: draft.draftRevision,
  status: draft.status,
  lastSavedAt: draft.lastSavedAt,
  response: draft.response,
});

export const toVendorDraftDocumentDto = (
  document: VendorDraftDocument,
): VendorDraftDocumentDto => ({
  documentId: document.documentId,
  sourceId: document.sourceId,
  purposeId: document.purposeId,
  scopeType: document.scopeType,
  ...(document.scopeId ? { scopeId: document.scopeId } : {}),
  name: document.name,
  mimeType: document.mimeType,
  sizeBytes: document.sizeBytes,
  sha256: document.sha256,
  scanStatus: document.scanStatus,
  uploadedAt: document.uploadedAt,
});

export const toVendorSubmissionDraftDetailDto = (
  draft: VendorSubmissionDraftRecord,
): VendorSubmissionDraftDetailDto => ({
  ...toVendorSubmissionDraftDto(draft),
  documentManifest: draft.documents
    .filter((document) => document.status === "active")
    .map(toVendorDraftDocumentDto),
});

export const vendorDraftExpiresAt = (
  now: Date,
  retentionDays: number,
): Date => new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);
