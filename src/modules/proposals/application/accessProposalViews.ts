import type { ProposalNotificationPort } from "../domain/ports/proposalNotificationPort";
import type { PublicProposalAccessRepository } from "../domain/ports/publicProposalAccessRepository";
import type { ProposalSettingsRepository } from "../domain/ports/proposalSettingsRepository";
import type { ProposalWriteRepository } from "../domain/ports/proposalWriteRepository";
import {
  applyDerivedExpiryState,
  type LegacyProposalRecord,
  withLiveSettings,
} from "./proposalPresentation";

const proposalViewDetails = (
  proposal: LegacyProposalRecord,
  ownerUserId: string,
) => {
  const value = proposal as Record<string, unknown>;
  const event = value.event as { eventName?: unknown } | undefined;
  const title =
    typeof event?.eventName === "string" && event.eventName.trim()
      ? event.eventName.trim()
      : "Untitled Proposal";
  return {
    ownerUserId,
    proposalId: String(value._id ?? ""),
    proposalTitle: title,
    viewsCount:
      typeof value.viewsCount === "number" && value.viewsCount >= 0
        ? value.viewsCount
        : 0,
  };
};

const present = async (
  proposal: LegacyProposalRecord,
  ownerUserId: string,
  settings: ProposalSettingsRepository,
) => {
  const ownerSettings = ownerUserId
    ? await settings.findByUserId(ownerUserId)
    : null;
  return withLiveSettings(
    applyDerivedExpiryState(proposal, ownerSettings?.proposals?.expiryDate),
    ownerSettings,
  );
};

export const createGetProposalByLegacyPublicId = (dependencies: {
  publicAccess: PublicProposalAccessRepository;
  settings: ProposalSettingsRepository;
}) => async (proposalId: string) => {
  const result = await dependencies.publicAccess.findByLegacyPublicId(proposalId);
  if (!result) return { kind: "not_found" as const };
  return {
    kind: "found" as const,
    proposal: await present(
      result.proposal,
      result.ownerUserId,
      dependencies.settings,
    ),
  };
};

export const createIncrementLegacyPublicProposalViews = (dependencies: {
  publicAccess: PublicProposalAccessRepository;
  settings: ProposalSettingsRepository;
  notifications: ProposalNotificationPort;
}) => async (proposalId: string) => {
  const result =
    await dependencies.publicAccess.incrementViewsByLegacyPublicId(proposalId);
  if (!result) return { kind: "not_found" as const };
  if (result.ownerUserId) {
    await dependencies.notifications.notifyProposalViewed(
      proposalViewDetails(result.proposal, result.ownerUserId),
    );
  }
  return {
    kind: "incremented" as const,
    proposal: await present(
      result.proposal,
      result.ownerUserId,
      dependencies.settings,
    ),
  };
};

export const createIncrementOwnedProposalViews = (dependencies: {
  proposals: ProposalWriteRepository;
  settings: ProposalSettingsRepository;
  notifications: ProposalNotificationPort;
}) => async (input: { proposalId: string; ownerUserId: string }) => {
  const proposal = await dependencies.proposals.incrementOwnedViews(input);
  if (!proposal) return { kind: "not_found" as const };
  await dependencies.notifications.notifyProposalViewed(
    proposalViewDetails(proposal, input.ownerUserId),
  );
  return {
    kind: "incremented" as const,
    proposal: await present(proposal, input.ownerUserId, dependencies.settings),
  };
};
