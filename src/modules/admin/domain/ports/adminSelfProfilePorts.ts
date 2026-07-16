export type AdminSelfProfile = Record<string, unknown>;

export interface AdminSelfProfileRepository {
  findSafe(userId: string): Promise<AdminSelfProfile | null>;
  findCredentials(userId: string): Promise<{
    passwordHash: string;
  } | null>;
  update(userId: string, patch: {
    name?: string;
    phone?: string;
    avatar?: string;
    passwordHash?: string;
  }): Promise<AdminSelfProfile>;
}

export interface AdminAvatarStorage {
  upload(input: { localPath: string; objectKey: string }): Promise<string>;
}

export interface TimestampSource {
  nowMs(): number;
}
