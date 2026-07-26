import type { AdminClientRepository } from "../domain/ports/adminClientRepository";

const PER_PAGE = 10;

export const isAdministrativeRole = (role?: string): boolean => {
  const normalized = String(role ?? "").toLowerCase().trim().replace(/[\s-]/g, "_");
  return normalized === "admin" || normalized === "super_admin" || normalized === "superadmin";
};

export const createListAdminClients = (repository: AdminClientRepository) =>
  async (input: { page?: unknown; search?: unknown }) => {
    const parsedPage = Number.parseInt(String(input.page ?? "1"), 10);
    const page = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage;
    const search = String(input.search ?? "").trim();
    const result = await repository.list({ page, perPage: PER_PAGE, search });
    const totalPages = Math.ceil(result.total / PER_PAGE) || 1;
    return {
      data: result.clients,
      pagination: {
        page,
        perPage: PER_PAGE,
        total: result.total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
      filters: { search },
    };
  };

type ClientTargetResult =
  | { kind: "not_found" }
  | { kind: "admin_target" };

type ClientBlockResult =
  | ClientTargetResult
  | { kind: "updated"; id: string; isBlocked: boolean }
;

type ClientDeleteResult =
  | ClientTargetResult
  | { kind: "deleted"; id: string };

export const createSetClientBlocked = (repository: AdminClientRepository) =>
  async (id: string, isBlocked: boolean): Promise<ClientBlockResult> => {
    const target = await repository.findById(id);
    if (!target) return { kind: "not_found" };
    if (isAdministrativeRole(target.role)) return { kind: "admin_target" };
    const updated = await repository.setBlocked(id, isBlocked);
    return { kind: "updated", id: updated.id, isBlocked: Boolean(updated.isBlocked) };
  };

export const createDeleteAdminClient = (repository: AdminClientRepository) =>
  async (id: string): Promise<ClientDeleteResult> => {
    const target = await repository.findById(id);
    if (!target) return { kind: "not_found" };
    if (isAdministrativeRole(target.role)) return { kind: "admin_target" };
    await repository.deleteById(id);
    return { kind: "deleted", id };
  };
