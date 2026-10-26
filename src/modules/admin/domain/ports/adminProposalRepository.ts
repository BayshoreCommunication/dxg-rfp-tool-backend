export type AdminProposalView = "all" | "draft" | "published" | "archived";

export type AdminProposalItem = {
  id: string;
  eventName: string;
  status: string;
  isDraft: boolean;
  isActive: boolean;
  isArchived: boolean;
  isCopy: boolean;
  viewsCount: number;
  startDate: string | null;
  endDate: string | null;
  attendees: string | null;
  eventFormat: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  planner: { id: string; name: string | null; email: string | null; company: string | null } | null;
};

export type AdminProposalCounts = Record<AdminProposalView, number>;

/** One proposal as stored, with its planner, for the read-only admin view. */
export type AdminProposalDetail = {
  proposal: Record<string, unknown> & { id: string };
  planner: AdminProposalItem["planner"];
};

export interface AdminProposalRepository {
  findById(id: string): Promise<AdminProposalDetail | null>;
  list(input: {
    page: number;
    perPage: number;
    search: string;
    view: AdminProposalView;
  }): Promise<{ proposals: AdminProposalItem[]; total: number; counts: AdminProposalCounts }>;
}
