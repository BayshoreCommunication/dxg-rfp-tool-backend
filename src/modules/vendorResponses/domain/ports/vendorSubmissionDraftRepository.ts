import type { VendorResponseQuestionnaireV1 } from "../../../../../contracts/generated/vendor-response-questionnaire-v1";
import type { VendorResponseV1 } from "../../../../../contracts/generated/vendor-response-v1";
import type { VendorResponseWorkspaceV1 } from "../../../../../contracts/generated/vendor-response-workspace-v1";
import type {
  VendorDraftDocument,
  VendorSubmissionDraftRecord,
  VendorSubmissionDraftScope,
} from "../draft";

export interface VendorSubmissionDraftRepository {
  findCurrentSubmission(
    scope: VendorSubmissionDraftScope,
  ): Promise<VendorResponseWorkspaceV1["currentSubmission"]>;
  findActive(
    scope: VendorSubmissionDraftScope,
    now: Date,
  ): Promise<VendorSubmissionDraftRecord | null>;
  findById(
    scope: VendorSubmissionDraftScope,
    draftId: string,
  ): Promise<VendorSubmissionDraftRecord | null>;
  createActive(input: VendorSubmissionDraftScope & {
    submissionId?: string | null;
    questionnaire: VendorResponseQuestionnaireV1;
    response: VendorResponseV1;
    documents?: VendorDraftDocument[];
    now: Date;
    expiresAt: Date;
  }): Promise<{ draft: VendorSubmissionDraftRecord; created: boolean }>;
  revisionSubmissionIsAuthorized(input: VendorSubmissionDraftScope & {
    submissionId: string;
  }): Promise<boolean>;
  loadRevisionSeed(input: VendorSubmissionDraftScope & {
    submissionId: string;
  }): Promise<{
    questionnaire: VendorResponseQuestionnaireV1;
    response: VendorResponseV1;
    documents: VendorDraftDocument[];
  } | null>;
  updateActive(input: VendorSubmissionDraftScope & {
    draftId: string;
    expectedRevision: number;
    response: VendorResponseV1;
    documents: VendorDraftDocument[];
    now: Date;
    expiresAt: Date;
  }): Promise<VendorSubmissionDraftRecord | null>;
  abandon(input: VendorSubmissionDraftScope & {
    draftId: string;
    expectedRevision: number;
    now: Date;
  }): Promise<VendorSubmissionDraftRecord | null>;
  claimFinalization(input: VendorSubmissionDraftScope & {
    draftId: string;
    expectedRevision: number;
    finalizationKeyHash: string;
    now: Date;
  }): Promise<VendorSubmissionDraftRecord | null>;
  releaseFinalization(input: VendorSubmissionDraftScope & {
    draftId: string;
    expectedRevision: number;
    finalizationKeyHash: string;
  }): Promise<void>;
  completeFinalization(input: VendorSubmissionDraftScope & {
    draftId: string;
    expectedRevision: number;
    finalizationKeyHash: string;
    submittedVersionId: string;
    now: Date;
  }): Promise<VendorSubmissionDraftRecord | null>;
  listCleanupCandidates(now: Date, limit: number): Promise<VendorSubmissionDraftRecord[]>;
  markExpiredAbandoned(draftId: string, now: Date): Promise<boolean>;
  documentIsSubmitted(organizationId: string, documentId: string): Promise<boolean>;
  markDocumentDeleted(draftId: string, documentId: string, deletedAt: Date): Promise<void>;
  markCleanupComplete(draftId: string, completedAt: Date): Promise<void>;
}
