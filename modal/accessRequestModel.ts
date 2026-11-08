import mongoose, { Document, Schema } from "mongoose";

/* ORG-306: someone who signs up with an email on an organization's verified domain asks to
   join it instead of creating a separate organization. Approving (by an Owner or Admin, or
   automatically when the organization auto-approves its domain) sends them an ordinary
   invitation, so joining goes through the accept page and its email check. No account exists
   until then. One pending request per organization and email. */
export const ACCESS_REQUEST_STATUSES = ["pending", "approved", "denied"] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

export interface IAccessRequest extends Document {
  organizationId: mongoose.Types.ObjectId;
  email: string;
  name: string;
  status: AccessRequestStatus;
  autoApproved: boolean;
  decidedBy: mongoose.Types.ObjectId | null;
  decidedAt: Date | null;
  invitationId: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const accessRequestSchema = new Schema<IAccessRequest>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 320 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    status: { type: String, enum: ACCESS_REQUEST_STATUSES, default: "pending", required: true },
    autoApproved: { type: Boolean, default: false },
    decidedBy: { type: Schema.Types.ObjectId, default: null },
    decidedAt: { type: Date, default: null },
    invitationId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true },
);

accessRequestSchema.index(
  { organizationId: 1, email: 1 },
  { unique: true, name: "one_pending_request_per_email", partialFilterExpression: { status: "pending" } },
);
accessRequestSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

const AccessRequest = mongoose.model<IAccessRequest>("AccessRequest", accessRequestSchema);
export default AccessRequest;
