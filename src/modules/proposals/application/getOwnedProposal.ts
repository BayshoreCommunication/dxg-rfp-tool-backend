import type { ProposalReadRepository } from "../domain/ports/proposalReadRepository";
import type { ProposalSettingsRepository } from "../domain/ports/proposalSettingsRepository";
import { applyDerivedExpiryState, withLiveSettings } from "./proposalPresentation";

export type GetOwnedProposalResult =
  | { kind: "found"; proposal: ReturnType<typeof withLiveSettings> }
  | { kind: "not_found" };

export type GetOwnedProposalDependencies = {
  proposals: ProposalReadRepository;
  settings: ProposalSettingsRepository;
};

export const createGetOwnedProposal = (
  dependencies: GetOwnedProposalDependencies,
) => async (input: {
  proposalId: string;
  ownerUserId: string;
}): Promise<GetOwnedProposalResult> => {
  const [proposal, settings] = await Promise.all([
    dependencies.proposals.findOwnedById(input),
    dependencies.settings.findByUserId(input.ownerUserId),
  ]);
  if (!proposal) return { kind: "not_found" };
  const visibleProposal = applyDerivedExpiryState(
    proposal,
    settings?.proposals?.expiryDate,
  );
  return {
    kind: "found",
    proposal: withLiveSettings(visibleProposal, settings),
  };
};
