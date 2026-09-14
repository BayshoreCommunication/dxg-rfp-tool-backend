import type { VendorResponseQuestionnaireV1 } from "../../../../../contracts/generated/vendor-response-questionnaire-v1";
import type { VendorResponseQuestionnaireProjection } from "../questionnaire";
import type { VendorResponseFormat } from "../rollout";

export type VendorResponseQuestionnaireProposalSnapshot = {
  organizationId: string;
  proposalId: string;
  ownerUserId: string;
  status: string;
  isDraft: boolean;
  isActive: boolean;
  isOpen: boolean;
  isArchived: boolean;
  responseFormat: VendorResponseFormat;
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
  setResponseFormat(input: {
    organizationId: string;
    proposalId: string;
    ownerUserId: string;
    responseFormat: VendorResponseFormat;
  }): Promise<boolean>;
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
