import Organization from "../../../modal/organizationModel";
import { createRfpDashboard } from "./application";
import { mongoRfpDashboardRepository } from "./mongoRfpDashboardRepository";

export const rfpDashboard = createRfpDashboard({
  repository: mongoRfpDashboardRepository,
  organizationTimeZone: async (organizationId) =>
    (await Organization.findById(organizationId).select("timeZone").lean<{ timeZone?: string | null } | null>())?.timeZone ?? null,
});
