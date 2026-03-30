import mongoose, { Document, Schema } from "mongoose";

export interface IEmailRecipient {
  email: string;
  trackingId: string;
  sentAt?: Date;
  openedAt?: Date;
  clickedAt?: Date;
  status: "sent" | "failed";
  errorMessage?: string;
}

export interface IEmailCampaign extends Document {
  userId: mongoose.Types.ObjectId;
  proposalId: mongoose.Types.ObjectId;
  proposalTitle: string;
  proposalSlug: string;
  subject: string;
  message: string;
  recipients: IEmailRecipient[];
  totalRecipients: number;
  sentCount: number;
  openedCount: number;
  clickedCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const emailRecipientSchema = new Schema<IEmailRecipient>(
  {
    email: {
      type: String,
      required: [true, "Recipient email is required"],
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Please provide a valid recipient email"],
    },
    trackingId: {
      type: String,
      required: [true, "Tracking id is required"],
      trim: true,
      unique: true,
    },
    sentAt: { type: Date },
    openedAt: { type: Date },
    clickedAt: { type: Date },
    status: {
      type: String,
      enum: ["sent", "failed"],
      default: "sent",
    },
    errorMessage: { type: String, trim: true },
  },
  { _id: false }
);

const emailCampaignSchema = new Schema<IEmailCampaign>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User id is required"],
      index: true,
    },
    proposalId: {
      type: Schema.Types.ObjectId,
      ref: "Proposal",
      required: [true, "Proposal id is required"],
      index: true,
    },
    proposalTitle: {
      type: String,
      required: [true, "Proposal title is required"],
      trim: true,
    },
    proposalSlug: {
      type: String,
      required: [true, "Proposal slug is required"],
      trim: true,
    },
    subject: {
      type: String,
      required: [true, "Subject is required"],
      trim: true,
    },
    message: {
      type: String,
      required: [true, "Message is required"],
      trim: true,
    },
    recipients: {
      type: [emailRecipientSchema],
      default: [],
    },
    totalRecipients: { type: Number, default: 0, min: 0 },
    sentCount: { type: Number, default: 0, min: 0 },
    openedCount: { type: Number, default: 0, min: 0 },
    clickedCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

emailCampaignSchema.index({ userId: 1, createdAt: -1 });
emailCampaignSchema.index({ userId: 1, proposalId: 1, createdAt: -1 });
emailCampaignSchema.index({ "recipients.trackingId": 1 });

const EmailCampaign = mongoose.model<IEmailCampaign>(
  "EmailCampaign",
  emailCampaignSchema
);

export default EmailCampaign;
