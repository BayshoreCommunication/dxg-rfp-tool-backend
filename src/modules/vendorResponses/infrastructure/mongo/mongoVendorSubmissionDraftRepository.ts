import crypto from "node:crypto";
import VendorSubmission from "../../../../../modal/vendorSubmissionModel";
import VendorSubmissionDraft from "../../../../../modal/vendorSubmissionDraftModel";
import VendorSubmissionVersion from "../../../../../modal/vendorSubmissionVersionModel";
import type { VendorResponseQuestionnaireV1 } from "../../../../../contracts/generated/vendor-response-questionnaire-v1";
import type { VendorResponseV1 } from "../../../../../contracts/generated/vendor-response-v1";
import type {
  VendorDraftDocument,
  VendorSubmissionDraftRecord,
  VendorSubmissionDraftScope,
} from "../../domain/draft";
import type { VendorSubmissionDraftRepository } from "../../domain/ports/vendorSubmissionDraftRepository";

type DraftRow = {
  _id: unknown;
  organizationId: unknown;
  proposalId: unknown;
  grantId: unknown;
  grantSubjectHash: string;
  submissionId?: unknown;
  questionnaire: VendorResponseQuestionnaireV1;
  response: VendorResponseV1;
  documents?: Array<Record<string, unknown>>;
  draftRevision: number;
  status: "active" | "submitted" | "abandoned";
  lastSavedAt: Date | string;
  expiresAt: Date | string;
  abandonedAt?: Date | string | null;
  cleanupCompletedAt?: Date | string | null;
};

const iso = (value: Date | string): string => new Date(value).toISOString();

const optionalIso = (value: Date | string | null | undefined): string | null =>
  value ? iso(value) : null;

const mapDocument = (value: Record<string, unknown>): VendorDraftDocument => ({
  documentId: String(value.documentId),
  sourceId: String(value.sourceId),
  purposeId: String(value.purposeId),
  scopeType: value.scopeType as VendorDraftDocument["scopeType"],
  ...(typeof value.scopeId === "string" && value.scopeId
    ? { scopeId: value.scopeId }
    : {}),
  name: String(value.name),
  url: String(value.url),
  objectKey: String(value.objectKey),
  mimeType: String(value.mimeType),
  sizeBytes: Number(value.sizeBytes),
  sha256: String(value.sha256),
  scanStatus: value.scanStatus as VendorDraftDocument["scanStatus"],
  status: value.status as VendorDraftDocument["status"],
  uploadedAt: iso(value.uploadedAt as Date | string),
  retiredAt: optionalIso(value.retiredAt as Date | string | null | undefined),
  objectDeletedAt: optionalIso(
    value.objectDeletedAt as Date | string | null | undefined,
  ),
});

const toRecord = (row: DraftRow): VendorSubmissionDraftRecord => ({
  draftId: String(row._id),
  organizationId: String(row.organizationId),
  proposalId: String(row.proposalId),
  grantId: String(row.grantId),
  grantSubjectHash: row.grantSubjectHash,
  submissionId: row.submissionId ? String(row.submissionId) : null,
  questionnaire: row.questionnaire,
  response: row.response,
  documents: (row.documents ?? []).map(mapDocument),
  draftRevision: Number(row.draftRevision),
  status: row.status,
  lastSavedAt: iso(row.lastSavedAt),
  expiresAt: iso(row.expiresAt),
  abandonedAt: optionalIso(row.abandonedAt),
  cleanupCompletedAt: optionalIso(row.cleanupCompletedAt),
});

const scopeFilter = (scope: VendorSubmissionDraftScope) => ({
  organizationId: scope.organizationId,
  proposalId: scope.proposalId,
  grantId: scope.grantId,
  grantSubjectHash: scope.grantSubjectHash,
});

const duplicateKey = (error: unknown): boolean =>
  (error as { code?: number } | null)?.code === 11000;

const recipientHash = (email: string): string =>
  crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

