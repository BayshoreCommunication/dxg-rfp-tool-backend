export type UserAccount = {
  id: string;
  email: string;
  role?: string;
  data: Record<string, unknown>;
};

export type UserProfilePatch = {
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  avatar?: string;
  passwordHash?: string;
};

export interface UserAccountRepository {
  list(): Promise<Record<string, unknown>[]>;
  findById(id: string): Promise<UserAccount | null>;
  findPrimaryAdmin(configuredEmail: string): Promise<UserAccount | null>;
  emailBelongsToOther(email: string, userId: string): Promise<boolean>;
  update(id: string, patch: UserProfilePatch): Promise<Record<string, unknown>>;
  deleteById(id: string): Promise<boolean>;
}
