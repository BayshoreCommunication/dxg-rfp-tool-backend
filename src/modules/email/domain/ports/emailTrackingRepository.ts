export interface EmailTrackingRepository {
  /** The organization that sent the email a tracking id belongs to, read without recording anything. */
  organizationOf?(trackingId: string): Promise<string | null>;
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
