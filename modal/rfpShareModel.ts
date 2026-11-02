import mongoose, { Document, Schema } from "mongoose";

export const SHARE_PERMISSIONS = ["view", "edit"] as const;

export interface IRfpShare extends Document {
  organizationId: mongoose.Types.ObjectId;
  proposalId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  permission: (typeof SHARE_PERMISSIONS)[number];
  grantedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

// A proposal shared with one member of its organization. A deactivated member's shares are kept
// (for the record and for reactivation) but grant nothing: actor lookups run for active members only.
const rfpShareSchema = new Schema<IRfpShare>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    proposalId: { type: Schema.Types.ObjectId, ref: "Proposal", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    permission: { type: String, enum: SHARE_PERMISSIONS, required: true },
    grantedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

rfpShareSchema.index({ proposalId: 1, userId: 1 }, { unique: true });
rfpShareSchema.index({ organizationId: 1, userId: 1 });

const RfpShare = mongoose.model<IRfpShare>("RfpShare", rfpShareSchema);
export default RfpShare;
