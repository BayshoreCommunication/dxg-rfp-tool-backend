import type { VendorResponseQuestionnaireV1 } from "../../../../../contracts/generated/vendor-response-questionnaire-v1";
import type { VendorResponseV1 } from "../../../../../contracts/generated/vendor-response-v1";
import type {
  VendorDraftDocument,
  VendorSubmissionDraftRecord,
  VendorSubmissionDraftScope,
} from "../draft";

export interface VendorSubmissionDraftRepository {
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
    now: Date;
    expiresAt: Date;
  }): Promise<{ draft: VendorSubmissionDraftRecord; created: boolean }>;
  revisionSubmissionIsAuthorized(input: VendorSubmissionDraftScope & {
    submissionId: string;
  }): Promise<boolean>;
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
  listCleanupCandidates(now: Date, limit: number): Promise<VendorSubmissionDraftRecord[]>;
  markExpiredAbandoned(draftId: string, now: Date): Promise<void>;
  documentIsSubmitted(organizationId: string, documentId: string): Promise<boolean>;
  markDocumentDeleted(draftId: string, documentId: string, deletedAt: Date): Promise<void>;
  markCleanupComplete(draftId: string, completedAt: Date): Promise<void>;
}
