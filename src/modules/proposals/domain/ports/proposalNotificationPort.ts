export interface ProposalNotificationPort {
  notifyProposalViewed(input: {
    ownerUserId: string;
    proposalId: string;
    proposalTitle: string;
    viewsCount: number;
  }): Promise<void>;
}
