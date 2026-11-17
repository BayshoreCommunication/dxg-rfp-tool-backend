/** One account in the staff client list, as the repository reads it. */
export type AdminClientRow = {
  id: unknown;
  name?: unknown;
  email?: unknown;
  company?: unknown;
  joinDate?: unknown;
  isBlocked?: unknown;
  /** How many proposals the account owns in the caller's organization. A number, never the proposals. */
  totalProposals?: unknown;
  totalEmailSent?: unknown;
};

export type AdminClientList = {
  clients: AdminClientRow[];
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
