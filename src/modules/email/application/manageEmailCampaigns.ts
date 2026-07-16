import type { EmailCampaignRepository } from "../domain/ports/emailCampaignRepository";

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const createListOwnedEmailCampaigns = (
  repository: EmailCampaignRepository,
) => async (input: {
  ownerUserId: string;
  query: { proposalId?: string; page?: string; limit?: string };
}) => {
  const page = positiveInteger(input.query.page, 1);
  const limit = Math.min(100, positiveInteger(input.query.limit, 20));
  const result = await repository.listOwned({
    ownerUserId: input.ownerUserId,
    proposalId: input.query.proposalId,
    page,
    limit,
  });
  return {
    campaigns: result.campaigns,
    pagination: {
      total: result.total,
      page,
      limit,
      totalPages: Math.ceil(result.total / limit),
    },
  };
};

export const createGetOwnedEmailStats = (repository: EmailCampaignRepository) =>
  async (input: { ownerUserId: string; proposalId?: string }) => {
    const stats = await repository.getOwnedStats(input);
    return {
      ...stats,
      openRate:
        stats.totalSent > 0
          ? Number(((stats.totalOpened / stats.totalSent) * 100).toFixed(2))
          : 0,
      clickRate:
        stats.totalSent > 0
          ? Number(((stats.totalClicked / stats.totalSent) * 100).toFixed(2))
          : 0,
      totalViews: stats.totalOpened,
    };
  };

export const createDeleteOwnedEmailCampaignsByProposal = (
  repository: EmailCampaignRepository,
) => async (input: { ownerUserId: string; proposalId: string }) => {
  const deletedCount = await repository.deleteOwnedByProposal(input);
  return deletedCount > 0
    ? { kind: "deleted" as const, deletedCount }
    : { kind: "not_found" as const };
};

export const createDeleteOwnedEmailCampaignById = (
  repository: EmailCampaignRepository,
) => async (input: { ownerUserId: string; campaignId: string }) => {
  const campaignId = await repository.deleteOwnedById(input);
  return campaignId
    ? { kind: "deleted" as const, campaignId }
    : { kind: "not_found" as const };
};
