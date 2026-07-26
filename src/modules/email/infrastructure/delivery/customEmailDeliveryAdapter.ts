import { sendCustomEmail } from "../../../../../utils/emailService";
import type { CampaignEmailDeliveryPort } from "../../domain/ports/emailCampaignSendingPorts";

export const customEmailDeliveryAdapter: CampaignEmailDeliveryPort = {
  send: sendCustomEmail,
};
