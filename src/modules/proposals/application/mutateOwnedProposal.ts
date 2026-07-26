import type { ProposalSettingsRepository } from "../domain/ports/proposalSettingsRepository";
import type { ProposalWriteRepository } from "../domain/ports/proposalWriteRepository";
import { withLiveSettings } from "./proposalPresentation";

export const PROPOSAL_STATUSES = [
  "unsubmitted",
  "submitted",
  "reviewed",
  "approved",
  "rejected",
] as const;

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

type MutationDependencies = {
  proposals: ProposalWriteRepository;
  settings: ProposalSettingsRepository;
};

export const createUpdateOwnedProposalStatus = (
  dependencies: MutationDependencies,
) => async (input: {
  proposalId: string;
  ownerUserId: string;
  status: unknown;
}) => {
  if (
    typeof input.status !== "string" ||
    !PROPOSAL_STATUSES.includes(input.status as ProposalStatus)
  ) {
    return { kind: "invalid_status" as const };
  }
  const status = input.status as ProposalStatus;
  const isPublishing = status !== "unsubmitted";
  const proposal = await dependencies.proposals.updateOwnedById({
    proposalId: input.proposalId,
    ownerUserId: input.ownerUserId,
    updates: {
      status,
      isDraft: !isPublishing,
      ...(isPublishing
        ? { isCopy: false, isActive: true, isOpen: true }
        : {}),
    },
  });
  if (!proposal) return { kind: "not_found" as const };
  const settings = await dependencies.settings.findByUserId(input.ownerUserId, {
    createIfMissing: true,
  });
  return {
    kind: "updated" as const,
    status,
    proposal: withLiveSettings(proposal, settings),
  };
};

export type ProposalMetaInput = {
  isActive?: unknown;
  isFavorite?: unknown;
  isAccepted?: unknown;
  isOpen?: unknown;
  viewsCount?: unknown;
  isDraft?: unknown;
};

export const createUpdateOwnedProposalMeta = (
  dependencies: MutationDependencies,
) => async (input: {
  proposalId: string;
  ownerUserId: string;
  metadata: ProposalMetaInput;
}) => {
  const existing = await dependencies.proposals.findOwnedLifecycleById(input);
  if (!existing) return { kind: "not_found" as const };

  const updates: Record<string, unknown> = {};
  const { metadata } = input;
  if (!existing.isCopy && typeof metadata.isActive === "boolean") {
    updates.isActive = metadata.isActive;
  }
  if (!existing.isCopy && typeof metadata.isFavorite === "boolean") {
    updates.isFavorite = metadata.isFavorite;
  }
  if (typeof metadata.isAccepted === "boolean") {
    updates.isAccepted = metadata.isAccepted;
  }
  if (!existing.isCopy && typeof metadata.isOpen === "boolean") {
    updates.isOpen = metadata.isOpen;
  }
  if (typeof metadata.isDraft === "boolean") {
    updates.isDraft = metadata.isDraft;
  }
  if (typeof metadata.viewsCount === "number" && metadata.viewsCount >= 0) {
    updates.viewsCount = metadata.viewsCount;
  }
  if (Object.keys(updates).length === 0) {
    return {
      kind: "no_valid_fields" as const,
      copyRestricted: existing.isCopy,
    };
  }

  const proposal = await dependencies.proposals.updateOwnedById({
    proposalId: input.proposalId,
    ownerUserId: input.ownerUserId,
    updates,
    runValidators: true,
  });
  if (!proposal) return { kind: "not_found" as const };
  const settings = await dependencies.settings.findByUserId(input.ownerUserId, {
    createIfMissing: true,
  });
  return {
    kind: "updated" as const,
    proposal: withLiveSettings(proposal, settings),
  };
};

export const createArchiveOwnedProposal = (proposals: ProposalWriteRepository) =>
  async (input: { proposalId: string; ownerUserId: string }) => ({
    kind: (await proposals.archiveOwnedById({ ...input, archivedAt: new Date() }))
      ? ("archived" as const)
      : ("not_found" as const),
  });

export const createRestoreOwnedProposal = (proposals: ProposalWriteRepository) =>
  async (input: { proposalId: string; ownerUserId: string }) => ({
    kind: (await proposals.restoreOwnedById(input))
      ? ("restored" as const)
      : ("not_found" as const),
  });

export const createPermanentlyDeleteOwnedProposal = (
  proposals: ProposalWriteRepository,
) => async (input: { proposalId: string; ownerUserId: string }) => ({
  kind: (await proposals.permanentlyDeleteOwnedArchivedById(input))
    ? ("deleted" as const)
    : ("not_found" as const),
});
