export type VendorDocument = { name: string; url: string };

export type VendorResponseRecord = Record<string, unknown> & {
  _id?: unknown;
  proposalTitle?: string;
};

export interface VendorSubmissionRepository {
  findExisting(input: {
    proposalId: string;
    email: string;
    trackingId: string | null;
  }): Promise<VendorResponseRecord | null>;
  findByTrackingId(trackingId: string): Promise<VendorResponseRecord | null>;
  findByProposalAndEmail(input: {
    proposalId: string;
    email: string;
  }): Promise<VendorResponseRecord | null>;
  updateExisting(input: {
    responseId: string;
    vendorName: string;
    submittedBy: string;
    message: string;
    documents: VendorDocument[];
    trackingId: string | null;
  }): Promise<VendorResponseRecord>;
  findProposal(proposalId: string): Promise<{
    proposalId: string;
    organizationId: string;
    ownerUserId: string;
    proposalTitle: string;
  } | null>;
  create(input: {
    proposalId: string;
    organizationId: string;
    ownerUserId: string;
    proposalTitle: string;
    vendorName: string;
    submittedBy: string;
    email: string;
    message: string;
    documents: VendorDocument[];
    trackingId: string | null;
  }): Promise<VendorResponseRecord>;
}
