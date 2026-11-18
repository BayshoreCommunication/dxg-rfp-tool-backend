import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import { createSupportGrantManagement } from "./application/manageSupportGrants";
import { createSupportAccess } from "./application/supportAccess";
import { staffOrganizationContent } from "../staffAccess/composition";
import {
  isValidSupportAccessId,
  mongoSupportAccessDirectory,
  mongoSupportGrantRepository,
} from "./infrastructure/mongoSupportAccessRepository";

export const supportGrantManagement = createSupportGrantManagement({
  grants: mongoSupportGrantRepository,
  directory: mongoSupportAccessDirectory,
  audit: mongoSecurityAuditWriter,
  isValidId: isValidSupportAccessId,
});

// The staff side no longer reads grants: it is the staff content service with the older shapes.
export const supportAccess = createSupportAccess({ content: staffOrganizationContent });
