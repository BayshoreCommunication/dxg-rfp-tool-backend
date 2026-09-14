/* AUTO-GENERATED from contracts/vendor-response/v1. Do not edit directly. */

export type Identifier = string;
export type Checksum = string;
export type SectionId =
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

/**
 * Immutable proposal-specific questionnaire presented to a vendor.
 */
export interface VendorResponseQuestionnaireV1 {
  schemaVersion: "vendor-response-questionnaire.v1";
  questionnaireId: Identifier;
  questionnaireVersion: number;
  questionnaireChecksum: Checksum;
  proposalId: Identifier;
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
  sectionId: SectionId;
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
  acknowledgementId: Identifier;
  label: string;
  text: string;
  textChecksum: Checksum;
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
  categoryId: Identifier;
  label: string;
}
export interface Room {
  roomId: Identifier;
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
  specId: Identifier;
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
  requiredRoleIds: Identifier[];
  bioMaxWords: number;
  headshotAllowed: boolean;
  headshotRequired: boolean;
}
export interface NamedOption {
  id: Identifier;
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
  feeId: Identifier;
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
  purposeId: Identifier;
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
