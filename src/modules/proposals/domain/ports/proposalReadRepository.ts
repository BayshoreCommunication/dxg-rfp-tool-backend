import type { LegacyProposalRecord } from "../../application/proposalPresentation";

export interface ProposalReadRepository {
  findOwnedById(input: {
    proposalId: string;
    ownerUserId: string;
  }): Promise<LegacyProposalRecord | null>;

  listOwned(input: ListOwnedProposalRepositoryInput): Promise<{
    proposals: LegacyProposalRecord[];
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
