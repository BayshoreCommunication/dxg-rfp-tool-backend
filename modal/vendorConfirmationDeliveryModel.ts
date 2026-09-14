import mongoose, { Schema, type Document } from "mongoose";

export type VendorConfirmationDeliveryStatus = "accepted" | "failed";

export interface IVendorConfirmationDelivery extends Document {
  organizationId: mongoose.Types.ObjectId;
  proposalId: mongoose.Types.ObjectId;
  submissionId: mongoose.Types.ObjectId;
  versionId: mongoose.Types.ObjectId;
  status: VendorConfirmationDeliveryStatus;
  attemptedAt: Date;
  acceptedAt?: Date | null;
  safeErrorCode?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const vendorConfirmationDeliverySchema =
  new Schema<IVendorConfirmationDelivery>(
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
      versionId: {
        type: Schema.Types.ObjectId,
        ref: "VendorSubmissionVersion",
        required: true,
        unique: true,
      },
      status: {
        type: String,
        enum: ["accepted", "failed"],
        required: true,
      },
      attemptedAt: { type: Date, required: true },
      acceptedAt: { type: Date, default: null },
      safeErrorCode: { type: String, default: null },
    },
    { timestamps: true },
  );

vendorConfirmationDeliverySchema.index({
  organizationId: 1,
  proposalId: 1,
  versionId: 1,
});

const VendorConfirmationDelivery =
  mongoose.models.VendorConfirmationDelivery
  || mongoose.model<IVendorConfirmationDelivery>(
    "VendorConfirmationDelivery",
    vendorConfirmationDeliverySchema,
  );

export default VendorConfirmationDelivery;
