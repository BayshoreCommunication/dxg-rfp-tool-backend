import EmailCampaign from "../../../../../modal/emailModel";
import Proposal from "../../../../../modal/proposalsModel";
import type { EmailCampaignSendingRepository } from "../../domain/ports/emailCampaignSendingPorts";
import { tenantFilter } from "../../../shared/tenancy/tenantContext";

export const mongoEmailCampaignSendingRepository: EmailCampaignSendingRepository = {
  async findOwnedProposal({ proposalId, ownerUserId }) {
    const proposal = await Proposal.findOne({
      _id: proposalId,
      userId: ownerUserId,
      ...tenantFilter(),
    })
      .select("_id event.eventName")
      .lean();
    return proposal
      ? {
          proposalId: String(proposal._id),
          proposalTitle: proposal.event?.eventName?.trim() || "Untitled Proposal",
        }
      : null;
  },

  async createCampaign(input) {
    const campaign = await EmailCampaign.create({
      ...tenantFilter(),
      userId: input.ownerUserId,
      proposalId: input.proposalId,
      proposalTitle: input.proposalTitle,
      proposalSlug: input.proposalSlug,
      subject: input.subject,
      message: input.message,
      recipients: input.recipients,
      totalRecipients: input.recipients.length,
      sentCount: 0,
      openedCount: 0,
      clickedCount: 0,
    });
    return { campaignId: String(campaign._id) };
  },

  async finalizeCampaign({
    campaignId,
    ownerUserId,
    recipients,
    sentCount,
  }) {
    const campaign = await EmailCampaign.findOneAndUpdate(
      { _id: campaignId, userId: ownerUserId, ...tenantFilter() },
      { $set: { recipients, sentCount } },
      { new: true, runValidators: true },
    ).lean();
    if (!campaign) throw new Error("Email campaign disappeared during delivery");
    return campaign;
  },
};
