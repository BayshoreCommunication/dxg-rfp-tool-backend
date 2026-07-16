import type {
  AdminUserRepository,
  AdministrativeRole,
} from "../domain/ports/adminUserRepository";
import type { PasswordHasher } from "../../../shared/security/passwordHasher";
import { isAdministrativeRole } from "./manageAdminClients";

const ALLOWED_ROLES: readonly AdministrativeRole[] = ["admin", "super_admin"];

type ValidationCode = "required" | "invalid_role" | "short_password" | "empty_name";
type ValidationResult =
  | { kind: "validation"; code: ValidationCode }
;
type CreateAdminUserResult =
  | ValidationResult
  | { kind: "email_conflict" }
  | { kind: "created"; user: Record<string, unknown> };
type UpdateAdminUserResult =
  | ValidationResult
  | { kind: "not_found" }
  | { kind: "non_admin_target" }
  | { kind: "updated"; user: Record<string, unknown> };
type DeleteAdminUserResult =
  | { kind: "not_found" }
  | { kind: "non_admin_target" }
  | { kind: "self_delete" }
  | { kind: "deleted"; id: string };

const allowedRole = (role: unknown): role is AdministrativeRole =>
  ALLOWED_ROLES.includes(role as AdministrativeRole);

export const createListAdminUsers = (repository: AdminUserRepository) => () =>
  repository.list();

export const createCreateAdminUser = (repository: AdminUserRepository) =>
  async (input: {
    name?: unknown;
    email?: unknown;
    password?: unknown;
    role?: unknown;
  }): Promise<CreateAdminUserResult> => {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const email = typeof input.email === "string" ? input.email.toLowerCase().trim() : "";
    const password = typeof input.password === "string" ? input.password.trim() : "";
    if (!name || !email || !password) return { kind: "validation", code: "required" };
    if (!allowedRole(input.role)) return { kind: "validation", code: "invalid_role" };
    if (password.length < 6) return { kind: "validation", code: "short_password" };
    if (await repository.emailExists(email)) return { kind: "email_conflict" };
    const user = await repository.create({ name, email, password, role: input.role });
    return { kind: "created", user };
  };

export const createUpdateAdminUser = (
  repository: AdminUserRepository,
  passwordHasher: PasswordHasher,
) => async (
  id: string,
  input: { name?: unknown; phone?: unknown; role?: unknown; password?: unknown },
): Promise<UpdateAdminUserResult> => {
  const target = await repository.findById(id);
  if (!target) return { kind: "not_found" };
  if (!isAdministrativeRole(target.role)) return { kind: "non_admin_target" };

  const patch: {
    name?: string;
    phone?: string;
    role?: AdministrativeRole;
    passwordHash?: string;
  } = {};
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim()) {
      return { kind: "validation", code: "empty_name" };
    }
    patch.name = input.name.trim();
  }
  if (input.phone !== undefined) {
    patch.phone = typeof input.phone === "string" ? input.phone.trim() : "";
  }
  if (input.role !== undefined) {
    if (!allowedRole(input.role)) return { kind: "validation", code: "invalid_role" };
    patch.role = input.role;
  }
  if (input.password !== undefined) {
    const password = typeof input.password === "string" ? input.password.trim() : "";
    if (password.length < 6) return { kind: "validation", code: "short_password" };
    patch.passwordHash = await passwordHasher.hash(password);
  }
  const user = await repository.update(id, patch);
  return { kind: "updated", user };
};

export const createDeleteAdminUser = (repository: AdminUserRepository) =>
  async (actorUserId: string, targetUserId: string): Promise<DeleteAdminUserResult> => {
    if (actorUserId === targetUserId) return { kind: "self_delete" };
    const target = await repository.findById(targetUserId);
    if (!target) return { kind: "not_found" };
    if (!isAdministrativeRole(target.role)) return { kind: "non_admin_target" };
    await repository.deleteById(targetUserId);
    return { kind: "deleted", id: targetUserId };
  };
