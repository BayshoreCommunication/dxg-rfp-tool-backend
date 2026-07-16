export type AdministrativeRole = "admin" | "super_admin";

export type AdminUserRecord = {
  id: string;
  role?: string;
  data: Record<string, unknown>;
};

export interface AdminUserRepository {
  list(): Promise<Record<string, unknown>[]>;
  emailExists(email: string): Promise<boolean>;
  findById(id: string): Promise<AdminUserRecord | null>;
  create(input: {
    name: string;
    email: string;
    password: string;
    role: AdministrativeRole;
  }): Promise<Record<string, unknown>>;
  update(
    id: string,
    patch: {
      name?: string;
      phone?: string;
      role?: AdministrativeRole;
      passwordHash?: string;
    },
  ): Promise<Record<string, unknown>>;
  deleteById(id: string): Promise<void>;
}
