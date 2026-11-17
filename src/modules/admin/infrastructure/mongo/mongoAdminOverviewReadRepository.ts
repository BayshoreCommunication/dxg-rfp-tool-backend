import EmailCampaign from "../../../../../modal/emailModel";
import Proposal from "../../../../../modal/proposalsModel";
import User from "../../../../../modal/userModel";
import type { AdminOverviewReadRepository } from "../../domain/ports/adminOverviewReadRepository";
import { accountUsage } from "./accountUsageCounts";
import { tenantObjectId } from "../../../shared/tenancy/tenantContext";

const CLIENT_ROLE_FILTER = {
  role: { $nin: ["admin", "super_admin", "superadmin"] },
};

export const mongoAdminOverviewReadRepository: AdminOverviewReadRepository = {
  async getOverview() {
    const organizationId = tenantObjectId();
    const tenantClients = { ...CLIENT_ROLE_FILTER, organizationId };
    const [totalClients, totalProposals, emailStats, latestAccounts] =
      await Promise.all([
        User.countDocuments(tenantClients),
        Proposal.countDocuments({ organizationId }),
        EmailCampaign.aggregate<{
          totalEmailSent: number;
          totalClick: number;
        }>([
          { $match: { organizationId } },
          {
            $group: {
              _id: null,
              totalEmailSent: { $sum: "$sentCount" },
              totalClick: { $sum: "$clickedCount" },
            },
          },
        ]),
        User.aggregate<{
          id: string;
          name: string;
          email: string;
          company?: string | null;
          joinDate: Date;
        }>([
          { $match: tenantClients },
          { $sort: { createdAt: -1 } },
          { $limit: 10 },
          {
            $project: {
              _id: 0,
              id: "$_id",
              name: 1,
              email: 1,
              company: { $ifNull: ["$company", null] },
              joinDate: "$createdAt",
            },
          },
        ]),
      ]);

    // Counted inside this organization only, by the same queries as the staff client list.
    const usageOf = await accountUsage(organizationId, latestAccounts.map((account) => account.id));
    const latestClients = latestAccounts.map((account) => ({ ...account, ...usageOf(account.id) }));

    return {
      totals: {
        totalClients,
        totalProposals,
        totalEmailSent: emailStats[0]?.totalEmailSent ?? 0,
        totalClick: emailStats[0]?.totalClick ?? 0,
      },
      latestClients,
    };
  },
};
