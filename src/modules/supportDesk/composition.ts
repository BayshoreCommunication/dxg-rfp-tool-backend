import { createAgentSupportDesk } from "./application/agentSupportDesk";
import { createCustomerSupportDesk } from "./application/customerSupportDesk";
import { mongoSupportDeskRepository } from "./infrastructure/mongo/mongoSupportDeskRepository";
import { supportDeskNotifier } from "./infrastructure/notifications/supportDeskNotifier";
import { createSupportAttachments } from "./application/supportAttachments";
import { s3SupportAttachmentStorage } from "./infrastructure/storage/supportAttachmentStorage";
import { clamAvSupportUploadScanner } from "./infrastructure/security/supportUploadScanner";

export const customerSupportDesk = createCustomerSupportDesk({
  repository: mongoSupportDeskRepository,
  notifier: supportDeskNotifier,
});

export const agentSupportDesk = createAgentSupportDesk({
  repository: mongoSupportDeskRepository,
  notifier: supportDeskNotifier,
});

export const supportAttachments = createSupportAttachments({
  repository: mongoSupportDeskRepository,
  storage: s3SupportAttachmentStorage,
  scanner: clamAvSupportUploadScanner,
});
