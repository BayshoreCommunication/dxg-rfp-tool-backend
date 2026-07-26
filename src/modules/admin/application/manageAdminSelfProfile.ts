import type { PasswordHasher, PasswordVerifier } from "../../../shared/security/passwordHasher";
import type {
  AdminAvatarStorage,
  AdminSelfProfileRepository,
  TimestampSource,
} from "../domain/ports/adminSelfProfilePorts";

const avatarExtension = (name: string): string => {
  const match = name.toLowerCase().match(/\.[a-z0-9]{1,10}$/);
  return match?.[0] ?? ".png";
};

const avatarKey = (
  userId: string,
  originalName: string,
  folder: string,
  nowMs: number,
): string => {
  const prefix = folder.replace(/^\/+|\/+$/g, "");
  const key = `admin/${userId}/avatar-${nowMs}${avatarExtension(originalName)}`;
  return prefix ? `${prefix}/${key}` : key;
};

export const createGetAdminSelfProfile = (repository: AdminSelfProfileRepository) =>
  (userId: string) => repository.findSafe(userId);

type UpdateResult =
  | { kind: "not_found" }
  | { kind: "old_password_required" }
  | { kind: "wrong_old_password" }
  | { kind: "invalid_password" }
  | { kind: "empty_name" }
  | { kind: "updated"; user: Record<string, unknown> };

export const createUpdateAdminSelfProfile = (dependencies: {
  repository: AdminSelfProfileRepository;
  avatars: AdminAvatarStorage;
  passwords: PasswordHasher;
  passwordVerifier: PasswordVerifier;
  timestamps: TimestampSource;
  storageFolder: string;
}) => async (input: {
  userId: string;
  body: Record<string, unknown>;
  file?: { localPath: string; originalName: string };
}): Promise<UpdateResult> => {
  const credentials = await dependencies.repository.findCredentials(input.userId);
  if (!credentials) return { kind: "not_found" };

  const newPasswordValue = input.body.newPassword ?? input.body.password;
  const nextPassword = typeof newPasswordValue === "string" ? newPasswordValue.trim() : "";
  const patch: { name?: string; phone?: string; avatar?: string; passwordHash?: string } = {};
  if (nextPassword) {
    const oldPassword = typeof input.body.oldPassword === "string"
      ? input.body.oldPassword.trim()
      : "";
    if (!oldPassword) return { kind: "old_password_required" };
    if (nextPassword.length < 8) return { kind: "invalid_password" };
    if (!await dependencies.passwordVerifier.verify(oldPassword, credentials.passwordHash)) {
      return { kind: "wrong_old_password" };
    }
    patch.passwordHash = await dependencies.passwords.hash(nextPassword);
  }
  if (input.body.name !== undefined) {
    const name = String(input.body.name).trim();
    if (!name) return { kind: "empty_name" };
    patch.name = name;
  }
  if (input.body.phone !== undefined) patch.phone = String(input.body.phone).trim();
  if (input.body.avatar !== undefined) patch.avatar = String(input.body.avatar).trim();
  if (input.file) {
    patch.avatar = await dependencies.avatars.upload({
      localPath: input.file.localPath,
      objectKey: avatarKey(
        input.userId,
        input.file.originalName,
        dependencies.storageFolder,
        dependencies.timestamps.nowMs(),
      ),
    });
  }
  return {
    kind: "updated",
    user: await dependencies.repository.update(input.userId, patch),
  };
};
