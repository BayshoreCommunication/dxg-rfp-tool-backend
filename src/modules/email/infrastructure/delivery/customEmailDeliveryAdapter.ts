import { sendCustomEmail } from "../../../../../utils/emailService";
import type { CampaignEmailDeliveryPort } from "../../domain/ports/emailCampaignSendingPorts";

export const customEmailDeliveryAdapter: CampaignEmailDeliveryPort = {
  async send(input) {
    await sendCustomEmail(input);
  },
};
