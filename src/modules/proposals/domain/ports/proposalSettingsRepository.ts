import type { LegacyProposalSettings } from "../../application/proposalPresentation";

export interface ProposalSettingsRepository {
  findByUserId(
    userId: string,
    options?: { createIfMissing?: boolean },
  ): Promise<LegacyProposalSettings | null>;
}
