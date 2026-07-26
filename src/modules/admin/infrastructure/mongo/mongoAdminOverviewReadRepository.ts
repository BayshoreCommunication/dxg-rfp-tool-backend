import EmailCampaign from "../../../../../modal/emailModel";
import Proposal from "../../../../../modal/proposalsModel";
import User from "../../../../../modal/userModel";
import type { AdminOverviewReadRepository } from "../../domain/ports/adminOverviewReadRepository";
import { tenantObjectId } from "../../../shared/tenancy/tenantContext";

const CLIENT_ROLE_FILTER = {
  role: { $nin: ["admin", "super_admin", "superadmin"] },
};

export const mongoAdminOverviewReadRepository: AdminOverviewReadRepository = {
  async getOverview() {
    const organizationId = tenantObjectId();
    const tenantClients = { ...CLIENT_ROLE_FILTER, organizationId };
    const [totalClients, totalProposals, emailStats, latestClients] =
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
          totalProposals: number;
          totalEmailSent: number;
        }>([
          { $match: tenantClients },
          { $sort: { createdAt: -1 } },
          { $limit: 10 },
          {
            $lookup: {
              from: "proposals",
              let: { userId: "$_id" },
              pipeline: [
                { $match: { $expr: { $eq: ["$userId", "$$userId"] } } },
                { $count: "count" },
              ],
              as: "proposalStats",
            },
          },
          {
            $lookup: {
              from: "emailcampaigns",
              let: { userId: "$_id" },
              pipeline: [
                { $match: { $expr: { $eq: ["$userId", "$$userId"] } } },
                {
                  $group: {
                    _id: null,
                    totalEmailSent: { $sum: "$sentCount" },
                  },
                },
              ],
              as: "emailStats",
            },
          },
          {
            $project: {
              _id: 0,
              id: "$_id",
              name: 1,
              email: 1,
              company: { $ifNull: ["$company", null] },
              joinDate: "$createdAt",
              totalProposals: {
                $ifNull: [{ $first: "$proposalStats.count" }, 0],
              },
              totalEmailSent: {
                $ifNull: [{ $first: "$emailStats.totalEmailSent" }, 0],
              },
            },
          },
        ]),
      ]);

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
