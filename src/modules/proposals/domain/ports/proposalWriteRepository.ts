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

  /**
   * `"being_deleted"` when the proposal is archived but its permanent delete
   * has started (see markOwnedArchivedPurgeStartedById): it is not restored.
   */
  restoreOwnedById(input: {
    proposalId: string;
    ownerUserId: string;
  }): Promise<boolean | "being_deleted">;

  /**
   * Identifiers needed to purge an archived proposal's cross-store artifacts,
   * read before it is deleted. The tenant is only resolvable from Mongo, so
   * once the record is gone the S3 objects and Postgres rows cannot be found.
   */
  findOwnedArchivedPurgeTargetById(input: {
    proposalId: string;
    ownerUserId: string;
  }): Promise<{ proposalMongoId: string; organizationMongoId: string } | null>;

  /**
   * Records, on the archived proposal and under the same access policy as the
   * delete itself, that its permanent delete has started. It is written BEFORE
   * any source document is marked or removed, and never cleared: the first
   * purge step cannot be undone, so from here the proposal can only be deleted.
   * False when the proposal is no longer archived (a restore got there first).
   */
  markOwnedArchivedPurgeStartedById(input: {
    proposalId: string;
    ownerUserId: string;
  }): Promise<boolean>;

  permanentlyDeleteOwnedArchivedById(input: {
    proposalId: string;
    ownerUserId: string;
  }): Promise<boolean>;
}
