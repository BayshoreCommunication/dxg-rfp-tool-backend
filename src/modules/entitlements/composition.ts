import { createOrganizationPlanManagement } from "./application/manageOrganizationPlans";
import { isValidOrganizationId, mongoOrganizationPlanDirectory } from "./infrastructure/mongoOrganizationPlanDirectory";

export const organizationPlanManagement = createOrganizationPlanManagement({
  directory: mongoOrganizationPlanDirectory,
  isValidId: isValidOrganizationId,
});
