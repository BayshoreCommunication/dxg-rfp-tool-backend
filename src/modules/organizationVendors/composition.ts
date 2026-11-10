import { createOrganizationVendorList } from "./application/manageOrganizationVendors";
import { isValidVendorId, mongoOrganizationVendorRepository } from "./infrastructure/mongoOrganizationVendorRepository";
import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";

export const organizationVendorList = createOrganizationVendorList({
  vendors: mongoOrganizationVendorRepository,
  audit: mongoSecurityAuditWriter,
  isValidId: isValidVendorId,
});
