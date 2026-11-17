import type { AdminClientRepository, AdminClientRow } from "../domain/ports/adminClientRepository";

const PER_PAGE = 10;

export const isAdministrativeRole = (role?: string): boolean => {
  const normalized = String(role ?? "").toLowerCase().trim().replace(/[\s-]/g, "_");
  return normalized === "admin" || normalized === "super_admin" || normalized === "superadmin";
};

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/* What the staff client list returns for each account, built field by field (owner decision,
   2026-11-17): the account contact and usage counts. Staff see how many proposals an account
   has without a support grant, never which ones, so nothing a repository hands back beyond
   these fields can reach the response. */
export const toAdminClientItem = (row: AdminClientRow) => ({
  id: String(row.id),
  name: row.name ?? null,
  email: row.email ?? null,
  company: row.company ?? null,
  joinDate: row.joinDate ?? null,
  isBlocked: row.isBlocked === true,
  totalProposals: count(row.totalProposals),
  totalEmailSent: count(row.totalEmailSent),
});

export const createListAdminClients = (repository: AdminClientRepository) =>
  async (input: { page?: unknown; search?: unknown }) => {
    const parsedPage = Number.parseInt(String(input.page ?? "1"), 10);
    const page = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage;
    const search = String(input.search ?? "").trim();
    const result = await repository.list({ page, perPage: PER_PAGE, search });
    const totalPages = Math.ceil(result.total / PER_PAGE) || 1;
    return {
      data: result.clients.map(toAdminClientItem),
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
