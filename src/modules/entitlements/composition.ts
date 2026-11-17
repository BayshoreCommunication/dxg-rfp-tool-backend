import { passwordSignInEnabled } from "../../../middleware/passwordSignIn";
import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import { createOrganizationPlanManagement } from "./application/manageOrganizationPlans";
import { createOrganizationAccountDetail } from "./application/organizationAccountDetail";
import { mongoOrganizationAccountSource } from "./infrastructure/mongoOrganizationAccountSource";
import { isValidOrganizationId, mongoOrganizationPlanDirectory } from "./infrastructure/mongoOrganizationPlanDirectory";

export const organizationPlanManagement = createOrganizationPlanManagement({
  directory: mongoOrganizationPlanDirectory,
  isValidId: isValidOrganizationId,
});

export const organizationAccountDetail = createOrganizationAccountDetail({
  source: mongoOrganizationAccountSource,
  planHistory: mongoOrganizationPlanDirectory,
  audit: mongoSecurityAuditWriter,
  isValidId: isValidOrganizationId,
  passwordSignInEnabled,
});
