export type { ProposalExtractionPatchV1 } from "../../../../contracts/generated/proposal-extraction-patch-v1";
export type { ProposalPublicV1 } from "../../../../contracts/generated/proposal-public-v1";
export type { ProposalV1 } from "../../../../contracts/generated/proposal-v1";
export {
  formatContractErrors,
  validateProposalExtractionPatchV1,
  validateProposalPublicV1,
  validateProposalV1,
} from "../../../../contracts/proposal/v1/validators";
export {
  mapLegacyProposalToV1,
  toPublicProposalV1,
  type LegacyMappingIssue,
  type LegacyProposalContext,
  type LegacyProposalMappingResult,
} from "../../../../contracts/proposal/v1/legacyAdapter";
