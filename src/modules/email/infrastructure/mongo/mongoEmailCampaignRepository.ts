import mongoose from "mongoose";
import EmailCampaign from "../../../../../modal/emailModel";
import VendorResponse from "../../../../../modal/vendorResponseModel";
import type {
  EmailCampaignRepository,
  EmailStats,
} from "../../domain/ports/emailCampaignRepository";
import { tenantFilter, tenantObjectId } from "../../../shared/tenancy/tenantContext";

export const mongoEmailCampaignRepository: EmailCampaignRepository = {
  async listOwned({ ownerUserId, proposalId, page, limit }) {
    const filter: Record<string, unknown> = { userId: ownerUserId, ...tenantFilter() };
    if (proposalId) filter.proposalId = proposalId;
    const [campaigns, total] = await Promise.all([
      EmailCampaign.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      EmailCampaign.countDocuments(filter),
    ]);
    const trackingToCampaign = new Map<string, string>();
    for (const campaign of campaigns) {
      for (const recipient of campaign.recipients) {
        if (recipient.trackingId) {
          trackingToCampaign.set(recipient.trackingId, String(campaign._id));
        }
      }
    }
    const counts = new Map<string, number>();
    if (trackingToCampaign.size) {
      const responses = await VendorResponse.find({
        ...tenantFilter(),
        emailTrackingId: { $in: [...trackingToCampaign.keys()] },
      })
        .select("emailTrackingId")
        .lean();
      for (const response of responses) {
        const campaignId = response.emailTrackingId
          ? trackingToCampaign.get(response.emailTrackingId)
          : undefined;
        if (campaignId) counts.set(campaignId, (counts.get(campaignId) ?? 0) + 1);
      }
    }
    return {
      campaigns: campaigns.map((campaign) => ({
        ...campaign,
        vendorResponseCount: counts.get(String(campaign._id)) ?? 0,
      })),
      total,
    };
  },

  async getOwnedStats({ ownerUserId, proposalId }) {
    const match: Record<string, unknown> = {
      userId: new mongoose.Types.ObjectId(ownerUserId),
      organizationId: tenantObjectId(),
    };
    if (proposalId) match.proposalId = new mongoose.Types.ObjectId(proposalId);
    const [summaryRows, byProposal] = await Promise.all([
      EmailCampaign.aggregate<Omit<EmailStats, "byProposal">>([
        { $match: match },
        {
          $group: {
            _id: null,
            totalCampaigns: { $sum: 1 },
            totalRecipients: { $sum: "$totalRecipients" },
            totalSent: { $sum: "$sentCount" },
            totalOpened: { $sum: "$openedCount" },
            totalClicked: { $sum: "$clickedCount" },
          },
        },
      ]),
      EmailCampaign.aggregate<Record<string, unknown>>([
        { $match: match },
        {
          $group: {
            _id: "$proposalId",
            proposalTitle: { $first: "$proposalTitle" },
            totalSent: { $sum: "$sentCount" },
            totalOpened: { $sum: "$openedCount" },
            totalClicked: { $sum: "$clickedCount" },
          },
        },
        { $sort: { totalSent: -1 } },
        { $limit: 20 },
        {
          $project: {
            _id: 0,
            proposalId: { $toString: "$_id" },
            proposalTitle: 1,
            totalSent: 1,
            totalOpened: 1,
            totalClicked: 1,
          },
        },
      ]),
    ]);
    return {
      ...(summaryRows[0] ?? {
        totalCampaigns: 0,
        totalRecipients: 0,
        totalSent: 0,
        totalOpened: 0,
        totalClicked: 0,
      }),
      byProposal,
    };
  },

  async deleteOwnedByProposal({ ownerUserId, proposalId }) {
    const result = await EmailCampaign.deleteMany({
      userId: ownerUserId,
      ...tenantFilter(),
      proposalId: new mongoose.Types.ObjectId(proposalId),
    });
    return result.deletedCount;
  },

  async deleteOwnedById({ ownerUserId, campaignId }) {
    const campaign = await EmailCampaign.findOneAndDelete({
      _id: campaignId,
      userId: new mongoose.Types.ObjectId(ownerUserId),
      ...tenantFilter(),
    });
    return campaign ? String(campaign._id) : null;
  },
};
