import mongoose, { Document, Schema } from "mongoose";

export interface IProposal extends Document {
  userId?: mongoose.Types.ObjectId;
  status: "unsubmitted" | "submitted" | "reviewed" | "approved" | "rejected";
  isDraft: boolean;
  isActive: boolean;
  isFavorite: boolean;
  isAccepted: boolean;
  isOpen: boolean;
  isArchived: boolean;
  archivedAt?: Date | null;
  isCopy: boolean;
  viewsCount: number;
  proposalSettings?: Record<string, unknown>;
  event: {
    eventName: string;
    editionYear?: string;
    eventTheme?: string;
    startDate?: string;
    endDate?: string;
    venue?: string;
    venueCity?: string;
    attendees?: string;
    eventFormat?: "In-Person" | "Hybrid" | "Virtual";
    eventType?: {
      eventType?: string;
      eventTypeOther?: string;
    };
    primaryAudience?: string[];
    eventObjectives?: string;
    toneDirection?: string[];
    sacredConstraints?: string;
  };
  venueSchedule?: Record<string, unknown>;
  roomByRoom?: Record<string, unknown>[];
  production?: Record<string, unknown>;
  hybridVirtual?: Record<string, unknown>;
  contentCreative?: Record<string, unknown>;
  videoRecordingStep?: Record<string, unknown>;
  venue?: Record<string, unknown>;
  uploads?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  contact: {
    contactFirstName: string;
    contactLastName: string;
    contactTitle?: string;
    contactOrganization?: string;
    organizationLegalName?: string;
    contactEmail: string;
    contactPhone: string;
    contactPhoneExt?: string;
    contactPhoneType?: string;
    additionalContacts?: Record<string, unknown>[];
    preferredContactMethod?: string;
    bestTimeToReach?: string;
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
      enum: ["unsubmitted", "submitted", "reviewed", "approved", "rejected"],
      default: "unsubmitted",
    },
    isDraft: { type: Boolean, default: true, index: true },
    isActive: { type: Boolean, default: true },
    isFavorite: { type: Boolean, default: false },
    isAccepted: { type: Boolean, default: false },
    isOpen: { type: Boolean, default: true },
    isArchived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    isCopy: { type: Boolean, default: false, index: true },
    viewsCount: { type: Number, default: 0, min: 0 },

    proposalSettings: { type: Schema.Types.Mixed, default: {} },

    event: {
      eventName: {
        type: String,
        required: [true, "Event name is required"],
        trim: true,
      },
      editionYear: { type: String, trim: true },
      eventTheme: { type: String, trim: true },
      startDate: { type: String, trim: true },
      endDate: { type: String, trim: true },
      venue: { type: String, trim: true },
      venueCity: { type: String, trim: true },
      attendees: { type: String, trim: true },
      eventFormat: { type: String, enum: ["In-Person", "Hybrid", "Virtual"] },
      eventType: {
        eventType: { type: String, trim: true },
        eventTypeOther: { type: String, trim: true },
      },
      primaryAudience: [{ type: String }],
      eventObjectives: { type: String, trim: true },
      toneDirection: [{ type: String }],
      sacredConstraints: { type: String, trim: true },
    },

    venueSchedule: { type: Schema.Types.Mixed, default: {} },
    roomByRoom: { type: [Schema.Types.Mixed], default: [] },
    production: { type: Schema.Types.Mixed, default: {} },
    hybridVirtual: { type: Schema.Types.Mixed, default: {} },
    contentCreative: { type: Schema.Types.Mixed, default: {} },
    videoRecordingStep: { type: Schema.Types.Mixed, default: {} },
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
      organizationLegalName: { type: String, trim: true },
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
      contactPhoneExt: { type: String, trim: true },
      contactPhoneType: { type: String, trim: true },
      additionalContacts: { type: [Schema.Types.Mixed], default: [] },
      preferredContactMethod: { type: String, trim: true },
      bestTimeToReach: { type: String, trim: true },
      anythingElse: { type: String, trim: true },
    },
  },
  {
    timestamps: true,
  },
);

proposalSchema.index({ userId: 1, createdAt: -1 });
proposalSchema.index({ status: 1 });
proposalSchema.index({ "contact.contactEmail": 1 });
proposalSchema.index({ "event.eventName": 1 });

const Proposal = mongoose.model<IProposal>("Proposal", proposalSchema);

export default Proposal;
