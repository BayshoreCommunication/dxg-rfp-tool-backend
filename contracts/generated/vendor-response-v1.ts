/* AUTO-GENERATED from contracts/vendor-response/v1. Do not edit directly. */

export type Identifier = string;
export type Checksum = string;
export type AlternateScope = {
  [k: string]: unknown;
} & {
  type: "project" | "room";
  roomId?: Identifier;
};
export type DocumentReference = {
  [k: string]: unknown;
} & {
  documentId: Identifier;
  purposeId: Identifier;
  scopeType: "proposal" | "room" | "crew_member" | "reference";
  scopeId?: Identifier;
};

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
  questionnaireId: Identifier;
  questionnaireVersion: number;
  questionnaireChecksum: Checksum;
  proposalId: Identifier;
  proposalVersion: number;
}
export interface Identity {
  vendorName: string;
  submittedBy: string;
  email: string;
}
export interface AcknowledgementResponse {
  acknowledgementId: Identifier;
  accepted: boolean;
  acceptedAt?: string;
  textChecksum: Checksum;
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
  categoryId: Identifier;
  percent: number;
}
export interface RoomResponse {
  roomId: Identifier;
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
  specId: Identifier;
  status: "comply" | "substitute" | "exception";
  note: string;
}
export interface EquipmentLine {
  equipmentLineId: Identifier;
  categoryId: Identifier;
  description: string;
  quantity: number;
}
export interface CategoryTotal {
  categoryId: Identifier;
  amount: Money;
}
export interface Money {
  amountMinor: number;
  currency: string;
}
export interface LaborLine {
  laborLineId: Identifier;
  roleId: Identifier;
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
  crewMemberId: Identifier;
  name: string;
  roleId: Identifier;
  bio: string;
  headshotDocumentId?: Identifier;
}
export interface Travel {
  /**
   * @maxItems 1000
   */
  lodgingRequests: LodgingRequest[];
}
export interface LodgingRequest {
  laborLineId: Identifier;
  roomId: Identifier;
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
  feeId: Identifier;
  amount: Money;
}
export interface Alternate {
  alternateId: Identifier;
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
  referenceId: Identifier;
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
  visualDocumentIds: Identifier[];
}
export interface ReferenceContact {
  name: string;
  email: string;
  phone: string;
}
