import mongoose from "mongoose";
import EmailCampaign from "../../../../../modal/emailModel";
import Proposal from "../../../../../modal/proposalsModel";
import type { DashboardReadRepository } from "../../domain/ports/dashboardReadRepository";
import { tenantObjectId } from "../../../shared/tenancy/tenantContext";

export const mongoDashboardReadRepository: DashboardReadRepository = {
  async getOwnedOverview(ownerUserId) {
    const userId = new mongoose.Types.ObjectId(ownerUserId);
    const organizationId = tenantObjectId();
    const [totalProposals, emailRows, proposalViewRows, latestDocuments] =
      await Promise.all([
        Proposal.countDocuments({ userId, organizationId }),
        EmailCampaign.aggregate<{
          totalEmailSent: number;
          totalEmailClicked: number;
        }>([
          { $match: { userId, organizationId } },
          {
            $group: {
              _id: null,
              totalEmailSent: { $sum: "$sentCount" },
              totalEmailClicked: { $sum: "$clickedCount" },
            },
          },
        ]),
        Proposal.aggregate<{ totalProposalViews: number }>([
          { $match: { userId, organizationId } },
          {
            $group: {
              _id: null,
              totalProposalViews: { $sum: "$viewsCount" },
            },
          },
        ]),
        Proposal.find({ userId, organizationId })
          .sort({ createdAt: -1 })
          .limit(5)
          .select(
            "_id status isActive isFavorite viewsCount createdAt event contact",
          )
          .lean(),
      ]);
    return {
      totals: {
        totalProposals,
        totalEmailSent: emailRows[0]?.totalEmailSent ?? 0,
        totalEmailClicked: emailRows[0]?.totalEmailClicked ?? 0,
        totalProposalViews: proposalViewRows[0]?.totalProposalViews ?? 0,
      },
      latestProposals: latestDocuments,
    };
  },
};
