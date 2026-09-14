/* AUTO-GENERATED from contracts/vendor-response/v1. Do not edit directly. */

export type AlternateScope = {
  [k: string]: unknown;
} & {
  type: "project" | "room";
  roomId?: string;
};
export type DocumentReference = {
  [k: string]: unknown;
} & {
  documentId: string;
  purposeId: string;
  scopeType: "proposal" | "room" | "crew_member" | "reference";
  scopeId?: string;
};

export interface VendorResponseWorkspaceV1 {
  schemaVersion: "vendor-response-workspace.v1";
  proposalTitle: string;
  capabilities: {
    structuredResponse: boolean;
    responseFormat: "structured_v1" | "legacy_unstructured";
    reason: "enabled" | "global_flag_disabled" | "proposal_not_enabled";
  };
  access: {
    state: "open" | "closed" | "expired" | "revoked" | "unavailable";
    canEdit: boolean;
    canSubmit: boolean;
    message?: string;
  };
  questionnaire: null | VendorResponseQuestionnaireV1;
  draft: null | {
    draftId: string;
    draftRevision: number;
    status: "active" | "submitted" | "abandoned";
    lastSavedAt: string;
    response: VendorResponseV1;
  };
  currentSubmission: null | {
    submissionId: string;
    versionId: string;
    versionNumber: number;
    receivedAt: string;
    format: "structured_v1" | "legacy_unstructured";
  };
}
/**
 * Immutable proposal-specific questionnaire presented to a vendor.
 */
export interface VendorResponseQuestionnaireV1 {
  schemaVersion: "vendor-response-questionnaire.v1";
  questionnaireId: string;
  questionnaireVersion: number;
  questionnaireChecksum: string;
  proposalId: string;
  proposalVersion: number;
  status: "published" | "superseded";
  context: Context;
  identity: IdentityConfiguration;
  /**
   * @minItems 1
   * @maxItems 11
   */
  sections: Section[];
  /**
   * @maxItems 20
   */
  acknowledgements: Acknowledgement[];
  companyProfile: CompanyProfileConfiguration;
  /**
   * @maxItems 200
   */
  rooms: Room[];
  hybrid: HybridConfiguration;
  crew: CrewConfiguration;
  pricing: PricingConfiguration;
  alternates: AlternateConfiguration;
  references: ReferenceConfiguration;
  documents: DocumentConfiguration;
  valueAdds: ValueAddConfiguration;
  publishedAt: string;
}
export interface Context {
  proposalTitle: string;
  eventFormat?: "in_person" | "hybrid" | "virtual";
  venueName?: string;
  venueLocation?: string;
  eventStartDate?: string;
  eventEndDate?: string;
  proposalDueDate?: string;
  plannerOrganizationName?: string;
  currency: string;
  decimalPrecision: number;
}
export interface IdentityConfiguration {
  vendorNameRequired: boolean;
  submittedByRequired: boolean;
  emailRequired: boolean;
}
export interface Section {
  sectionId:
    | "compliance"
    | "company_profile"
    | "rooms"
    | "crew"
    | "travel"
    | "pricing"
    | "alternates"
    | "references"
    | "documents"
    | "value_adds"
    | "review";
  title: string;
  helperText?: string;
  order: number;
  enabled: boolean;
  required: boolean;
  condition: "always" | "travel_flagged";
  /**
   * @maxItems 20
   */
  evaluationMappings: string[];
}
export interface Acknowledgement {
  acknowledgementId: string;
  label: string;
  text: string;
  textChecksum: string;
  required: boolean;
}
export interface CompanyProfileConfiguration {
  legalNameRequired: boolean;
  headquartersRequired: boolean;
  yearsInBusinessEnabled: boolean;
  staffCountEnabled: boolean;
  largestComparableEventEnabled: boolean;
  clientMix: {
    enabled: boolean;
    required: boolean;
    /**
     * @maxItems 20
     */
    categories: ClientMixCategory[];
  };
  deiPolicyRequired: boolean;
  sustainabilityPolicyRequired: boolean;
}
export interface ClientMixCategory {
  categoryId: string;
  label: string;
}
export interface Room {
  roomId: string;
  name: string;
  location?: string;
  setup?: string;
  scheduleSummary?: string;
  estimatedAttendees?: number;
  streamingApplicable: boolean;
  /**
   * @maxItems 500
   */
  specs: Spec[];
}
export interface Spec {
  specId: string;
  category: string;
  label: string;
  requirementText: string;
  sourcePath: string;
  /**
   * @minItems 1
   * @maxItems 3
   */
  allowedResponses: ("comply" | "substitute" | "exception")[];
  noteMaxLength: number;
}
export interface HybridConfiguration {
  platformPlanRequired: boolean;
  platformPlanMaxWords: number;
  roomPlanMaxWords: number;
  externalUrlsAllowed: boolean;
}
export interface CrewConfiguration {
  /**
   * @minItems 1
   * @maxItems 100
   */
  roles: NamedOption[];
  /**
   * @maxItems 100
   */
  requiredRoleIds: string[];
  bioMaxWords: number;
  headshotAllowed: boolean;
  headshotRequired: boolean;
}
export interface NamedOption {
  id: string;
  label: string;
}
export interface PricingConfiguration {
  currency: string;
  decimalPrecision: number;
  /**
   * @minItems 1
   * @maxItems 100
   */
  equipmentCategories: NamedOption[];
  /**
   * @maxItems 100
   */
  feeLines: FeeLine[];
  travelSubtotalRequired: boolean;
  discountRequired: boolean;
  assumptionsAllowed: boolean;
}
export interface FeeLine {
  feeId: string;
  label: string;
  kind: "fee" | "tax";
  required: boolean;
}
export interface AlternateConfiguration {
  enabled: boolean;
  minimumCount: number;
  maximumCount: number;
}
export interface ReferenceConfiguration {
  enabled: boolean;
  minimumCount: number;
  maximumCount: number;
  maxAgeMonths: number;
  maxVisualsPerReference: number;
}
export interface DocumentConfiguration {
  /**
   * @maxItems 50
   */
  categories: DocumentCategory[];
  globalMaximumFiles: number;
}
export interface DocumentCategory {
  purposeId: string;
  label: string;
  helperText?: string;
  required: boolean;
  minimumFiles: number;
  maximumFiles: number;
  maximumFileBytes: number;
  /**
   * @minItems 1
   * @maxItems 30
   */
  allowedMimeTypes: string[];
}
export interface ValueAddConfiguration {
  enabled: boolean;
  required: boolean;
  maxWords: number;
}
/**
 * Draftable structured vendor response. Final requiredness is questionnaire-driven.
 */
