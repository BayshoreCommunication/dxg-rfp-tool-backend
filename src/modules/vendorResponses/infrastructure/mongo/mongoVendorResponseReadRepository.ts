import mongoose from "mongoose";
import EmailCampaign from "../../../../../modal/emailModel";
import VendorResponse from "../../../../../modal/vendorResponseModel";
import type { VendorResponseReadRepository } from "../../domain/ports/vendorResponseReadRepository";
import { tenantFilter } from "../../../shared/tenancy/tenantContext";

const VENDOR_RESPONSE_SELECT =
  "_id proposalId proposalOwnerId proposalTitle vendorName submittedBy email message documents isRead createdAt updatedAt";

export const mongoVendorResponseReadRepository: VendorResponseReadRepository = {
  async listOwned({
    ownerUserId,
    unreadOnly,
    proposalId,
    campaignId,
    page,
    limit,
  }) {
    const ownerId = new mongoose.Types.ObjectId(ownerUserId);
    const filter: Record<string, unknown> = { proposalOwnerId: ownerId, ...tenantFilter() };
    if (unreadOnly) filter.isRead = false;

    if (campaignId) {
      const campaign = await EmailCampaign.findOne({
        _id: new mongoose.Types.ObjectId(campaignId),
        userId: ownerId,
        ...tenantFilter(),
      })
        .select("recipients.trackingId")
        .lean();
      const trackingIds = (campaign?.recipients ?? [])
        .map((recipient) => recipient.trackingId)
        .filter(Boolean);
      if (trackingIds.length === 0) {
        return { responses: [], total: 0, unreadCount: 0 };
      }
      filter.emailTrackingId = { $in: trackingIds };
    } else if (proposalId) {
      filter.proposalId = new mongoose.Types.ObjectId(proposalId);
    }

    const [responses, total, unreadCount] = await Promise.all([
      VendorResponse.find(filter)
        .select(VENDOR_RESPONSE_SELECT)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      VendorResponse.countDocuments(filter),
      VendorResponse.countDocuments({ proposalOwnerId: ownerId, isRead: false, ...tenantFilter() }),
    ]);
    return { responses, total, unreadCount };
  },

  markOwnedRead({ responseId, ownerUserId }) {
    return VendorResponse.findOneAndUpdate(
      {
        _id: responseId,
        proposalOwnerId: new mongoose.Types.ObjectId(ownerUserId),
        ...tenantFilter(),
      },
      { isRead: true },
      { new: true },
    )
      .select(VENDOR_RESPONSE_SELECT)
      .lean();
  },
};
