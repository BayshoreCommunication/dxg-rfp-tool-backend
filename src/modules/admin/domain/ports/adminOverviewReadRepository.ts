export type AdminOverview = {
  totals: {
    totalClients: number;
    totalProposals: number;
    totalEmailSent: number;
    totalClick: number;
  };
  latestClients: Array<{
    id: string;
    name: string;
    email: string;
    company?: string | null;
    joinDate: Date;
    totalProposals: number;
    totalEmailSent: number;
  }>;
};

export interface AdminOverviewReadRepository {
  getOverview(): Promise<AdminOverview>;
}
