import mongoose, { Schema, type Document } from "mongoose";

export type VendorSubmissionStatus = "active" | "withdrawn" | "archived";

export interface IVendorSubmission extends Document {
  organizationId: mongoose.Types.ObjectId;
  proposalId: mongoose.Types.ObjectId;
  proposalOwnerId: mongoose.Types.ObjectId;
  proposalTitle: string;
  vendorIdentityKey: string;
  vendorName: string;
  primaryEmail: string;
  trackingIds: string[];
  legacyVendorResponseId: mongoose.Types.ObjectId;
  currentVersionId?: mongoose.Types.ObjectId | null;
  currentVersionNumber: number;
  status: VendorSubmissionStatus;
  isRead: boolean;
  lastSubmittedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const vendorSubmissionSchema = new Schema<IVendorSubmission>(
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
    proposalOwnerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    proposalTitle: { type: String, trim: true, default: "" },
    vendorIdentityKey: { type: String, required: true, trim: true },
    vendorName: { type: String, required: true, trim: true },
    primaryEmail: { type: String, required: true, trim: true, lowercase: true },
    trackingIds: { type: [String], default: [] },
    legacyVendorResponseId: {
      type: Schema.Types.ObjectId,
      ref: "VendorResponse",
      required: true,
      unique: true,
    },
    currentVersionId: {
      type: Schema.Types.ObjectId,
      ref: "VendorSubmissionVersion",
      default: null,
    },
    currentVersionNumber: { type: Number, min: 0, default: 0 },
    status: {
      type: String,
      enum: ["active", "withdrawn", "archived"],
      default: "active",
      index: true,
    },
    isRead: { type: Boolean, default: false },
    lastSubmittedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

vendorSubmissionSchema.index(
  { organizationId: 1, proposalId: 1, vendorIdentityKey: 1 },
  { unique: true },
);
vendorSubmissionSchema.index({ proposalId: 1, primaryEmail: 1 });
vendorSubmissionSchema.index({ trackingIds: 1 }, { sparse: true });
vendorSubmissionSchema.index({ proposalOwnerId: 1, lastSubmittedAt: -1 });

const VendorSubmission = mongoose.model<IVendorSubmission>(
  "VendorSubmission",
  vendorSubmissionSchema,
);

export default VendorSubmission;
