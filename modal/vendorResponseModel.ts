import mongoose, { Schema } from "mongoose";

const vendorDocumentSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      index: true,
    },
    name: { type: String, trim: true },
    url: { type: String, trim: true },
    documentId: { type: String, trim: true },
    sourceId: { type: String, trim: true },
    objectKey: { type: String, trim: true },
    mimeType: { type: String, trim: true },
    sizeBytes: { type: Number, min: 0, default: null },
    sha256: { type: String, trim: true, default: null },
    scanStatus: { type: String, trim: true },
  },
  { _id: false },
);

const vendorResponseSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: [true, "Organization id is required"],
      index: true,
    },
    proposalId: {
      type: Schema.Types.ObjectId,
      ref: "Proposal",
      required: [true, "Proposal id is required"],
      index: true,
    },
    proposalOwnerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Proposal owner id is required"],
      index: true,
    },
    proposalTitle: { type: String, trim: true, default: "" },
    vendorName: {
      type: String,
      required: [true, "Vendor name is required"],
      trim: true,
    },
    submittedBy: {
      type: String,
      required: [true, "Submitted by is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      trim: true,
      lowercase: true,
    },
    message: { type: String, trim: true, default: "" },
    documents: { type: [vendorDocumentSchema], default: [] },
    isRead: { type: Boolean, default: false },
    emailTrackingId: { type: String, default: null },
    submissionId: {
      type: Schema.Types.ObjectId,
      ref: "VendorSubmission",
      default: null,
      index: true,
      sparse: true,
    },
    currentVersionId: {
      type: Schema.Types.ObjectId,
      ref: "VendorSubmissionVersion",
      default: null,
      index: true,
      sparse: true,
    },
    currentVersionNumber: { type: Number, min: 0, default: 0 },
    versionReason: { type: String, trim: true, default: null },
    versionReceivedAt: { type: Date, default: null },
    manifestChecksum: { type: String, trim: true, default: null },
  },
  { timestamps: true },
);

vendorResponseSchema.index({ proposalOwnerId: 1, createdAt: -1 });
vendorResponseSchema.index({ organizationId: 1, proposalOwnerId: 1, createdAt: -1 });
vendorResponseSchema.index({ proposalOwnerId: 1, isRead: 1 });
vendorResponseSchema.index({ proposalId: 1, email: 1 }, { unique: true });
vendorResponseSchema.index({ emailTrackingId: 1 }, { unique: true, sparse: true });

const VendorResponse = mongoose.model("VendorResponse", vendorResponseSchema);
export default VendorResponse;
