import mongoose, { Document, Schema } from "mongoose";

export const SUPPORT_MESSAGE_KINDS = ["message", "internal_note", "system"] as const;
export const SUPPORT_AUTHOR_ROLES = ["customer", "agent", "system"] as const;

export type SupportMessageKind = (typeof SUPPORT_MESSAGE_KINDS)[number];
export type SupportAuthorRole = (typeof SUPPORT_AUTHOR_ROLES)[number];

export interface ISupportAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  objectKey: string;
}

export interface ISupportMessage extends Document {
  organizationId: mongoose.Types.ObjectId;
  ticketId: mongoose.Types.ObjectId;
  authorUserId: mongoose.Types.ObjectId | null;
  authorRole: SupportAuthorRole;
  kind: SupportMessageKind;
  body: string;
  attachments: ISupportAttachment[];
  createdAt: Date;
  updatedAt: Date;
}

const attachmentSchema = new Schema<ISupportAttachment>(
  {
    id: { type: String, required: true },
    fileName: { type: String, required: true, maxlength: 255 },
    mimeType: { type: String, required: true, maxlength: 120 },
    sizeBytes: { type: Number, required: true },
    objectKey: { type: String, required: true },
  },
  { _id: false },
);

const supportMessageSchema = new Schema<ISupportMessage>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    ticketId: { type: Schema.Types.ObjectId, ref: "SupportTicket", required: true },
    authorUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    authorRole: { type: String, enum: SUPPORT_AUTHOR_ROLES, required: true },
    kind: { type: String, enum: SUPPORT_MESSAGE_KINDS, required: true, default: "message" },
    body: { type: String, required: true, maxlength: 5000 },
    attachments: { type: [attachmentSchema], default: [] },
  },
  { timestamps: true },
);

supportMessageSchema.index({ organizationId: 1, ticketId: 1, createdAt: 1 });

const SupportMessage = mongoose.model<ISupportMessage>("SupportMessage", supportMessageSchema);

export default SupportMessage;
