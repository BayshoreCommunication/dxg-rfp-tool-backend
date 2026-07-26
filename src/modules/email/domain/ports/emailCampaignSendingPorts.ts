export type CampaignRecipient = {
  email: string;
  trackingId: string;
  status: "sent" | "failed";
  sentAt?: Date;
  errorMessage?: string;
};

export interface EmailCampaignSendingRepository {
  findOwnedProposal(input: {
    proposalId: string;
    ownerUserId: string;
  }): Promise<{ proposalId: string; proposalTitle: string } | null>;
  createCampaign(input: {
    ownerUserId: string;
    proposalId: string;
    proposalTitle: string;
    proposalSlug: string;
    subject: string;
    message: string;
    recipients: CampaignRecipient[];
  }): Promise<{ campaignId: string }>;
  finalizeCampaign(input: {
    campaignId: string;
    ownerUserId: string;
    recipients: CampaignRecipient[];
    sentCount: number;
  }): Promise<Record<string, unknown>>;
}

export interface CampaignEmailDeliveryPort {
  send(input: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<void>;
}
