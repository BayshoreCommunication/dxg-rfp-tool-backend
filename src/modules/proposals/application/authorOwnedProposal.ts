import type { ProposalSettingsRepository } from "../domain/ports/proposalSettingsRepository";
import type { ProposalWriteRepository } from "../domain/ports/proposalWriteRepository";
import { withLiveSettings } from "./proposalPresentation";

type AuthorDependencies = {
  proposals: ProposalWriteRepository;
  settings: ProposalSettingsRepository;
};

const removeSystemFields = (input: Record<string, unknown>) => {
  const proposal = { ...input };
  delete proposal._id;
  delete proposal.__v;
  delete proposal.createdAt;
  delete proposal.updatedAt;
  delete proposal.userId;
  delete proposal.proposalSetting;
  return proposal;
};

const settingsForResponse = (
  dependencies: AuthorDependencies,
  ownerUserId: string,
) => dependencies.settings.findByUserId(ownerUserId, { createIfMissing: true });

export const createCreateOwnedProposal = (dependencies: AuthorDependencies) =>
  async (input: {
    ownerUserId: string;
    proposal: Record<string, unknown>;
  }) => {
    const proposalData = removeSystemFields(input.proposal);
    if (typeof proposalData.isDraft !== "boolean") {
      proposalData.isDraft =
        !proposalData.status ||
        proposalData.status === "draft" ||
        proposalData.status === "unsubmitted";
    }
    if (proposalData.status === "draft" || !proposalData.status) {
      proposalData.status = "unsubmitted";
    }
    const proposal = await dependencies.proposals.createOwned({
      ownerUserId: input.ownerUserId,
      proposal: proposalData,
    });
    const settings = await settingsForResponse(dependencies, input.ownerUserId);
    return withLiveSettings(proposal, settings);
  };

export const createUpdateOwnedProposal = (dependencies: AuthorDependencies) =>
  async (input: {
    proposalId: string;
    ownerUserId: string;
    updates: Record<string, unknown>;
  }) => {
    const updates = removeSystemFields(input.updates);
    delete updates.isCopy;
    if (updates.status === "unsubmitted") {
      updates.isDraft = true;
      updates.isActive = false;
      updates.isCopy = false;
    } else if (updates.status === "submitted") {
      updates.isDraft = false;
      updates.isActive = true;
      updates.isCopy = false;
    }
    const proposal = await dependencies.proposals.updateOwnedById({
      proposalId: input.proposalId,
      ownerUserId: input.ownerUserId,
      updates,
      runValidators: true,
    });
    if (!proposal) return { kind: "not_found" as const };
    const settings = await settingsForResponse(dependencies, input.ownerUserId);
    return {
      kind: "updated" as const,
      proposal: withLiveSettings(proposal, settings),
    };
  };

export type CopyProposalOverrides = {
  eventName?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  templateId?: unknown;
  isDraft?: unknown;
};

export const createCopyOwnedProposal = (dependencies: AuthorDependencies) =>
  async (input: {
    proposalId: string;
    ownerUserId: string;
    overrides: CopyProposalOverrides;
  }) => {
    const source = await dependencies.proposals.findOwnedCopySourceById({
      proposalId: input.proposalId,
      ownerUserId: input.ownerUserId,
    });
    if (!source) return { kind: "not_found" as const };
    const sourceData = removeSystemFields(source as Record<string, unknown>);
    const copyData: Record<string, unknown> = {
      ...sourceData,
      status: "unsubmitted",
      isDraft:
        typeof input.overrides.isDraft === "boolean"
          ? input.overrides.isDraft
          : false,
      isActive: false,
      isFavorite: false,
      isAccepted: false,
      isOpen: false,
      isArchived: false,
      archivedAt: null,
      isCopy: true,
      viewsCount: 0,
    };
    if (
      input.overrides.templateId === "template-one" ||
      input.overrides.templateId === "template-two"
    ) {
      copyData.templateId = input.overrides.templateId;
    }
    const eventOverrides = Object.fromEntries(
      ["eventName", "startDate", "endDate"]
        .map((field) => [field, input.overrides[field as keyof CopyProposalOverrides]])
        .filter((entry): entry is [string, string] =>
          typeof entry[1] === "string" && entry[1].length > 0,
        ),
    );
    if (Object.keys(eventOverrides).length > 0) {
      const sourceEvent =
        typeof copyData.event === "object" && copyData.event !== null
          ? copyData.event
          : {};
      copyData.event = { ...sourceEvent, ...eventOverrides };
    }
    const proposal = await dependencies.proposals.createOwned({
      ownerUserId: input.ownerUserId,
      proposal: copyData,
    });
    const settings = await settingsForResponse(dependencies, input.ownerUserId);
    return {
      kind: "copied" as const,
      proposal: withLiveSettings(proposal, settings),
    };
  };
