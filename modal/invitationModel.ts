import mongoose, { Document, Schema } from "mongoose";
import type { DeliveryKind, DeliveryState } from "../src/modules/invitations/domain/ports";
import { INVITABLE_ROLES, INVITATION_STATUSES, type InvitableRole, type InvitationStatus } from "../src/modules/invitations/domain/invitationRules";

export interface IInvitation extends Document {
  organizationId: mongoose.Types.ObjectId;
  email: string;
  role: InvitableRole;
  teamId: mongoose.Types.ObjectId | null;
  invitedBy: mongoose.Types.ObjectId;
  status: InvitationStatus;
  // SHA-256 of the current link token. The raw token only ever exists in the email.
  tokenHash: string | null;
  // Hashes of links replaced by a resend or reminder, so an old link gets a distinct error.
  previousTokenHashes: string[];
  tokenIssuedAt: Date | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedBy: mongoose.Types.ObjectId | null;
  revokedAt: Date | null;
  revokedBy: mongoose.Types.ObjectId | null;
  expiredAt: Date | null;
  // Delivery of the current email. Each attempt mints a new link (see dispatchInvitations).
  delivery: {
    state: DeliveryState;
    kind: DeliveryKind;
    attempts: number;
    leaseUntil: Date | null;
    lastAttemptAt: Date | null;
    sentAt: Date | null;
  };
  // Set when the day-six reminder is queued, so it goes out once per link lifetime.
  reminderQueuedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const invitationSchema = new Schema<IInvitation>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    role: { type: String, enum: INVITABLE_ROLES, required: true },
    teamId: { type: Schema.Types.ObjectId, default: null },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: INVITATION_STATUSES, default: "pending", required: true },
    tokenHash: { type: String, default: null },
    previousTokenHashes: { type: [String], default: [] },
    tokenIssuedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    acceptedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    expiredAt: { type: Date, default: null },
    delivery: {
      state: { type: String, enum: ["pending", "sending", "sent", "failed"], default: "pending" },
      kind: { type: String, enum: ["invite", "resend", "reminder"], default: "invite" },
      attempts: { type: Number, min: 0, default: 0 },
      leaseUntil: { type: Date, default: null },
      lastAttemptAt: { type: Date, default: null },
      sentAt: { type: Date, default: null },
    },
    reminderQueuedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Hashes stay after accept and revoke so a reused or revoked link is told apart from a wrong one.
invitationSchema.index({ tokenHash: 1 }, { unique: true, partialFilterExpression: { tokenHash: { $type: "string" } } });
invitationSchema.index({ previousTokenHashes: 1 });
// One open invitation per email per organization; a second invite is a resend.
invitationSchema.index(
  { organizationId: 1, email: 1 },
  { unique: true, name: "one_pending_invitation_per_email", partialFilterExpression: { status: "pending" } },
);
invitationSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
invitationSchema.index({ status: 1, expiresAt: 1 });
invitationSchema.index({ status: 1, "delivery.state": 1 });

const Invitation = mongoose.model<IInvitation>("Invitation", invitationSchema);
export default Invitation;
