import type { DashboardReadRepository } from "../domain/ports/dashboardReadRepository";

export const createGetOwnedDashboardOverview = (
  repository: DashboardReadRepository,
) => (ownerUserId: string) => repository.getOwnedOverview(ownerUserId);
