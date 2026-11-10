import mongoose, { Document, Schema } from "mongoose";
import { AWARD_SOURCES, LIFECYCLE_STAGES, type ProposalLifecycleState } from "../src/modules/proposalLifecycle/domain";

export interface IProposal extends Document {
  organizationId?: mongoose.Types.ObjectId;
  userId?: mongoose.Types.ObjectId;
  teamId?: mongoose.Types.ObjectId | null;
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
  version: number;
  candidateApplicationIds: string[];
  // ORG-403: derived dashboard stage and its inputs. Written only by the proposal lifecycle
  // module (src/modules/proposalLifecycle); clients can never set it.
  lifecycle?: ProposalLifecycleState;
  proposalSettings?: Record<string, unknown>;
  event: {
    eventName: string;
    editionYear?: string;
    eventTheme?: string;
    eventWebsite?: string;
    startDate?: string;
    endDate?: string;
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
    aboutOrganization?: string;
    statementOfWork?: string;
    eventProfile?: string;
    rfpTimeline?: string;
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

// Contact details are only mandatory once a proposal leaves the draft stage:
// assisted/lazy creation starts an unsubmitted draft with no contact yet, and
// the final submit step still enforces these fields.
//
// Two binding contexts reach this predicate. On save() `this` is the document.
// On findOneAndUpdate with runValidators + context:"query" `this` is the Query,
// which cannot see the stored isDraft/status — so the pending update decides:
// only an update that promotes the proposal out of draft demands contact.
// Without this branch every draft save of a contactless proposal failed with an
// opaque "Validation failed".
type ContactRequiredScope = {
  status?: string;
  isDraft?: boolean;
  getUpdate?: () => Record<string, unknown> | null;
};

function contactRequired(this: ContactRequiredScope | undefined): boolean {
  const scope: ContactRequiredScope = this ?? {};
  if (typeof scope.getUpdate === "function") {
    const update = scope.getUpdate() ?? {};
    const set = (update.$set ?? {}) as Record<string, unknown>;
    const status = (set.status ?? update.status) as string | undefined;
    const isDraft = (set.isDraft ?? update.isDraft) as boolean | undefined;
    return status === "submitted" || isDraft === false;
  }
  return !(scope.isDraft === true && (scope.status ?? "unsubmitted") === "unsubmitted");
}

const proposalSchema = new Schema<IProposal>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    // Defaults to the creator's team when they're on exactly one (ORG-202). Managers of an active
    // team reach its proposals through rfpAccessPolicy.
    teamId: { type: Schema.Types.ObjectId, ref: "Team", default: null },

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
    version: { type: Number, default: 1, min: 1 },
    candidateApplicationIds: { type: [String], default: [], select: false },

    lifecycle: {
      type: new Schema(
        {
          revision: { type: Number, min: 0, default: 0 },
          stage: { type: String, enum: [...LIFECYCLE_STAGES, null], default: null },
          status: { type: String, default: null },
          changedAt: { type: Date, default: null },
          awardedAt: { type: Date, default: null },
          awardedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
          awardSource: { type: String, enum: [...AWARD_SOURCES, null], default: null },
          awardDecisionId: { type: String, default: null },
          reviewStartedAt: { type: Date, default: null },
          vendorsInvited: { type: Number, min: 0, default: 0 },
          vendorsResponded: { type: Number, min: 0, default: 0 },
        },
        { _id: false },
      ),
      default: undefined,
    },

    proposalSettings: { type: Schema.Types.Mixed, default: {} },

    event: {
      eventName: {
        type: String,
        required: [true, "Event name is required"],
        trim: true,
      },
      editionYear: { type: String, trim: true },
      eventTheme: { type: String, trim: true },
      eventWebsite: { type: String, trim: true },
      startDate: { type: String, trim: true },
      endDate: { type: String, trim: true },
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
      aboutOrganization: { type: String, trim: true },
      statementOfWork: { type: String, trim: true },
      eventProfile: { type: String, trim: true },
      rfpTimeline: { type: String, trim: true },
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
        required: [contactRequired, "First name is required"],
        trim: true,
      },
      contactLastName: {
        type: String,
        required: [contactRequired, "Last name is required"],
        trim: true,
      },
      contactTitle: { type: String, trim: true },
      contactOrganization: { type: String, trim: true },
      organizationLegalName: { type: String, trim: true },
      contactEmail: {
        type: String,
        required: [contactRequired, "Contact email is required"],
        trim: true,
        lowercase: true,
      },
      contactPhone: {
        type: String,
        required: [contactRequired, "Contact phone is required"],
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
proposalSchema.index({ organizationId: 1, userId: 1, createdAt: -1 });
proposalSchema.index({ organizationId: 1, teamId: 1 });
proposalSchema.index({ status: 1 });
// ORG-401 dashboards filter and count by stage within the organization.
proposalSchema.index({ organizationId: 1, "lifecycle.stage": 1, updatedAt: -1 });
proposalSchema.index({ "contact.contactEmail": 1 });
proposalSchema.index({ "event.eventName": 1 });

const Proposal = mongoose.model<IProposal>("Proposal", proposalSchema);

export default Proposal;
