import mongoose, { Schema, type Document, type Query } from "mongoose";
import type { VendorResponseQuestionnaireV1 } from "../contracts/generated/vendor-response-questionnaire-v1";
import type { VendorResponseV1 } from "../contracts/generated/vendor-response-v1";

type VendorDraftDocument = {
  documentId: string;
  sourceId: string;
  purposeId: string;
  scopeType: "proposal" | "room" | "crew_member" | "reference";
  scopeId?: string | null;
  name: string;
  url: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  scanStatus: "clean" | "skipped";
  inheritedFromVersionId?: mongoose.Types.ObjectId | null;
  status: "active" | "retired";
  uploadedAt: Date;
  retiredAt?: Date | null;
  objectDeletedAt?: Date | null;
};

export interface IVendorSubmissionDraft extends Document {
  organizationId: mongoose.Types.ObjectId;
  proposalId: mongoose.Types.ObjectId;
  grantId: mongoose.Types.ObjectId;
  grantSubjectHash: string;
  submissionId?: mongoose.Types.ObjectId | null;
  questionnaireId: string;
  questionnaireVersion: number;
  questionnaireChecksum: string;
  proposalVersion: number;
  questionnaire: VendorResponseQuestionnaireV1;
  response: VendorResponseV1;
  documents: VendorDraftDocument[];
  draftRevision: number;
  status: "active" | "submitted" | "abandoned";
  lastSavedAt: Date;
  expiresAt: Date;
  abandonedAt?: Date | null;
  cleanupCompletedAt?: Date | null;
  finalizationKeyHash?: string | null;
  finalizationStartedAt?: Date | null;
  submittedVersionId?: mongoose.Types.ObjectId | null;
  submittedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const checksum = {
  type: String,
  required: true,
  validate: {
    validator: (value: string) => /^[0-9a-f]{64}$/.test(value),
    message: "Questionnaire checksum must be SHA-256",
  },
} as const;

const draftDocumentSchema = new Schema<VendorDraftDocument>(
  {
    documentId: { type: String, required: true },
    sourceId: { type: String, required: true },
    purposeId: { type: String, required: true },
    scopeType: {
      type: String,
      enum: ["proposal", "room", "crew_member", "reference"],
      required: true,
    },
    scopeId: { type: String, default: null },
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    objectKey: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 1 },
    sha256: checksum,
    scanStatus: { type: String, enum: ["clean", "skipped"], required: true },
    inheritedFromVersionId: {
      type: Schema.Types.ObjectId,
      ref: "VendorSubmissionVersion",
      default: null,
    },
    status: { type: String, enum: ["active", "retired"], required: true },
    uploadedAt: { type: Date, required: true },
    retiredAt: { type: Date, default: null },
    objectDeletedAt: { type: Date, default: null },
  },
  { _id: false },
);

const vendorSubmissionDraftSchema = new Schema<IVendorSubmissionDraft>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
      immutable: true,
    },
    proposalId: {
      type: Schema.Types.ObjectId,
      ref: "Proposal",
      required: true,
      index: true,
      immutable: true,
    },
    grantId: {
      type: Schema.Types.ObjectId,
      ref: "PublicAccessGrant",
      required: true,
      index: true,
      immutable: true,
    },
    grantSubjectHash: {
      type: String,
      required: true,
      immutable: true,
      validate: {
        validator: (value: string) => /^[0-9a-f]{64}$/.test(value),
        message: "Grant subject hash must be SHA-256",
      },
    },
    submissionId: {
      type: Schema.Types.ObjectId,
      ref: "VendorSubmission",
      default: null,
      immutable: true,
    },
    questionnaireId: { type: String, required: true, immutable: true },
    questionnaireVersion: { type: Number, required: true, min: 1, immutable: true },
    questionnaireChecksum: { ...checksum, immutable: true },
    proposalVersion: { type: Number, required: true, min: 1, immutable: true },
    questionnaire: { type: Schema.Types.Mixed, required: true, immutable: true },
    response: { type: Schema.Types.Mixed, required: true },
    documents: { type: [draftDocumentSchema], default: [] },
    draftRevision: { type: Number, required: true, min: 1, default: 1 },
    status: {
      type: String,
      enum: ["active", "submitted", "abandoned"],
      required: true,
      default: "active",
      index: true,
    },
    lastSavedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: true },
    abandonedAt: { type: Date, default: null },
    cleanupCompletedAt: { type: Date, default: null },
    finalizationKeyHash: {
      type: String,
      default: null,
      validate: {
        validator: (value: string | null) =>
          value === null || /^[0-9a-f]{64}$/.test(value),
        message: "Finalization key hash must be SHA-256",
      },
    },
    finalizationStartedAt: { type: Date, default: null },
    submittedVersionId: {
      type: Schema.Types.ObjectId,
      ref: "VendorSubmissionVersion",
      default: null,
    },
    submittedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

vendorSubmissionDraftSchema.index(
  { organizationId: 1, proposalId: 1, grantId: 1 },
  { unique: true, partialFilterExpression: { status: "active" } },
);
vendorSubmissionDraftSchema.index({ status: 1, expiresAt: 1, cleanupCompletedAt: 1 });
vendorSubmissionDraftSchema.index({ submissionId: 1 }, { sparse: true });
vendorSubmissionDraftSchema.index({ submittedVersionId: 1 }, { sparse: true });

const pinnedFields = new Set([
  "organizationId",
  "proposalId",
  "grantId",
  "grantSubjectHash",
  "submissionId",
  "questionnaireId",
  "questionnaireVersion",
  "questionnaireChecksum",
  "proposalVersion",
  "questionnaire",
]);

vendorSubmissionDraftSchema.pre("save", function preservePinnedDraftSnapshot() {
  if (
    !this.isNew
    && [...pinnedFields].some((field) => this.isModified(field))
  ) {
    throw new Error("Vendor submission draft questionnaire and grant scope are immutable");
  }
});

vendorSubmissionDraftSchema.pre(
  ["updateOne", "updateMany", "findOneAndUpdate"],
  function preservePinnedDraftFields(this: Query<unknown, IVendorSubmissionDraft>) {
    const update = this.getUpdate() as Record<string, unknown> | null;
    const roots = [
      ...Object.keys(update ?? {}).filter((key) => !key.startsWith("$")),
      ...Object.values(update ?? {})
        .filter((value) => value && typeof value === "object")
        .flatMap((value) => Object.keys(value as Record<string, unknown>)),
    ].map((key) => key.split(".")[0]);
    if (roots.some((key) => pinnedFields.has(key))) {
      throw new Error("Vendor submission draft questionnaire and grant scope are immutable");
    }
  },
);

vendorSubmissionDraftSchema.pre(
  ["replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"],
  function rejectDraftReplacement() {
    throw new Error("Vendor submission drafts must retain their audit record");
  },
);

const VendorSubmissionDraft =
  mongoose.models.VendorSubmissionDraft
  ?? mongoose.model<IVendorSubmissionDraft>(
    "VendorSubmissionDraft",
    vendorSubmissionDraftSchema,
  );

export default VendorSubmissionDraft;
