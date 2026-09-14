import { createNotification } from "../../../../../utils/notificationService";
import type { VendorResponseNotifier } from "../../domain/ports/vendorSubmissionPorts";

export const vendorResponseNotificationAdapter: VendorResponseNotifier = {
  async notifyPlanner(input) {
    await createNotification({
      userId: input.ownerUserId,
      proposalId: input.proposalId,
      type: "vendor_response",
      title: input.versionNumber > 1
        ? "Vendor Response Updated"
        : "New Vendor Response",
      message: `${input.vendorName} submitted ${input.responseFormat === "structured_v1" ? "a structured" : "a"} response${input.versionNumber > 1 ? ` (version ${input.versionNumber})` : ""} for "${input.proposalTitle}".`,
      metadata: {
        vendorResponseId: input.responseId,
        vendorName: input.vendorName,
        submittedBy: input.submittedBy,
        email: input.email,
        versionNumber: input.versionNumber,
        responseFormat: input.responseFormat,
        ...(input.grandTotalMinor === null || !input.currency
          ? {}
          : {
              calculatedTotal: {
                amountMinor: input.grandTotalMinor,
                currency: input.currency,
                provenance: "server_calculated",
              },
            }),
      },
    });
  },
};
