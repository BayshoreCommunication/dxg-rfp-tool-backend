import { createNotification } from "../../../../../utils/notificationService";
import type { VendorResponseNotifier } from "../../domain/ports/vendorSubmissionPorts";
import { hasFeature } from "../../../entitlements/domain/plans";
import { loadOrganizationPlanState } from "../../../entitlements/infrastructure/mongoOrganizationEntitlements";

// Reading vendor responses is a plan feature (ORG-601). A locked organization is still told that
// a response arrived, without the vendor's name, contact or total, which /api/notifications
// would otherwise hand to anyone the response routes refuse. Unknown organization: no details.
const responsesUnlocked = async (organizationId: string): Promise<boolean> => {
  const organization = await loadOrganizationPlanState(organizationId);
  return organization !== null && hasFeature(organization, "vendorResponses");
};

export const vendorResponseNotificationAdapter: VendorResponseNotifier = {
  async notifyPlanner(input) {
    if (!(await responsesUnlocked(input.organizationId))) {
      await createNotification({
        userId: input.ownerUserId,
        proposalId: input.proposalId,
        type: "vendor_response",
        title: input.versionNumber > 1 ? "Vendor Response Updated" : "New Vendor Response",
        message: `A vendor ${input.versionNumber > 1 ? "updated their response" : "responded"} to "${input.proposalTitle}". Vendor responses aren't included in your plan. Contact us to upgrade.`,
        metadata: { planLocked: true, feature: "vendorResponses" },
      });
      return;
    }
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
