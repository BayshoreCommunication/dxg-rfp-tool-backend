import type { AdminOverviewReadRepository } from "../domain/ports/adminOverviewReadRepository";

export const createGetAdminOverview = (
  repository: AdminOverviewReadRepository,
) => () => repository.getOverview();
