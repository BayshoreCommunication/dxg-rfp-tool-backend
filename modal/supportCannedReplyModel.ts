import mongoose, { Document, Schema } from "mongoose";

export interface ISupportCannedReply extends Document {
  organizationId: mongoose.Types.ObjectId;
  title: string;
  body: string;
  createdByUserId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const supportCannedReplySchema = new Schema<ISupportCannedReply>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, required: true, maxlength: 5000 },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

supportCannedReplySchema.index({ organizationId: 1, title: 1 });

const SupportCannedReply = mongoose.model<ISupportCannedReply>(
  "SupportCannedReply",
  supportCannedReplySchema,
);

export default SupportCannedReply;
