export type AdminClientList = {
  clients: Record<string, unknown>[];
  total: number;
};

export type AdminClientTarget = {
  id: string;
  role?: string;
  isBlocked?: boolean;
};

export interface AdminClientRepository {
  list(input: { page: number; perPage: number; search: string }): Promise<AdminClientList>;
  findById(id: string): Promise<AdminClientTarget | null>;
  setBlocked(id: string, isBlocked: boolean): Promise<AdminClientTarget>;
  deleteById(id: string): Promise<void>;
}
