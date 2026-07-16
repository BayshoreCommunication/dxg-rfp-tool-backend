export type DashboardOverview = {
  totals: {
    totalProposals: number;
    totalEmailSent: number;
    totalEmailClicked: number;
    totalProposalViews: number;
  };
  latestProposals: Record<string, unknown>[];
};

export interface DashboardReadRepository {
  getOwnedOverview(ownerUserId: string): Promise<DashboardOverview>;
}
