import type { LegacyProposalRecord } from "../../application/proposalPresentation";
import type { RfpRowPermissions } from "../../../identity/domain/rfpRowPermissions";

export interface ProposalReadRepository {
  findOwnedById(input: {
    proposalId: string;
    ownerUserId: string;
  }): Promise<LegacyProposalRecord | null>;

  // Each listed proposal carries what the requesting member may do to it (row actions).
  listOwned(input: ListOwnedProposalRepositoryInput): Promise<{
    proposals: Array<LegacyProposalRecord & { permissions: RfpRowPermissions }>;
    total: number;
    counts?: ProposalListCounts;
  }>;
}

export type ProposalListCounts = {
  all: number;
  draft: number;
  live: number;
  favorite: number;
  expired: number;
  archive: number;
  saved: number;
};

export type ListOwnedProposalRepositoryInput = {
  ownerUserId: string;
  status?: string;
  favorite?: boolean;
  isActive?: boolean;
  archived: boolean;
  isCopy: boolean;
  isDraft?: boolean;
  includeCounts: boolean;
  search?: string;
  page: number;
  limit: number;
  sortBy: "createdAt" | "updatedAt" | "status" | "viewsCount" | "event.eventName";
  sortOrder: "asc" | "desc";
  expiryDays: number | null;
};
