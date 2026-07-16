export type EmailStats = {
  totalCampaigns: number;
  totalRecipients: number;
  totalSent: number;
  totalOpened: number;
  totalClicked: number;
  byProposal: Array<Record<string, unknown>>;
};

export interface EmailCampaignRepository {
  listOwned(input: {
    ownerUserId: string;
    proposalId?: string;
    page: number;
    limit: number;
  }): Promise<{
    campaigns: Record<string, unknown>[];
    total: number;
  }>;
  getOwnedStats(input: {
    ownerUserId: string;
    proposalId?: string;
  }): Promise<EmailStats>;
  deleteOwnedByProposal(input: {
    ownerUserId: string;
    proposalId: string;
  }): Promise<number>;
  deleteOwnedById(input: {
    ownerUserId: string;
    campaignId: string;
  }): Promise<string | null>;
}
