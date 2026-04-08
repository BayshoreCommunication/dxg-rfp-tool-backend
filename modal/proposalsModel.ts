import mongoose, { Document, Schema } from "mongoose";

export interface IProposal extends Document {
  userId?: mongoose.Types.ObjectId;
  status: "draft" | "submitted" | "reviewed" | "approved" | "rejected";
  isActive: boolean;
  isFavorite: boolean;
  isAccepted: boolean;
  isOpen: boolean;
  viewsCount: number;
  templateId: "template-one" | "template-two";
  event: {
    eventName: string;
    startDate?: string;
    endDate?: string;
    venue?: string;
    attendees?: string;
    eventFormat?: "In-Person" | "Hybrid" | "Virtual";
    eventType?: {
      eventType?: string;
      eventTypeOther?: string;
    };
  };
  roomByRoom?: Record<string, unknown>;
  production?: Record<string, unknown>;
  venue?: Record<string, unknown>;
  uploads?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  contact: {
    contactFirstName: string;
    contactLastName: string;
    contactTitle?: string;
    contactOrganization?: string;
    contactEmail: string;
    contactPhone: string;
    anythingElse?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const proposalSchema = new Schema<IProposal>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },

    status: {
      type: String,
      enum: ["draft", "submitted", "reviewed", "approved", "rejected"],
      default: "submitted",
    },
    isActive: { type: Boolean, default: true },
    isFavorite: { type: Boolean, default: false },
    isAccepted: { type: Boolean, default: false },
    isOpen: { type: Boolean, default: true },
    viewsCount: { type: Number, default: 0, min: 0 },
    templateId: {
      type: String,
      enum: ["template-one", "template-two"],
      default: "template-one",
    },

    event: {
      eventName: {
        type: String,
        required: [true, "Event name is required"],
        trim: true,
      },
      startDate: { type: String, trim: true },
      endDate: { type: String, trim: true },
      venue: { type: String, trim: true },
      attendees: { type: String, trim: true },
      eventFormat: { type: String, enum: ["In-Person", "Hybrid", "Virtual"] },
      eventType: {
        eventType: { type: String, trim: true },
        eventTypeOther: { type: String, trim: true },
      },
    },

    roomByRoom: { type: Schema.Types.Mixed, default: {} },
    production: { type: Schema.Types.Mixed, default: {} },
    venue: { type: Schema.Types.Mixed, default: {} },
    uploads: { type: Schema.Types.Mixed, default: {} },
    budget: { type: Schema.Types.Mixed, default: {} },

    contact: {
      contactFirstName: {
        type: String,
        required: [true, "First name is required"],
        trim: true,
      },
      contactLastName: {
        type: String,
        required: [true, "Last name is required"],
        trim: true,
      },
      contactTitle: { type: String, trim: true },
      contactOrganization: { type: String, trim: true },
      contactEmail: {
        type: String,
        required: [true, "Contact email is required"],
        trim: true,
        lowercase: true,
      },
      contactPhone: {
        type: String,
        required: [true, "Contact phone is required"],
        trim: true,
      },
      anythingElse: { type: String, trim: true },
    },
  },
  {
    timestamps: true,
  }
);

proposalSchema.index({ userId: 1, createdAt: -1 });
proposalSchema.index({ status: 1 });
proposalSchema.index({ "contact.contactEmail": 1 });
proposalSchema.index({ "event.eventName": 1 });

const Proposal = mongoose.model<IProposal>("Proposal", proposalSchema);

export default Proposal;
