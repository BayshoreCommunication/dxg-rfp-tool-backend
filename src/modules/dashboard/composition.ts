import { createGetOwnedDashboardOverview } from "./application/getDashboardOverview";
import { mongoDashboardReadRepository } from "./infrastructure/mongo/mongoDashboardReadRepository";

export const getOwnedDashboardOverview = createGetOwnedDashboardOverview(
  mongoDashboardReadRepository,
);