export interface VendorResponseV1 {
  schemaVersion: "vendor-response.v1";
  questionnaire: QuestionnaireReference;
  identity: Identity;
  /**
   * @maxItems 20
   */
  acknowledgements: AcknowledgementResponse[];
  companyProfile: CompanyProfile;
  platformIntegrationPlan: string;
  /**
   * @maxItems 200
   */
  rooms: RoomResponse[];
  /**
   * @maxItems 500
   */
  crew: CrewMember[];
  travel: Travel;
  pricing: Pricing;
  /**
   * @maxItems 100
   */
  alternates: Alternate[];
  /**
   * @maxItems 50
   */
  references: Reference[];
  /**
   * @maxItems 500
   */
  documents: DocumentReference[];
  valueAdds: string;
}
export interface QuestionnaireReference {
  questionnaireId: string;
  questionnaireVersion: number;
  questionnaireChecksum: string;
  proposalId: string;
  proposalVersion: number;
}
export interface Identity {
  vendorName: string;
  submittedBy: string;
  email: string;
}
export interface AcknowledgementResponse {
  acknowledgementId: string;
  accepted: boolean;
  acceptedAt?: string;
  textChecksum: string;
}
export interface CompanyProfile {
  legalName: string;
  headquarters: string;
  yearsInBusiness?: number;
  staffCount?: number;
  largestComparableEvent: string;
  /**
   * @maxItems 20
   */
  clientMix: ClientMixEntry[];
}
export interface ClientMixEntry {
  categoryId: string;
  percent: number;
}
export interface RoomResponse {
  roomId: string;
  /**
   * @maxItems 500
   */
  specResponses: SpecResponse[];
  /**
   * @maxItems 1000
   */
  equipmentLines: EquipmentLine[];
  /**
   * @maxItems 100
   */
  categoryTotals: CategoryTotal[];
  /**
   * @maxItems 1000
   */
  laborLines: LaborLine[];
  laborSubtotal: Money;
  hybrid?: HybridResponse;
}
export interface SpecResponse {
  specId: string;
  status: "comply" | "substitute" | "exception";
  note: string;
}
export interface EquipmentLine {
  equipmentLineId: string;
  categoryId: string;
  description: string;
  quantity: number;
}
export interface CategoryTotal {
  categoryId: string;
  amount: Money;
}
export interface Money {
  amountMinor: number;
  currency: string;
}
export interface LaborLine {
  laborLineId: string;
  roleId: string;
  days: number;
  regularHours: number;
  overtimeHours: number;
  travel: boolean;
  notes: string;
}
export interface HybridResponse {
  feedHandoff: string;
  redundancy: string;
  virtualAudienceExperience: string;
}
export interface CrewMember {
  crewMemberId: string;
  name: string;
  roleId: string;
  bio: string;
  headshotDocumentId?: string;
}
export interface Travel {
  /**
   * @maxItems 1000
   */
  lodgingRequests: LodgingRequest[];
}
export interface LodgingRequest {
  laborLineId: string;
  roomId: string;
  clientProvidedRoom: boolean;
  checkIn?: string;
  checkOut?: string;
}
export interface Pricing {
  travelSubtotal: Money;
  /**
   * @maxItems 100
   */
  fees: FeeAmount[];
  discount: Money;
  /**
   * @maxItems 200
   */
  assumptionsExclusions: string[];
}
export interface FeeAmount {
  feeId: string;
  amount: Money;
}
export interface Alternate {
  alternateId: string;
  scope: AlternateScope;
  title: string;
  tradeoff: string;
  costDelta: SignedMoney;
  recommended: boolean;
}
export interface SignedMoney {
  amountMinor: number;
  currency: string;
}
export interface Reference {
  referenceId: string;
  clientName: string;
  contact: ReferenceContact;
  eventName: string;
  attendance?: number;
  servicesProvided: string;
  startDate?: string;
  endDate?: string;
  currentStatus: string;
  comparable: boolean;
  /**
   * @maxItems 20
   */
  visualDocumentIds: string[];
}
export interface ReferenceContact {
  name: string;
  email: string;
  phone: string;
}
