import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import { createOrganizationProfile } from "./application/manageOrganizationProfile";
import { mongoOrganizationProfileDirectory } from "./infrastructure/mongoOrganizationProfileDirectory";

export const organizationProfile = createOrganizationProfile({
  directory: mongoOrganizationProfileDirectory,
  audit: mongoSecurityAuditWriter,
});
