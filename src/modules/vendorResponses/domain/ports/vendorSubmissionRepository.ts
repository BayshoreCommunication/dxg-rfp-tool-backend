import type { VendorSubmissionVersionReason } from "../../../../../modal/vendorSubmissionVersionModel";

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
  inheritedFromVersionId?: string | null;
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
  response: VendorResponseRecord;
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
  findProposal(proposalId: string): Promise<VendorProposalReference | null>;
  saveVersion(input: VendorProposalReference & {
    existingResponse: VendorResponseRecord | null;
    vendorName: string;
    submittedBy: string;
    email: string;
    message: string;
    newDocuments: VendorDocument[];
    trackingId: string | null;
    idempotencyKey: string;
    reason: VendorSubmissionVersionReason;
    sourceSystem: "public_portal" | "planner_upload" | "legacy_migration" | "api";
    receivedAt: Date;
  }): Promise<{ record: VendorSubmissionVersionRecord; created: boolean }>;
  getReceipt(input: {
    proposalId: string;
    versionId: string;
    email: string;
  }): Promise<Omit<VendorSubmissionVersionRecord, "response" | "organizationId" | "ownerUserId"> | null>;
}

export interface VendorSubmissionSourceRegistry {
  register(record: VendorSubmissionVersionRecord): Promise<{
    registered: number;
    pending: number;
  }>;
}
