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
  // RFPs the user owns in any organization; a user who owns any can't be deleted.
  countOwnedRfps(id: string): Promise<number>;
  deleteById(id: string): Promise<boolean>;
}
