import type { VendorResponseQuestionnaireV1 } from "../../../../../contracts/generated/vendor-response-questionnaire-v1";
import type { VendorResponseQuestionnaireProjection } from "../questionnaire";

export type VendorResponseQuestionnaireProposalSnapshot = {
  organizationId: string;
  proposalId: string;
  ownerUserId: string;
  status: string;
  isDraft: boolean;
  isActive: boolean;
  isOpen: boolean;
  isArchived: boolean;
  legacyProposal: Record<string, unknown>;
};

export type VendorResponseQuestionnairePublication = {
  questionnaire: VendorResponseQuestionnaireV1;
  created: boolean;
};

export interface VendorResponseQuestionnaireRepository {
  loadProposal(input: {
    organizationId: string;
    proposalId: string;
    ownerUserId?: string;
  }): Promise<VendorResponseQuestionnaireProposalSnapshot | null>;
  publish(input: {
    organizationId: string;
    proposalId: string;
    proposalVersion: number;
    projection: VendorResponseQuestionnaireProjection;
    sourceChecksum: string;
    publishedByActorId: string;
    publishedAt: Date;
  }): Promise<VendorResponseQuestionnairePublication>;
}
