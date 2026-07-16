export interface EmailTrackingRepository {
  markOpenedOnce(input: { trackingId: string; occurredAt: Date }): Promise<void>;
  markProposalClickedOnce(input: {
    trackingId: string;
    occurredAt: Date;
  }): Promise<{ proposalSlug: string } | null>;
  markVendorResponseClickedOnce(input: {
    trackingId: string;
    occurredAt: Date;
  }): Promise<{ proposalSlug: string; recipientEmail?: string } | null>;
}
