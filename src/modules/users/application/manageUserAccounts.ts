import type { PasswordHasher } from "../../../shared/security/passwordHasher";
import type {
  UserAccountRepository,
  UserProfilePatch,
} from "../domain/ports/userAccountRepository";

export const isPrivilegedUserRole = (role?: string): boolean => {
  const normalized = String(role ?? "").toLowerCase().trim().replace(/[\s-]/g, "_");
  return normalized === "admin" || normalized === "super_admin" || normalized === "superadmin";
};

type ReadResult =
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "found"; user: Record<string, unknown> };

type UpdateResult =
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "email_conflict" }
  | { kind: "invalid_password" }
  | { kind: "updated"; user: Record<string, unknown> };

const buildPatch = async (
  input: Record<string, unknown>,
  passwordHasher: PasswordHasher,
): Promise<UserProfilePatch> => {
  const patch: UserProfilePatch = {};
  if (typeof input.name === "string" && input.name) patch.name = input.name;
  if (typeof input.email === "string" && input.email) {
    patch.email = input.email.toLowerCase().trim();
  }
  if (input.phone !== undefined) patch.phone = typeof input.phone === "string" ? input.phone : "";
  if (input.company !== undefined) patch.company = typeof input.company === "string" ? input.company : "";
  if (input.avatar !== undefined) patch.avatar = typeof input.avatar === "string" ? input.avatar : "";
  if (typeof input.password === "string" && input.password) {
    patch.passwordHash = await passwordHasher.hash(input.password);
  }
  return patch;
};

export const createListUsers = (repository: UserAccountRepository) =>
  async (actorRole?: string) => {
    if (!isPrivilegedUserRole(actorRole)) return { kind: "forbidden" } as const;
    return { kind: "found", users: await repository.list() } as const;
  };

export const createGetUser = (repository: UserAccountRepository) =>
  async (actorId: string, actorRole: string | undefined, targetId: string): Promise<ReadResult> => {
    if (actorId !== targetId && !isPrivilegedUserRole(actorRole)) return { kind: "forbidden" };
    const user = await repository.findById(targetId);
    return user ? { kind: "found", user: user.data } : { kind: "not_found" };
  };

export const createGetPrimaryAdmin = (repository: UserAccountRepository) =>
  async (actorId: string, actorRole: string | undefined, configuredEmail: string): Promise<ReadResult> => {
    const admin = await repository.findPrimaryAdmin(configuredEmail);
    if (!admin) return { kind: "not_found" };
    if (admin.id !== actorId && !isPrivilegedUserRole(actorRole)) return { kind: "forbidden" };
    return { kind: "found", user: admin.data };
  };

export const createUpdateUserProfile = (
  repository: UserAccountRepository,
  passwordHasher: PasswordHasher,
) => async (
  actorId: string,
  actorRole: string | undefined,
  targetId: string,
  input: Record<string, unknown>,
): Promise<UpdateResult> => {
  if (actorId !== targetId && !isPrivilegedUserRole(actorRole)) return { kind: "forbidden" };
  const target = await repository.findById(targetId);
  if (!target) return { kind: "not_found" };
  if (typeof input.password === "string" && input.password && input.password.length < 6) {
    return { kind: "invalid_password" };
  }
  const requestedEmail = typeof input.email === "string" && input.email
    ? input.email.toLowerCase().trim()
    : undefined;
  if (requestedEmail && requestedEmail !== target.email && await repository.emailBelongsToOther(requestedEmail, targetId)) {
    return { kind: "email_conflict" };
  }
  const patch = await buildPatch(input, passwordHasher);
  return { kind: "updated", user: await repository.update(targetId, patch) };
};

export const createUpdatePrimaryAdmin = (
  repository: UserAccountRepository,
  passwordHasher: PasswordHasher,
) => async (
  actorId: string,
  configuredEmail: string,
  input: Record<string, unknown>,
): Promise<UpdateResult> => {
  const target = await repository.findPrimaryAdmin(configuredEmail);
  if (!target) return { kind: "not_found" };
  if (target.id !== actorId) return { kind: "forbidden" };
  if (typeof input.password === "string" && input.password && input.password.length < 6) {
    return { kind: "invalid_password" };
  }
  const requestedEmail = typeof input.email === "string" && input.email
    ? input.email.toLowerCase().trim()
    : undefined;
  if (requestedEmail && requestedEmail !== target.email && await repository.emailBelongsToOther(requestedEmail, target.id)) {
    return { kind: "email_conflict" };
  }
  const patch = await buildPatch(input, passwordHasher);
  return { kind: "updated", user: await repository.update(target.id, patch) };
};

export const createDeleteUser = (repository: UserAccountRepository) =>
  async (actorId: string, actorRole: string | undefined, targetId: string) => {
    if (actorId === targetId) return { kind: "self_delete" } as const;
    if (!isPrivilegedUserRole(actorRole)) return { kind: "forbidden" } as const;
    return await repository.deleteById(targetId)
      ? { kind: "deleted" } as const
      : { kind: "not_found" } as const;
  };
