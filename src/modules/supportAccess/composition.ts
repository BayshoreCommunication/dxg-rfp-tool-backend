import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import { createSupportGrantManagement } from "./application/manageSupportGrants";
import { createSupportAccess } from "./application/supportAccess";
import {
  isValidSupportAccessId,
  mongoGrantedRfpReader,
  mongoSupportAccessDirectory,
  mongoSupportActivityLog,
  mongoSupportGrantRepository,
  mongoSupportTicketLookup,
} from "./infrastructure/mongoSupportAccessRepository";

export const supportGrantManagement = createSupportGrantManagement({
  grants: mongoSupportGrantRepository,
  directory: mongoSupportAccessDirectory,
  activity: mongoSupportActivityLog,
  audit: mongoSecurityAuditWriter,
  isValidId: isValidSupportAccessId,
});

export const supportAccess = createSupportAccess({
  grants: mongoSupportGrantRepository,
  directory: mongoSupportAccessDirectory,
  reader: mongoGrantedRfpReader,
  tickets: mongoSupportTicketLookup,
  audit: mongoSecurityAuditWriter,
  isValidId: isValidSupportAccessId,
});
