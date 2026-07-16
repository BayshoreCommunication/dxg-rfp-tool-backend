import EmailCampaign from "../../../../../modal/emailModel";
import type { EmailTrackingRepository } from "../../domain/ports/emailTrackingRepository";

export const mongoEmailTrackingRepository: EmailTrackingRepository = {
  async markOpenedOnce({ trackingId, occurredAt }) {
    await EmailCampaign.updateOne(
      {
        recipients: {
          $elemMatch: { trackingId, openedAt: { $exists: false } },
        },
      },
      {
        $set: { "recipients.$.openedAt": occurredAt },
        $inc: { openedCount: 1 },
      },
    );
  },

  async markProposalClickedOnce({ trackingId, occurredAt }) {
    const campaign = await EmailCampaign.findOne({
      "recipients.trackingId": trackingId,
    })
      .select("proposalSlug")
      .lean();
    if (!campaign) return null;
    await EmailCampaign.updateOne(
      {
        _id: campaign._id,
        recipients: {
          $elemMatch: { trackingId, clickedAt: { $exists: false } },
        },
      },
      {
        $set: { "recipients.$.clickedAt": occurredAt },
        $inc: { clickedCount: 1 },
      },
    );
    return { proposalSlug: campaign.proposalSlug };
  },

  async markVendorResponseClickedOnce({ trackingId, occurredAt }) {
    const campaign = await EmailCampaign.findOne({
      "recipients.trackingId": trackingId,
    })
      .select("proposalSlug recipients")
      .lean();
    if (!campaign) return null;
    const recipient = campaign.recipients.find(
      (item) => item.trackingId === trackingId,
    );
    await EmailCampaign.updateOne(
      {
        _id: campaign._id,
        recipients: {
          $elemMatch: {
            trackingId,
            vendorResponseClickedAt: { $exists: false },
          },
        },
      },
      {
        $set: { "recipients.$.vendorResponseClickedAt": occurredAt },
        $inc: { vendorResponseClickCount: 1 },
      },
    );
    return {
      proposalSlug: campaign.proposalSlug,
      recipientEmail: recipient?.email,
    };
  },
};
