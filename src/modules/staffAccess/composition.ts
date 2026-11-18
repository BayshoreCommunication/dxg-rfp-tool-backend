import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import {
  isValidSupportAccessId,
  mongoGrantedRfpReader,
  mongoSupportAccessDirectory,
  mongoSupportTicketLookup,
} from "../supportAccess/infrastructure/mongoSupportAccessRepository";
import { createStaffOrganizationContent } from "./application/readOrganizationContent";
import { mongoStaffOrganizationReader } from "./infrastructure/mongoStaffOrganizationReader";

export const staffOrganizationContent = createStaffOrganizationContent({
  organizations: mongoStaffOrganizationReader,
  proposals: mongoGrantedRfpReader,
  directory: mongoSupportAccessDirectory,
  tickets: mongoSupportTicketLookup,
  audit: mongoSecurityAuditWriter,
  isValidId: isValidSupportAccessId,
});
