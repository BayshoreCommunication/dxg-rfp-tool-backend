import type { LegacyProposalRecord } from "../../application/proposalPresentation";

export type LegacyPublicProposal = {
  ownerUserId: string;
  proposal: LegacyProposalRecord;
};

/** Compatibility port for the existing raw-ObjectId public route.
 * Replace with scoped, expiring share-token access in Workstream 1B.
 */
export interface PublicProposalAccessRepository {
  findByLegacyPublicId(proposalId: string): Promise<LegacyPublicProposal | null>;
  incrementViewsByLegacyPublicId(
    proposalId: string,
  ): Promise<LegacyPublicProposal | null>;
}
