import { createNotification } from "../../../../../utils/notificationService";
import type { ProposalNotificationPort } from "../../domain/ports/proposalNotificationPort";

export const proposalNotificationAdapter: ProposalNotificationPort = {
  async notifyProposalViewed({
    ownerUserId,
    proposalId,
    proposalTitle,
    viewsCount,
  }) {
    await createNotification({
      userId: ownerUserId,
      proposalId,
      type: "proposal_view",
      title: "Proposal viewed",
      message: `"${proposalTitle}" received a new view. Total views: ${viewsCount}.`,
      metadata: { viewsCount },
    });
  },
};
