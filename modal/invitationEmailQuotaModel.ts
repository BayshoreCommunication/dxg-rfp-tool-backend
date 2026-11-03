import mongoose, { Document, Schema } from "mongoose";

// Invitation emails an organization has queued on one UTC day (ORG-203 send cap).
export interface IInvitationEmailQuota extends Document {
  organizationId: mongoose.Types.ObjectId;
  // YYYY-MM-DD, UTC.
  day: string;
  count: number;
  expiresAt: Date;
}

const invitationEmailQuotaSchema = new Schema<IInvitationEmailQuota>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    day: { type: String, required: true },
    count: { type: Number, required: true, min: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

invitationEmailQuotaSchema.index({ organizationId: 1, day: 1 }, { unique: true });
// A day's counter is only read on that day; drop it once it's well past.
invitationEmailQuotaSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const InvitationEmailQuota = mongoose.model<IInvitationEmailQuota>("InvitationEmailQuota", invitationEmailQuotaSchema);
export default InvitationEmailQuota;