export const mongoVendorSubmissionDraftRepository: VendorSubmissionDraftRepository = {
  async findActive(scope, now) {
    const row = await VendorSubmissionDraft.findOne({
      ...scopeFilter(scope),
      status: "active",
      expiresAt: { $gt: now },
    }).lean<DraftRow>();
    return row ? toRecord(row) : null;
  },

  async findById(scope, draftId) {
    const row = await VendorSubmissionDraft.findOne({
      _id: draftId,
      ...scopeFilter(scope),
    }).lean<DraftRow>();
    return row ? toRecord(row) : null;
  },

  async createActive(input) {
    await VendorSubmissionDraft.updateMany(
      {
        ...scopeFilter(input),
        status: "active",
        expiresAt: { $lte: input.now },
      },
      {
        $set: {
          status: "abandoned",
          abandonedAt: input.now,
        },
      },
    );
    try {
      const created = await VendorSubmissionDraft.create({
        ...scopeFilter(input),
        submissionId: input.submissionId ?? null,
        questionnaireId: input.questionnaire.questionnaireId,
        questionnaireVersion: input.questionnaire.questionnaireVersion,
        questionnaireChecksum: input.questionnaire.questionnaireChecksum,
        proposalVersion: input.questionnaire.proposalVersion,
        questionnaire: input.questionnaire,
        response: input.response,
        documents: [],
        draftRevision: 1,
        status: "active",
        lastSavedAt: input.now,
        expiresAt: input.expiresAt,
      });
      return { draft: toRecord(created.toObject() as unknown as DraftRow), created: true };
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      const existing = await VendorSubmissionDraft.findOne({
        ...scopeFilter(input),
        status: "active",
      }).lean<DraftRow>();
      if (!existing) throw error;
      return { draft: toRecord(existing), created: false };
    }
  },

  async revisionSubmissionIsAuthorized(input) {
    const submission = await VendorSubmission.findOne({
      _id: input.submissionId,
      organizationId: input.organizationId,
      proposalId: input.proposalId,
    })
      .select("primaryEmail")
      .lean<{ primaryEmail?: string }>();
    return Boolean(
      submission?.primaryEmail
      && recipientHash(submission.primaryEmail) === input.grantSubjectHash,
    );
  },

  async updateActive(input) {
    const row = await VendorSubmissionDraft.findOneAndUpdate(
      {
        _id: input.draftId,
        ...scopeFilter(input),
        status: "active",
        draftRevision: input.expectedRevision,
        expiresAt: { $gt: input.now },
      },
      {
        $set: {
          response: input.response,
          documents: input.documents,
          lastSavedAt: input.now,
          expiresAt: input.expiresAt,
        },
        $inc: { draftRevision: 1 },
      },
      { new: true, runValidators: true },
    ).lean<DraftRow>();
    return row ? toRecord(row) : null;
  },

  async abandon(input) {
    const row = await VendorSubmissionDraft.findOneAndUpdate(
      {
        _id: input.draftId,
        ...scopeFilter(input),
        status: "active",
        draftRevision: input.expectedRevision,
      },
      {
        $set: {
          status: "abandoned",
          abandonedAt: input.now,
          lastSavedAt: input.now,
        },
        $inc: { draftRevision: 1 },
      },
      { new: true, runValidators: true },
    ).lean<DraftRow>();
    return row ? toRecord(row) : null;
  },

  async listCleanupCandidates(now, limit) {
    const rows = await VendorSubmissionDraft.find({
      cleanupCompletedAt: null,
      $or: [
        { status: "abandoned" },
        { status: "active", expiresAt: { $lte: now } },
      ],
    })
      .sort({ expiresAt: 1 })
      .limit(limit)
      .lean<DraftRow[]>();
    return rows.map(toRecord);
  },

  async markExpiredAbandoned(draftId, now) {
    await VendorSubmissionDraft.updateOne(
      { _id: draftId, status: "active", expiresAt: { $lte: now } },
      { $set: { status: "abandoned", abandonedAt: now } },
    );
  },

  async documentIsSubmitted(organizationId, documentId) {
    return Boolean(await VendorSubmissionVersion.exists({
      organizationId,
      "documents.documentId": documentId,
    }));
  },

  async markDocumentDeleted(draftId, documentId, deletedAt) {
    await VendorSubmissionDraft.updateOne(
      { _id: draftId, "documents.documentId": documentId },
      { $set: { "documents.$.objectDeletedAt": deletedAt } },
    );
  },

  async markCleanupComplete(draftId, completedAt) {
    await VendorSubmissionDraft.updateOne(
      { _id: draftId },
      { $set: { cleanupCompletedAt: completedAt } },
    );
  },
};
