import Proposal from "../../../../../modal/proposalsModel";
import type {
  LegacyPublicProposal,
  PublicProposalAccessRepository,
} from "../../domain/ports/publicProposalAccessRepository";

const DETAIL_PROPOSAL_SELECT = "-__v";

const mapResult = (proposal: unknown): LegacyPublicProposal | null => {
  if (!proposal || typeof proposal !== "object") return null;
  const record = proposal as Record<string, unknown>;
  return {
    ownerUserId: record.userId ? String(record.userId) : "",
    proposal: record,
  };
};

export const mongoPublicProposalAccessRepository: PublicProposalAccessRepository = {
  async findByLegacyPublicId(proposalId) {
    const proposal = await Proposal.findById(proposalId)
      .select(DETAIL_PROPOSAL_SELECT)
      .lean();
    return mapResult(proposal);
  },

  async incrementViewsByLegacyPublicId(proposalId) {
    const proposal = await Proposal.findByIdAndUpdate(
      proposalId,
      { $inc: { viewsCount: 1 } },
      { new: true },
    )
      .select(DETAIL_PROPOSAL_SELECT)
      .lean();
    return mapResult(proposal);
  },
};
