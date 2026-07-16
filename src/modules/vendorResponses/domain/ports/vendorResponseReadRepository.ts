export interface VendorResponseReadRepository {
  listOwned(input: {
    ownerUserId: string;
    unreadOnly: boolean;
    proposalId?: string;
    campaignId?: string;
    page: number;
    limit: number;
  }): Promise<{
    responses: Record<string, unknown>[];
    total: number;
    unreadCount: number;
  }>;
  markOwnedRead(input: {
    responseId: string;
    ownerUserId: string;
  }): Promise<Record<string, unknown> | null>;
}
