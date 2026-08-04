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
    emailTrackingId: { type: String, default: null, index: true, sparse: true },
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
