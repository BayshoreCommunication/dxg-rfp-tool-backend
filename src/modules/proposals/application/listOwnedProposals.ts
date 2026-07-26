import type { ProposalReadRepository } from "../domain/ports/proposalReadRepository";
import type { ProposalSettingsRepository } from "../domain/ports/proposalSettingsRepository";
import {
  applyDerivedExpiryState,
  buildProposalSettingSnapshot,
  parseExpiryDays,
} from "./proposalPresentation";

const ALLOWED_SORT_FIELDS = new Set([
  "createdAt",
  "updatedAt",
  "status",
  "viewsCount",
  "event.eventName",
]);

export type ProposalListRequest = {
  status?: string;
  favorite?: string;
  isActive?: string;
  archived?: string;
  isCopy?: string;
  isDraft?: string;
  includeCounts?: string;
  search?: string;
  page?: string;
  limit?: string;
  sortBy?: string;
  sortOrder?: string;
};

const explicitBoolean = (value?: string): boolean | undefined => {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
};

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const createListOwnedProposals = (dependencies: {
  proposals: ProposalReadRepository;
  settings: ProposalSettingsRepository;
}) => async (input: {
  ownerUserId: string;
  query: ProposalListRequest;
}) => {
  const settings = await dependencies.settings.findByUserId(input.ownerUserId);
  const expirySetting = settings?.proposals?.expiryDate;
  const requestedSort = input.query.sortBy ?? "createdAt";
  const sortBy = (ALLOWED_SORT_FIELDS.has(requestedSort)
    ? requestedSort
    : "createdAt") as
    | "createdAt"
    | "updatedAt"
    | "status"
    | "viewsCount"
    | "event.eventName";
  const page = positiveInteger(input.query.page, 1);
  const limit = Math.min(100, positiveInteger(input.query.limit, 20));
  const search = input.query.search?.trim() || undefined;

  const result = await dependencies.proposals.listOwned({
    ownerUserId: input.ownerUserId,
    status: input.query.status,
    favorite: explicitBoolean(input.query.favorite),
    isActive:
      typeof input.query.isActive === "string"
        ? input.query.isActive === "true"
        : undefined,
    archived: input.query.archived === "true",
    isCopy: input.query.isCopy === "true",
    isDraft: explicitBoolean(input.query.isDraft),
    includeCounts: input.query.includeCounts === "true",
    search,
    page,
    limit,
    sortBy,
    sortOrder: input.query.sortOrder === "asc" ? "asc" : "desc",
    expiryDays: parseExpiryDays(expirySetting),
  });
  const proposalSetting = buildProposalSettingSnapshot(settings);

  return {
    proposals: result.proposals.map((proposal) => ({
      ...applyDerivedExpiryState(proposal, expirySetting),
      proposalSetting,
    })),
    pagination: {
      total: result.total,
      page,
      limit,
      totalPages: Math.ceil(result.total / limit),
    },
    counts: result.counts,
  };
};
