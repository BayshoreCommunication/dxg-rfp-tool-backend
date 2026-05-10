import mongoose, { Schema } from "mongoose";

const vendorDocumentSchema = new Schema(
  {
    name: { type: String, trim: true },
    url: { type: String, trim: true },
  },
  { _id: false },
);

const vendorResponseSchema = new Schema(
  {
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
  },
  { timestamps: true },
);

vendorResponseSchema.index({ proposalOwnerId: 1, createdAt: -1 });
vendorResponseSchema.index({ proposalOwnerId: 1, isRead: 1 });

const VendorResponse = mongoose.model("VendorResponse", vendorResponseSchema);
export default VendorResponse;
