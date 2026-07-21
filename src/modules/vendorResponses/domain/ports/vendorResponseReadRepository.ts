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

/**
 * Maps a stored vendor-document URL to a URL the owner can actually open.
 * Private objects get a short-lived presigned GET URL; legacy public URLs
 * pass through unchanged.
 */
export interface VendorDocumentUrlSigner {
  presignDocumentUrl(url: string): Promise<string>;
}
