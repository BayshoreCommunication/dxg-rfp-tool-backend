import mongoose, { Document, Schema } from "mongoose";

/* ─────────────────────────────────────────
   Interfaces
───────────────────────────────────────── */
export interface IProposal extends Document {
  // Meta
  createdBy?: mongoose.Types.ObjectId;
  status: "draft" | "submitted" | "reviewed" | "approved" | "rejected";

  // Step 1 — Event Overview
  eventName: string;
  startDate?: string;
  endDate?: string;
  venue?: string;
  attendees?: string;
  eventFormat?: "In-Person" | "Hybrid" | "Virtual";
  eventType?: string;
  eventTypeOther?: string;

  // Step 2 — Room-by-Room AV Needs
  roomFunction?: string;
  numberOfRooms?: string;
  ceilingHeight?: string;
  roomSetup?: string;
  showPrep?: string;
  showSize?: string;
  hasPipeAndDrape?: boolean;
  showRig?: boolean;
  rigPowerSize?: string;
  preferredRigging?: string[];
  decibelLimitation?: string;
  avSpec?: string;
  avPa?: string;
  mainSound?: string;
  mainSoundSize?: string;
  hearingImpaired?: string;
  preferredA1?: string;
  recordAudio?: string;
  chairs?: string;
  stageRisers?: string[];
  backdropsWallSize?: string;
  scenicElements?: boolean;
  videoStage?: boolean;
  frontScreen?: string;
  contentVideoNeeds?: string;

  // Step 3 — Production Support & Crew
  scenicStageDesign?: string;
  unionLabor?: string;
  showCrewNeeded?: string[];
  otherRolesNeeded?: string;

  // Step 4 — Venue & Technical Requirements
  needRiggingForFlown?: string;
  riggingPlotOrSpecs?: string;
  needDedicatedPowerDrops?: string;
  standardAmpWall?: string;
  powerDropsHowMany?: string;

  // Step 5 — Uploads & Reference Materials (stored as file paths/URLs)
  supportDocumentUrls?: string[];
  reviewExistingAvQuote?: string;
  avQuoteFileUrls?: string[];

  // Step 6 — Budget & Proposal Preferences
  estimatedAvBudget?: string;
  budgetCustomAmount?: string;
  proposalFormatPreferences?: string[];
  timelineForProposal?: string;
  callWithDxgProducer?: string;
  howDidYouHear?: string;
  howDidYouHearOther?: string;

  // Step 7 — Contact Info
  contactFirstName: string;
  contactLastName: string;
  contactTitle?: string;
  contactOrganization?: string;
  contactEmail: string;
  contactPhone: string;
  anythingElse?: string;

  createdAt: Date;
  updatedAt: Date;
}

/* ─────────────────────────────────────────
   Schema
───────────────────────────────────────── */
const proposalSchema = new Schema<IProposal>(
  {
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    status: {
      type: String,
      enum: ["draft", "submitted", "reviewed", "approved", "rejected"],
      default: "submitted",
    },

    // Step 1
    eventName:    { type: String, required: [true, "Event name is required"], trim: true },
    startDate:    { type: String, trim: true },
    endDate:      { type: String, trim: true },
    venue:        { type: String, trim: true },
    attendees:    { type: String, trim: true },
    eventFormat:  { type: String, enum: ["In-Person", "Hybrid", "Virtual"] },
    eventType:    { type: String, trim: true },
    eventTypeOther: { type: String, trim: true },

    // Step 2
    roomFunction:     { type: String, trim: true },
    numberOfRooms:    { type: String },
    ceilingHeight:    { type: String },
    roomSetup:        { type: String, trim: true },
    showPrep:         { type: String },
    showSize:         { type: String },
    hasPipeAndDrape:  { type: Boolean, default: false },
    showRig:          { type: Boolean, default: false },
    rigPowerSize:     { type: String, trim: true },
    preferredRigging: [{ type: String }],
    decibelLimitation: { type: String, trim: true },
    avSpec:           { type: String, trim: true },
    avPa:             { type: String, trim: true },
    mainSound:        { type: String, trim: true },
    mainSoundSize:    { type: String, trim: true },
    hearingImpaired:  { type: String, trim: true },
    preferredA1:      { type: String, trim: true },
    recordAudio:      { type: String, trim: true },
    chairs:           { type: String },
    stageRisers:      [{ type: String }],
    backdropsWallSize: { type: String },
    scenicElements:   { type: Boolean, default: false },
    videoStage:       { type: Boolean, default: false },
    frontScreen:      { type: String, trim: true },
    contentVideoNeeds: { type: String, trim: true },

    // Step 3
    scenicStageDesign: { type: String, trim: true },
    unionLabor:        { type: String, trim: true },
    showCrewNeeded:    [{ type: String }],
    otherRolesNeeded:  { type: String, trim: true },

    // Step 4
    needRiggingForFlown:     { type: String },
    riggingPlotOrSpecs:      { type: String, trim: true },
    needDedicatedPowerDrops: { type: String },
    standardAmpWall:         { type: String, trim: true },
    powerDropsHowMany:       { type: String, trim: true },

    // Step 5 — File URLs (files uploaded separately, only URLs stored)
    supportDocumentUrls: [{ type: String }],
    reviewExistingAvQuote: { type: String },
    avQuoteFileUrls:     [{ type: String }],

    // Step 6
    estimatedAvBudget:         { type: String, trim: true },
    budgetCustomAmount:        { type: String, trim: true },
    proposalFormatPreferences: [{ type: String }],
    timelineForProposal:       { type: String, trim: true },
    callWithDxgProducer:       { type: String },
    howDidYouHear:             { type: String, trim: true },
    howDidYouHearOther:        { type: String, trim: true },

    // Step 7
    contactFirstName:   { type: String, required: [true, "First name is required"], trim: true },
    contactLastName:    { type: String, required: [true, "Last name is required"], trim: true },
    contactTitle:       { type: String, trim: true },
    contactOrganization: { type: String, trim: true },
    contactEmail:       { type: String, required: [true, "Contact email is required"], trim: true, lowercase: true },
    contactPhone:       { type: String, required: [true, "Contact phone is required"], trim: true },
    anythingElse:       { type: String, trim: true },
  },
  {
    timestamps: true,
  }
);

/* ─── Index for fast lookups ─── */
proposalSchema.index({ createdBy: 1, createdAt: -1 });
proposalSchema.index({ status: 1 });
proposalSchema.index({ contactEmail: 1 });

const Proposal = mongoose.model<IProposal>("Proposal", proposalSchema);

export default Proposal;
