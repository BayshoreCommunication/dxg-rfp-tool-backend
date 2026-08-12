/* AUTO-GENERATED from contracts/proposal/v1. Do not edit directly. */

export type StringArray = string[];

export interface ProposalPublicV1 {
  schemaVersion: "proposal-public.v1";
  proposalId: string;
  version: number;
  content: {
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
    vendorCoordination?: VendorCoordination;
    confidentiality?: Confidentiality;
    budgetPreferences?: BudgetPreferences;
    contacts: Contacts;
  };
  presentation: Presentation;
  publishedAt: string;
}
export interface Event {
  name: string;
  edition?: string;
  theme?: string;
  website?: string;
  startDate?: string;
  endDate?: string;
  attendeeCount?: number;
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
  unionVenue?: boolean | null;
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
  date: string;
  time?: string;
}
export interface Room {
  id: string;
  function: string;
  location?: string;
  setup?: string;
  scheduleDate?: string;
  estimatedAttendees?: number;
  loadInAt?: string;
  rehearsalAt?: string;
  showStartAt?: string;
  showEndAt?: string;
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
  scheduleDate?: string;
  estimatedAttendees?: number;
  showStartAt?: string;
  showEndAt?: string;
}
export interface AudioRequirements {
  systemRequired?: boolean | null;
  systemAudienceCount?: number;
  podiumMicRequired?: boolean | null;
  podiumMicCount?: number;
  wirelessMicRequired?: boolean | null;
  wirelessMicCount?: number;
  wirelessMicType?: string;
  recordingRequired?: boolean | null;
}
export interface VideoRequirements {
  displayRequired?: boolean | null;
  monitorCount?: number;
  monitorSize?: Measurement;
  screenCount?: number;
  screenSize?: Measurement;
  ledWallRequired?: boolean | null;
  ledWallCount?: number;
  ledWalls?: LedWallSpecification[];
  ledWallWidth?: Measurement;
  ledWallHeight?: Measurement;
  ledWallPixelPitch?: Measurement;
  ledWallSpecs?: string;
  ledWallShape?: string;
  ledWallSwitcher?: string;
  ledWallNotes?: string;
  presentationLaptopsRequired?: boolean | null;
  presentationLaptopCount?: number;
  clientLaptopsProvided?: boolean | null;
  clientLaptopCount?: number;
  videoPlaybackRequired?: boolean | null;
  videoPlaybackCount?: number;
  videoPlaybackFormat?: string;
  aspectRatio?: string;
  audienceQaRequired?: boolean | null;
  audienceQaMethod?: string;
  camerasRequired?: boolean | null;
  cameraCount?: number;
  cameraPlanMode?: "specific" | "vendor_recommendation";
  cameraType?: "ptz" | "studio_broadcast" | "both" | "other";
  ptzCameraCount?: number;
  studioCameraCount?: number;
  otherCameraType?: string;
  otherCameraCount?: number;
  videoRecordingRequired?: boolean | null;
  recordingType?: string;
  recordingCodec?: "H.264" | "H.265" | "ProRes";
  recordIn4k?: boolean | null;
  programConfidenceMonitorRequired?: boolean | null;
  programConfidenceMonitorCount?: number;
  notesConfidenceMonitorRequired?: boolean | null;
  notesConfidenceMonitorCount?: number;
  speakerTimerRequired?: boolean | null;
  teleprompterRequired?: boolean | null;
  teleprompterBilingual?: boolean | null;
  teleprompterLanguages?: StringArray;
}
export interface Measurement {
  value: number;
  unit: "in" | "ft" | "mm" | "cm" | "m" | "amp" | "px";
}
export interface LedWallSpecification {
  width?: Measurement;
  height?: Measurement;
  pixelPitch?: Measurement;
  specs?: string;
  shape?: string;
  switcher?: string;
  notes?: string;
}
export interface LightingRequirements {
  stageWashRequired?: boolean | null;
  stageDimensions?: string;
  backlighting?: string;
  scenicUplighting?: string;
  audienceLighting?: string;
  requirements?: StringArray;
}
export interface RoomProduction {
  scenicStageDesign?: boolean | null;
  scenicNotes?: string;
  unionLabor?: boolean | null;
  unionLaborDetails?: string;
  crewRoles?: StringArray;
  crewQuantities?: {
    [k: string]: number;
  };
  otherRoles?: string;
  contentVideoNeeds?: string;
}
export interface HybridVirtual {
  virtualAttendeeCount?: number;
  streamingPlatform?: string;
  streamingPlatformOther?: string;
  platformIntegrationWithAv?: boolean | null;
  streamOwner?: string;
  remoteSpeakers?: RemoteSpeakers;
  liveVirtualQa?: boolean | null;
  virtualOnlyBreakouts?: boolean | null;
  dedicatedVirtualProducer?: boolean | null;
  closedCaptions?: ClosedCaptions;
  onDemandRecording?: boolean | null;
  sponsorOverlays?: boolean | null;
  virtualNetworking?: boolean | null;
}
export interface RemoteSpeakers {
  required?: boolean | null;
  count?: number;
  feedPlatform?: string;
  techRehearsalOwner?: string;
}
export interface ClosedCaptions {
  required?: boolean | null;
  languages?: StringArray;
  languageOther?: string;
  type?: "ai" | "human" | "unknown";
}
export interface ContentCreative {
  servicesRequired?: boolean | null;
  presentationTemplateOwner?: string;
  speakerSlideCollectionOwner?: string;
  motionGraphicsOwner?: string;
  openingClosingVideoOwner?: string;
  motionGraphicsStingersBumpersOwner?: string;
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
  required?: boolean | null;
  owner?: string;
}
export interface VideoRecording {
  required?: boolean | null;
  cameraCount?: number;
  cameraPositions?: StringArray;
  imagRequired?: boolean | null;
  cameraOperatorCount?: number;
  isoRecordings?: string;
  resolution?: string;
  codec?: "H.264" | "H.265" | "ProRes";
  recordIn4k?: boolean | null;
  recordingMedia?: string;
  editedDeliverable?: EditedDeliverable;
  rawFootageTurnover?: boolean | null;
  deliverableFormats?: StringArray;
  deliveryMethods?: StringArray;
}
export interface EditedDeliverable {
  required?: boolean | null;
  types?: StringArray;
  turnaroundTime?: string;
  reelLengthPreference?: string;
}
export interface VenueTechnical {
  avContact?: ContactReference;
  inHouseAvCompanyName?: string;
  riggingRequired?: boolean | null;
  riggingPlotOrSpecs?: string;
  trussAndMotorsProvided?: boolean | null;
  liftsProvided?: boolean | null;
  powerDropsRequired?: boolean | null;
  powerDropAmperage?: Measurement;
  powerDropCount?: number;
  wirelessInternetRequired?: boolean | null;
  internetUseCases?: StringArray;
  coiRequirements?: string;
  accessRequirements?: string;
}
export interface ContactReference {
  name?: string;
  email?: string;
  phone?: string;
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
  ndaRequired?: boolean | null;
  ndaType?: string;
  /**
   * @maxItems 20
   */
  ndaSourceReferenceIds?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
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
  vendorQuestionsDueDate?: string;
  vendorAnswersDate?: string;
  proposalDueDate?: string;
  shortlistDate?: string;
  vendorPresentation?: boolean | null;
  vendorPresentationDate?: string;
  vendorSelectionDate?: string;
  decisionDate?: string;
  competitiveBid?: boolean | null;
  proposalCount?: number;
  scoringNotes?: string;
  producerCallRequested?: boolean | null;
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
