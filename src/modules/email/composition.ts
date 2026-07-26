import {
  createTrackEmailOpen,
  createTrackProposalClick,
  createTrackVendorResponseClick,
} from "./application/trackEmailEngagement";
import { mongoEmailTrackingRepository } from "./infrastructure/mongo/mongoEmailTrackingRepository";
import {
  createDeleteOwnedEmailCampaignById,
  createDeleteOwnedEmailCampaignsByProposal,
  createGetOwnedEmailStats,
  createListOwnedEmailCampaigns,
} from "./application/manageEmailCampaigns";
import { mongoEmailCampaignRepository } from "./infrastructure/mongo/mongoEmailCampaignRepository";
import crypto from "crypto";
import { createSendOwnedEmailCampaign } from "./application/sendEmailCampaign";
import { mongoEmailCampaignSendingRepository } from "./infrastructure/mongo/mongoEmailCampaignSendingRepository";
import { customEmailDeliveryAdapter } from "./infrastructure/delivery/customEmailDeliveryAdapter";
import { publicAccess } from "../publicAccess/composition";
import { currentTenant } from "../shared/tenancy/tenantContext";

const firstUrl = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)[0] || value.trim();
const frontendBaseUrl = firstUrl(
  process.env.FRONTEND_URL || "http://localhost:3000",
);
const apiBaseUrl = firstUrl(
  process.env.BACKEND_URL || process.env.API_URL || "http://localhost:5000",
);

export const trackEmailOpen = createTrackEmailOpen({
  repository: mongoEmailTrackingRepository,
});
export const trackProposalClick = createTrackProposalClick({
  repository: mongoEmailTrackingRepository,
  frontendBaseUrl,
});
export const trackVendorResponseClick = createTrackVendorResponseClick({
  repository: mongoEmailTrackingRepository,
  frontendBaseUrl,
});
export const listOwnedEmailCampaigns = createListOwnedEmailCampaigns(
  mongoEmailCampaignRepository,
);
export const getOwnedEmailStats = createGetOwnedEmailStats(
  mongoEmailCampaignRepository,
);
export const deleteOwnedEmailCampaignsByProposal =
  createDeleteOwnedEmailCampaignsByProposal(mongoEmailCampaignRepository);
export const deleteOwnedEmailCampaignById = createDeleteOwnedEmailCampaignById(
  mongoEmailCampaignRepository,
);
export const sendOwnedEmailCampaign = createSendOwnedEmailCampaign({
  repository: mongoEmailCampaignSendingRepository,
  delivery: customEmailDeliveryAdapter,
  frontendBaseUrl,
  apiBaseUrl,
  trackingId: () => crypto.randomBytes(16).toString("hex"),
  grants: {
    issue: ({ resourceId, purpose, recipient }) => {
      const tenant = currentTenant();
      return publicAccess.issue({
        organizationId: tenant.organizationId,
        createdByUserId: tenant.userId,
        resourceId,
        purpose,
        recipient,
        expiresInHours: 168,
      });
    },
  },
});
