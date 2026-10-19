import mongoose, { Document, Schema } from "mongoose";

export const SUPPORT_ATTACHMENT_STATUSES = ["pending", "attached"] as const;
export type SupportAttachmentStatus = (typeof SUPPORT_ATTACHMENT_STATUSES)[number];

/**
 * One uploaded file. It is created `pending` by the upload route and bound
 * to a message when the uploader sends it; a pending upload can only be
 * attached by the same uploader inside the same organization, so a client
 * can never reference another tenant's object.
 */
export interface ISupportAttachment extends Document {
  organizationId: mongoose.Types.ObjectId;
  uploaderUserId: mongoose.Types.ObjectId;
  attachmentId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  objectKey: string;
  status: SupportAttachmentStatus;
  ticketId: mongoose.Types.ObjectId | null;
  messageId: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const supportAttachmentSchema = new Schema<ISupportAttachment>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    uploaderUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    attachmentId: { type: String, required: true, unique: true },
    fileName: { type: String, required: true, maxlength: 255 },
    mimeType: { type: String, required: true, maxlength: 120 },
    sizeBytes: { type: Number, required: true },
    objectKey: { type: String, required: true },
    status: { type: String, enum: SUPPORT_ATTACHMENT_STATUSES, required: true, default: "pending" },
    ticketId: { type: Schema.Types.ObjectId, ref: "SupportTicket", default: null },
    messageId: { type: Schema.Types.ObjectId, ref: "SupportMessage", default: null },
  },
  { timestamps: true },
);

supportAttachmentSchema.index({ organizationId: 1, uploaderUserId: 1, status: 1, createdAt: -1 });

const SupportAttachment = mongoose.model<ISupportAttachment>("SupportAttachment", supportAttachmentSchema);

export default SupportAttachment;
