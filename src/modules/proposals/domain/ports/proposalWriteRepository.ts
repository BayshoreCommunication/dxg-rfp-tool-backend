import type { LegacyProposalRecord } from "../../application/proposalPresentation";

export interface ProposalWriteRepository {
  createOwned(input: {
    ownerUserId: string;
    proposal: Record<string, unknown>;
  }): Promise<LegacyProposalRecord>;

  findOwnedCopySourceById(input: {
    proposalId: string;
    ownerUserId: string;
  }): Promise<LegacyProposalRecord | null>;

  findOwnedLifecycleById(input: {
    proposalId: string;
    ownerUserId: string;
  }): Promise<{ isCopy: boolean } | null>;

  updateOwnedById(input: {
    proposalId: string;
    ownerUserId: string;
    updates: Record<string, unknown>;
    runValidators?: boolean;
  }): Promise<LegacyProposalRecord | null>;

  incrementOwnedViews(input: {
    proposalId: string;
    ownerUserId: string;
  }): Promise<LegacyProposalRecord | null>;

  archiveOwnedById(input: {
    proposalId: string;
    ownerUserId: string;
    archivedAt: Date;
  }): Promise<boolean>;

  restoreOwnedById(input: {
    proposalId: string;
    ownerUserId: string;
  }): Promise<boolean>;

  permanentlyDeleteOwnedArchivedById(input: {
    proposalId: string;
    ownerUserId: string;
  }): Promise<boolean>;
}
