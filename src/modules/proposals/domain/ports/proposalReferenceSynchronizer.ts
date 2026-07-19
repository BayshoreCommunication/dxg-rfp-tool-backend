import type { LegacyProposalRecord } from "../../application/proposalPresentation";

export interface ProposalReferenceSynchronizer {
  synchronize(input: {
    proposal: LegacyProposalRecord;
    ownerUserId: string;
    eventType: "proposal.reference.updated";
  }): Promise<void>;
}
