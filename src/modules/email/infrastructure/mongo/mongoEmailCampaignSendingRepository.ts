import EmailCampaign from "../../../../../modal/emailModel";
import Proposal from "../../../../../modal/proposalsModel";
import type { EmailCampaignSendingRepository } from "../../domain/ports/emailCampaignSendingPorts";
import { tenantFilter } from "../../../shared/tenancy/tenantContext";
import { explainProposalMiss, proposalFilterFor } from "../../../identity/application/proposalAccess";

export const mongoEmailCampaignSendingRepository: EmailCampaignSendingRepository = {
  async findOwnedProposal({ proposalId, ownerUserId }) {
    // Emailing a proposal to vendors needs edit, the same as issuing its public link.
    const who = { organizationId: tenantFilter().organizationId, userId: ownerUserId };
    const proposal = await Proposal.findOne(await proposalFilterFor(who, "edit", { _id: proposalId })) // tenant-scoped: policy scope
      .select("_id event.eventName")
      .lean();
    if (!proposal) await explainProposalMiss(who, proposalId, "edit");
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
