/* AUTO-GENERATED from contracts/proposal/v1. Do not edit directly. */

export type Identifier = string;
export type DateTime = string;
export type Date = string;
export type NonNegativeInteger = number;
export type StringArray = string[];
export type NullableBoolean = boolean | null;
export type LocalTime = string;

/**
 * Canonical internal RFPilot proposal resource.
 */
export interface ProposalV1 {
  schemaVersion: "proposal.v1";
  id: Identifier;
  organizationId: Identifier;
  ownerUserId: Identifier;
  version: number;
  lifecycle: Lifecycle;
  content: ProposalContent;
  presentation?: Presentation;
  createdAt: DateTime;
  updatedAt: DateTime;
}
export interface Lifecycle {
  status: "draft" | "submitted" | "in_review" | "approved" | "rejected" | "published" | "archived";
  favorite: boolean;
  copyOfProposalId?: Identifier;
  publishedAt?: DateTime;
  archivedAt?: DateTime;
}
export interface ProposalContent {
  event: Event;
  venueSchedule: VenueSchedule;
  /**
   * @maxItems 200
   */
  rooms: Room[];
  hybridVirtual?: HybridVirtual;
  contentCreative?: ContentCreative;
  videoRecording?: VideoRecording;
  venueTechnical?: VenueTechnical;
  /**
   * @maxItems 500
   */
  sourceReferences?: SourceReference[];
  vendorCoordination?: VendorCoordination;
  confidentiality?: Confidentiality;
  budgetPreferences?: BudgetPreferences;
  contacts: Contacts;
}
export interface Event {
  name: string;
  edition?: string;
  theme?: string;
  website?: string;
  startDate?: Date;
  endDate?: Date;
  attendeeCount?: NonNegativeInteger;
  attendeeBand?: "lt_100" | "100_199" | "200_499" | "500_999" | "1000_plus" | "unknown";
  format: "in_person" | "hybrid" | "virtual";
  type?: string;
  typeOther?: string;
  primaryAudiences?: StringArray;
  objectives?: string;
  toneDirections?: StringArray;
  sacredConstraints?: string;
  organizationBackground?: string;
  statementOfWork?: string;
  eventProfile?: string;
  rfpTimelineNotes?: string;
}
export interface VenueSchedule {
  venueName?: string;
  city?: string;
  region?: string;
  address?: string;
  venueType?: string;
  confirmationStatus?:
    "contract_signed" | "verbal_confirmation" | "strong_preference" | "not_selected" | "unknown";
  unionVenue?: NullableBoolean;
  unionJurisdictions?: StringArray;
  unionJurisdictionOther?: string;
  loadIn?: LocalSchedulePoint;
  rehearsal?: LocalSchedulePoint;
  showStart?: LocalSchedulePoint;
  showEnd?: LocalSchedulePoint;
  strike?: LocalSchedulePoint;
  roomCount: number;
  timeZone?: string;
}
export interface LocalSchedulePoint {
  date: Date;
  time?: LocalTime;
}
export interface Room {
  id: Identifier;
  function: string;
  location?: string;
  setup?: string;
  scheduleDate?: Date;
  estimatedAttendees?: NonNegativeInteger;
  loadInAt?: DateTime;
  rehearsalAt?: DateTime;
  showStartAt?: DateTime;
  showEndAt?: DateTime;
  /**
   * @maxItems 500
   */
  scheduleEntries?: RoomScheduleEntry[];
  audio?: AudioRequirements;
  video?: VideoRequirements;
  lighting?: LightingRequirements;
  production?: RoomProduction;
}
export interface RoomScheduleEntry {
  function: string;
  setup?: string;
  scheduleDate?: Date;
  estimatedAttendees?: NonNegativeInteger;
  showStartAt?: DateTime;
  showEndAt?: DateTime;
}
export interface AudioRequirements {
  systemRequired?: NullableBoolean;
  systemAudienceCount?: NonNegativeInteger;
  podiumMicRequired?: NullableBoolean;
  podiumMicCount?: NonNegativeInteger;
  wirelessMicRequired?: NullableBoolean;
  wirelessMicCount?: NonNegativeInteger;
  wirelessMicType?: string;
  recordingRequired?: NullableBoolean;
}
export interface VideoRequirements {
  displayRequired?: NullableBoolean;
  monitorCount?: NonNegativeInteger;
  monitorSize?: Measurement;
  screenCount?: NonNegativeInteger;
  screenSize?: Measurement;
  ledWallRequired?: NullableBoolean;
  ledWallWidth?: Measurement;
  ledWallHeight?: Measurement;
  ledWallPixelPitch?: Measurement;
  ledWallSpecs?: string;
  ledWallShape?: string;
  ledWallSwitcher?: string;
  ledWallNotes?: string;
  presentationLaptopsRequired?: NullableBoolean;
  presentationLaptopCount?: NonNegativeInteger;
  clientLaptopsProvided?: NullableBoolean;
  clientLaptopCount?: NonNegativeInteger;
  videoPlaybackRequired?: NullableBoolean;
  videoPlaybackCount?: NonNegativeInteger;
  videoPlaybackFormat?: string;
  aspectRatio?: string;
  audienceQaRequired?: NullableBoolean;
  audienceQaMethod?: string;
  camerasRequired?: NullableBoolean;
  cameraCount?: NonNegativeInteger;
  videoRecordingRequired?: NullableBoolean;
  recordingType?: string;
  programConfidenceMonitorRequired?: NullableBoolean;
  programConfidenceMonitorCount?: NonNegativeInteger;
  notesConfidenceMonitorRequired?: NullableBoolean;
  notesConfidenceMonitorCount?: NonNegativeInteger;
  speakerTimerRequired?: NullableBoolean;
  teleprompterRequired?: NullableBoolean;
  teleprompterBilingual?: NullableBoolean;
  teleprompterLanguages?: StringArray;
}
export interface Measurement {
  value: number;
  unit: "in" | "ft" | "mm" | "cm" | "m" | "amp" | "px";
}
export interface LightingRequirements {
  stageWashRequired?: NullableBoolean;
  stageDimensions?: string;
  backlighting?: string;
  scenicUplighting?: string;
  audienceLighting?: string;
  requirements?: StringArray;
}
export interface RoomProduction {
  scenicStageDesign?: NullableBoolean;
  scenicNotes?: string;
  unionLabor?: NullableBoolean;
  unionLaborDetails?: string;
  crewRoles?: StringArray;
  crewQuantities?: {
    [k: string]: NonNegativeInteger;
  };
  otherRoles?: string;
  contentVideoNeeds?: string;
}
export interface HybridVirtual {
  virtualAttendeeCount?: NonNegativeInteger;
  streamingPlatform?: string;
  streamingPlatformOther?: string;
  platformIntegrationWithAv?: NullableBoolean;
  streamOwner?: string;
  remoteSpeakers?: RemoteSpeakers;
  liveVirtualQa?: NullableBoolean;
  virtualOnlyBreakouts?: NullableBoolean;
  dedicatedVirtualProducer?: NullableBoolean;
  closedCaptions?: ClosedCaptions;
  onDemandRecording?: NullableBoolean;
  sponsorOverlays?: NullableBoolean;
  virtualNetworking?: NullableBoolean;
}
export interface RemoteSpeakers {
  required?: NullableBoolean;
  count?: NonNegativeInteger;
  feedPlatform?: string;
  techRehearsalOwner?: string;
}
export interface ClosedCaptions {
  required?: NullableBoolean;
  languages?: StringArray;
  languageOther?: string;
  type?: "ai" | "human" | "unknown";
}
export interface ContentCreative {
  servicesRequired?: NullableBoolean;
  presentationTemplateOwner?: string;
  speakerSlideCollectionOwner?: string;
  motionGraphicsOwner?: string;
  lowerThirdsOwner?: string;
  eventLogoBrandStandardsOwner?: string;
  sizzleRecapOwner?: string;
  liveDataFeeds?: OwnedRequirement;
  sponsorRecognitionOwner?: string;
  socialMediaCaptureOwner?: string;
  virtualBackgroundOwner?: string;
  creativeDirectionNotes?: string;
}
export interface OwnedRequirement {
  required?: NullableBoolean;
  owner?: string;
}
export interface VideoRecording {
  required?: NullableBoolean;
  cameraCount?: NonNegativeInteger;
  cameraPositions?: StringArray;
  imagRequired?: NullableBoolean;
  cameraOperatorCount?: NonNegativeInteger;
  isoRecordings?: string;
  resolution?: string;
  recordingMedia?: string;
  editedDeliverable?: EditedDeliverable;
  rawFootageTurnover?: NullableBoolean;
  deliverableFormats?: StringArray;
  deliveryMethods?: StringArray;
}
export interface EditedDeliverable {
  required?: NullableBoolean;
  types?: StringArray;
  turnaroundTime?: string;
  reelLengthPreference?: string;
}
export interface VenueTechnical {
  avContact?: ContactReference;
  inHouseAvCompanyName?: string;
  riggingRequired?: NullableBoolean;
  riggingPlotOrSpecs?: string;
  trussAndMotorsProvided?: NullableBoolean;
  liftsProvided?: NullableBoolean;
  powerDropsRequired?: NullableBoolean;
  powerDropAmperage?: Measurement;
  powerDropCount?: NonNegativeInteger;
  wirelessInternetRequired?: NullableBoolean;
  internetUseCases?: StringArray;
  coiRequirements?: string;
  accessRequirements?: string;
}
export interface ContactReference {
  name?: string;
  email?: string;
  phone?: string;
}
export interface SourceReference {
  sourceId: Identifier;
  sourceVersionId: Identifier;
  category:
    | "brief"
    | "brand_guide"
    | "event_logo"
    | "venue_document"
    | "nda"
    | "reference"
    | "quote"
    | "contract"
    | "other";
  displayName: string;
  externalUrl?: string;
}
export interface VendorCoordination {
  /**
   * @maxItems 100
   */
  coVendors?: CoVendor[];
}
export interface CoVendor {
  category:
    | "in_house_venue_av"
    | "event_decorator"
    | "registration_technology"
    | "agency_of_record"
    | "photographer"
    | "other";
  companyName?: string;
  contact?: ContactReference;
  status?: string;
  notes?: string;
}
export interface Confidentiality {
  ndaRequired?: NullableBoolean;
  ndaType?: string;
  /**
   * @maxItems 20
   */
  ndaSourceReferenceIds?:
    | []
    | [Identifier]
    | [Identifier, Identifier]
    | [Identifier, Identifier, Identifier]
    | [Identifier, Identifier, Identifier, Identifier]
    | [Identifier, Identifier, Identifier, Identifier, Identifier]
    | [Identifier, Identifier, Identifier, Identifier, Identifier, Identifier]
    | [Identifier, Identifier, Identifier, Identifier, Identifier, Identifier, Identifier]
    | [
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
      ]
    | [
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
      ]
    | [
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
      ]
    | [
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
      ]
    | [
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
      ]
    | [
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
      ]
    | [
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
      ]
    | [
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
      ]
    | [
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
      ]
    | [
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
      ]
    | [
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
      ]
    | [
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
      ]
    | [
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
        Identifier,
      ];
}
export interface BudgetPreferences {
  budgetBand?: string;
  budget?: Money;
  flexibility?: string;
  proposalFormats?: StringArray;
  evaluationWeights?: {
    [k: string]: number;
  };
  sustainabilityDeiNotes?: string;
  vendorQuestionsDueDate?: Date;
  vendorAnswersDate?: Date;
  proposalDueDate?: Date;
  shortlistDate?: Date;
  vendorPresentation?: NullableBoolean;
  vendorPresentationDate?: Date;
  vendorSelectionDate?: Date;
  decisionDate?: Date;
  competitiveBid?: NullableBoolean;
  proposalCount?: NonNegativeInteger;
  scoringNotes?: string;
  producerCallRequested?: NullableBoolean;
  referralSource?: string;
  referralSourceOther?: string;
}
export interface Money {
  amountMinor: number;
  currency: string;
}
export interface Contacts {
  primary: ProposalContact;
  /**
   * @maxItems 100
   */
  additional?: ProposalContact[];
  preferredMethod?: "email" | "phone" | "either";
  bestTimeToReach?: string;
  additionalNotes?: string;
}
export interface ProposalContact {
  firstName: string;
  lastName: string;
  fullName?: string;
  title?: string;
  organizationDisplayName?: string;
  organizationLegalName?: string;
  email: string;
  phone?: string;
  phoneExtension?: string;
  phoneType?: string;
  role?: string;
}
export interface Presentation {
  brandName?: string;
  linkPrefix?: string;
  font?: string;
  language?: string;
  currency?: string;
  dateFormat?: string;
  decimalPrecision?: number;
  downloadPreviewEnabled?: boolean;
}
