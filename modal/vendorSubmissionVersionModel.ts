import mongoose, { Schema, type Document } from "mongoose";

export type VendorSubmissionVersionReason =
  | "initial"
  | "vendor_revision"
  | "clarification_response"
  | "bafo"
  | "administrative_correction"
  | "legacy_backfill";

export type VendorSubmissionDocument = {
  documentId: string;
  sourceId: string;
  name: string;
  url: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number | null;
  sha256: string | null;
  scanStatus: "clean" | "skipped" | "legacy_unknown";
  inheritedFromVersionId?: mongoose.Types.ObjectId | null;
};

export interface IVendorSubmissionVersion extends Document {
  organizationId: mongoose.Types.ObjectId;
  proposalId: mongoose.Types.ObjectId;
  submissionId: mongoose.Types.ObjectId;
  legacyVendorResponseId: mongoose.Types.ObjectId;
  versionNumber: number;
  parentVersionId?: mongoose.Types.ObjectId | null;
  reason: VendorSubmissionVersionReason;
  vendorName: string;
  submittedBy: string;
  email: string;
  message: string;
  documents: VendorSubmissionDocument[];
  manifestChecksum: string;
  idempotencyKey: string;
  sourceSystem: "public_portal" | "planner_upload" | "legacy_migration" | "api";
  receivedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const vendorSubmissionDocumentSchema = new Schema<VendorSubmissionDocument>(
  {
    documentId: { type: String, required: true },
    sourceId: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    objectKey: { type: String, required: true, trim: true },
    mimeType: { type: String, default: "application/octet-stream" },
    sizeBytes: { type: Number, min: 0, default: null },
    sha256: {
      type: String,
      default: null,
      validate: {
        validator: (value: string | null) => value === null || /^[0-9a-f]{64}$/.test(value),
        message: "Document checksum must be SHA-256",
      },
    },
    scanStatus: {
      type: String,
      enum: ["clean", "skipped", "legacy_unknown"],
      required: true,
    },
    inheritedFromVersionId: {
      type: Schema.Types.ObjectId,
      ref: "VendorSubmissionVersion",
      default: null,
    },
  },
  { _id: false },
);

const vendorSubmissionVersionSchema = new Schema<IVendorSubmissionVersion>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    proposalId: {
      type: Schema.Types.ObjectId,
      ref: "Proposal",
      required: true,
      index: true,
    },
    submissionId: {
      type: Schema.Types.ObjectId,
      ref: "VendorSubmission",
      required: true,
      index: true,
    },
    legacyVendorResponseId: {
      type: Schema.Types.ObjectId,
      ref: "VendorResponse",
      required: true,
      index: true,
    },
    versionNumber: { type: Number, required: true, min: 1 },
    parentVersionId: {
      type: Schema.Types.ObjectId,
      ref: "VendorSubmissionVersion",
      default: null,
    },
    reason: {
      type: String,
      enum: [
        "initial",
        "vendor_revision",
        "clarification_response",
        "bafo",
        "administrative_correction",
        "legacy_backfill",
      ],
      required: true,
    },
    vendorName: { type: String, required: true, trim: true },
    submittedBy: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    message: { type: String, trim: true, default: "" },
    documents: { type: [vendorSubmissionDocumentSchema], default: [] },
    manifestChecksum: {
      type: String,
      required: true,
      validate: {
        validator: (value: string) => /^[0-9a-f]{64}$/.test(value),
        message: "Manifest checksum must be SHA-256",
      },
    },
    idempotencyKey: { type: String, required: true, trim: true },
    sourceSystem: {
      type: String,
      enum: ["public_portal", "planner_upload", "legacy_migration", "api"],
      required: true,
    },
    receivedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
);

vendorSubmissionVersionSchema.index(
  { submissionId: 1, versionNumber: 1 },
  { unique: true },
);
vendorSubmissionVersionSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  { unique: true },
);
vendorSubmissionVersionSchema.index({ proposalId: 1, receivedAt: -1 });

vendorSubmissionVersionSchema.pre("save", function rejectExistingVersionSave() {
  if (!this.isNew) {
    throw new Error("Vendor submission versions are immutable");
  }
});
vendorSubmissionVersionSchema.pre(
  ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne"],
  function rejectVersionUpdate() {
    throw new Error("Vendor submission versions are immutable");
  },
);

const VendorSubmissionVersion = mongoose.model<IVendorSubmissionVersion>(
  "VendorSubmissionVersion",
  vendorSubmissionVersionSchema,
);

export default VendorSubmissionVersion;
