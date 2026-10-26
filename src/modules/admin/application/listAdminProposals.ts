import type {
  AdminProposalRepository,
  AdminProposalView,
} from "../domain/ports/adminProposalRepository";

const PER_PAGE = 20;
const VIEWS: AdminProposalView[] = ["all", "draft", "published", "archived"];

/** Every planner's proposals in the organization, newest activity first. */
export const createListAdminProposals = (repository: AdminProposalRepository) =>
  async (input: { page?: unknown; search?: unknown; view?: unknown }) => {
    const parsedPage = Number.parseInt(String(input.page ?? "1"), 10);
    const page = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage;
    const search = String(input.search ?? "").trim().slice(0, 200);
    const requested = String(input.view ?? "all") as AdminProposalView;
    const view = VIEWS.includes(requested) ? requested : "all";
    const result = await repository.list({ page, perPage: PER_PAGE, search, view });
    const totalPages = Math.ceil(result.total / PER_PAGE) || 1;
    return {
      data: result.proposals,
      counts: result.counts,
      pagination: {
        page,
        perPage: PER_PAGE,
        total: result.total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
      filters: { search, view },
    };
  };

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** A single proposal for the read-only admin view; null when it is not in this organization. */
export const createGetAdminProposal = (repository: AdminProposalRepository) =>
  async (id: unknown) => {
    const proposalId = String(id ?? "");
    if (!OBJECT_ID.test(proposalId)) return null;
    return repository.findById(proposalId);
  };
