import { createNotification } from "../../../../../utils/notificationService";
import type { VendorResponseNotifier } from "../../domain/ports/vendorSubmissionPorts";

export const vendorResponseNotificationAdapter: VendorResponseNotifier = {
  async notifyPlanner(input) {
    await createNotification({
      userId: input.ownerUserId,
      proposalId: input.proposalId,
      type: "vendor_response",
      title: "New Vendor Response",
      message: `${input.vendorName} submitted a response for "${input.proposalTitle}".`,
      metadata: {
        vendorResponseId: input.responseId,
        vendorName: input.vendorName,
        submittedBy: input.submittedBy,
        email: input.email,
      },
    });
  },
};
