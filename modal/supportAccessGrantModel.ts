import mongoose, { Document, Schema } from "mongoose";

export const SUPPORT_GRANT_MAX_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ISupportAccessGrant extends Document {
  organizationId: mongoose.Types.ObjectId;
  /** null grants the whole organization; otherwise exactly this RFP. */
  proposalId: mongoose.Types.ObjectId | null;
  grantedBy: mongoose.Types.ObjectId;
  reason: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedBy: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

// ORG-404: an organization's Owner or Admin lets RFPilot Support (DXG staff signed in to the
// admin app) read one RFP or the whole organization for a limited time. A grant is to RFPilot
// Support as a whole, not to a named agent: customers never see the staff list. It is never
// deleted, so past grants and the activity under them stay on the record.
const supportAccessGrantSchema = new Schema<ISupportAccessGrant>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    proposalId: { type: Schema.Types.ObjectId, ref: "Proposal", default: null },
    grantedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reason: { type: String, trim: true, maxlength: 500, default: null },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

// The 30-day ceiling holds whatever the caller computed.
supportAccessGrantSchema.pre("validate", function capExpiry(next) {
  const start = (this.createdAt ?? new Date()).getTime();
  if (this.expiresAt && this.expiresAt.getTime() > start + SUPPORT_GRANT_MAX_DAYS * DAY_MS + 60_000) {
    return next(new Error(`A support access grant can last at most ${SUPPORT_GRANT_MAX_DAYS} days`));
  }
  next();
});

supportAccessGrantSchema.index({ organizationId: 1, createdAt: -1 });
// The agent-side "granted to me" list and every access check: active grants only.
supportAccessGrantSchema.index({ revokedAt: 1, expiresAt: 1 });

const SupportAccessGrant = mongoose.model<ISupportAccessGrant>("SupportAccessGrant", supportAccessGrantSchema);
export default SupportAccessGrant;
