import type { VendorSubmissionVersionReason } from "../../../../../modal/vendorSubmissionVersionModel";
import type { VendorResponseCalculationV1 } from "../../../../../contracts/generated/vendor-response-calculation-v1";
import type { VendorResponseQuestionnaireV1 } from "../../../../../contracts/generated/vendor-response-questionnaire-v1";
import type { VendorResponseV1 } from "../../../../../contracts/generated/vendor-response-v1";

export type VendorDocument = {
  documentId: string;
  sourceId: string;
  name: string;
  url: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number | null;
  sha256: string | null;
  scanStatus: "clean" | "skipped" | "legacy_unknown";
  purposeId?: string | null;
  scopeType?: "proposal" | "room" | "crew_member" | "reference" | null;
  scopeId?: string | null;
  versionDisposition?: "added" | "inherited" | "legacy";
  inheritedFromVersionId?: string | null;
};

export type VendorRetiredDocument = {
  documentId: string;
  retiredFromVersionId: string;
};

export type StructuredVendorSubmissionSnapshot = {
  finalizedDraftId: string;
  questionnaire: VendorResponseQuestionnaireV1;
  response: VendorResponseV1;
  calculation: VendorResponseCalculationV1;
  retiredDocuments: VendorRetiredDocument[];
};

export type VendorResponseRecord = Record<string, unknown> & {
  _id?: unknown;
  proposalTitle?: string;
  submissionId?: unknown;
  currentVersionId?: unknown;
  currentVersionNumber?: number;
  documents?: VendorDocument[];
};

export type VendorProposalReference = {
  proposalId: string;
  organizationId: string;
  ownerUserId: string;
  proposalTitle: string;
};

export type VendorSubmissionVersionRecord = {
  submissionId: string;
  versionId: string;
  versionNumber: number;
  parentVersionId: string | null;
  reason: VendorSubmissionVersionReason;
  receivedAt: string;
  manifestChecksum: string;
  proposalId: string;
  organizationId: string;
  ownerUserId: string;
  proposalTitle: string;
  vendorName: string;
  submittedBy: string;
  email: string;
  message: string;
  documents: VendorDocument[];
  retiredDocuments: VendorRetiredDocument[];
  responseSchemaVersion: "vendor-response.v1" | null;
  questionnaire: {
    questionnaireId: string;
    questionnaireVersion: number;
    questionnaireChecksum: string;
    proposalVersion: number;
  } | null;
  questionnaireSnapshot: VendorResponseQuestionnaireV1 | null;
  structuredResponse: VendorResponseV1 | null;
  calculationSnapshot: VendorResponseCalculationV1 | null;
  finalizedDraftId: string | null;
  response: VendorResponseRecord;
};

export type VendorSubmissionReceipt = Omit<
  VendorSubmissionVersionRecord,
  | "response"
  | "organizationId"
  | "ownerUserId"
  | "questionnaireSnapshot"
  | "structuredResponse"
  | "documents"
> & {
  documents: Array<Omit<
    VendorDocument,
    "url" | "objectKey" | "inheritedFromVersionId"
  >>;
};

export interface VendorSubmissionRepository {
  findExisting(input: {
    proposalId: string;
    email: string;
    trackingId: string | null;
  }): Promise<VendorResponseRecord | null>;
  findByTrackingId(trackingId: string): Promise<VendorResponseRecord | null>;
  findByProposalAndEmail(input: {
    proposalId: string;
    email: string;
  }): Promise<VendorResponseRecord | null>;
  findVersionByIdempotencyKey(input: {
    organizationId: string;
    idempotencyKey: string;
  }): Promise<VendorSubmissionVersionRecord | null>;
  findVersionByFinalizedDraft(input: {
    organizationId: string;
    draftId: string;
  }): Promise<VendorSubmissionVersionRecord | null>;
  findProposal(proposalId: string): Promise<VendorProposalReference | null>;
  saveVersion(input: VendorProposalReference & {
    existingResponse: VendorResponseRecord | null;
    submissionId?: string | null;
    vendorName: string;
    submittedBy: string;
    email: string;
    message: string;
    newDocuments: VendorDocument[];
    trackingId: string | null;
    publicGrantId?: string | null;
    idempotencyKey: string;
    reason: VendorSubmissionVersionReason;
    sourceSystem: "public_portal" | "planner_upload" | "legacy_migration" | "api";
    receivedAt: Date;
    structured?: StructuredVendorSubmissionSnapshot;
  }): Promise<{ record: VendorSubmissionVersionRecord; created: boolean }>;
  getReceipt(input: {
    proposalId: string;
    versionId: string;
    email: string;
  }): Promise<VendorSubmissionReceipt | null>;
}

export interface VendorSubmissionSourceRegistry {
  register(record: VendorSubmissionVersionRecord): Promise<{
    registered: number;
    pending: number;
  }>;
}
