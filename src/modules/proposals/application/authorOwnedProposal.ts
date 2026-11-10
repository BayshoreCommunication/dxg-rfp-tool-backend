import type { ProposalSettingsRepository } from "../domain/ports/proposalSettingsRepository";
import type { ProposalWriteRepository } from "../domain/ports/proposalWriteRepository";
import type { ProposalReferenceSynchronizer } from "../domain/ports/proposalReferenceSynchronizer";
import type { ProposalTeamAssignment } from "../domain/ports/proposalTeamAssignment";
import type { ProposalLifecycleRecorder } from "../domain/ports/proposalLifecycleRecorder";
import { withLiveSettings } from "./proposalPresentation";
import { activeProposalWorkflowContent } from "../domain/workflowSections";

type AuthorDependencies = {
  proposals: ProposalWriteRepository;
  settings: ProposalSettingsRepository;
  references?: ProposalReferenceSynchronizer;
  teams?: ProposalTeamAssignment;
  lifecycle?: ProposalLifecycleRecorder;
};

export class ProposalTeamNotAssignableError extends Error {
  readonly status = 422;
  readonly code = "TEAM_NOT_ASSIGNABLE";
  constructor() {
    super("The team doesn't exist in this organization or is archived");
    this.name = "ProposalTeamNotAssignableError";
  }
}

// A new proposal (created or copied) lands on its creator's team when they're on exactly one;
// a client can't pick the team at creation.
const defaultTeamId = async (dependencies: AuthorDependencies, ownerUserId: string) =>
  (await dependencies.teams?.defaultTeamFor(ownerUserId)) ?? null;

// Anyone allowed to edit the proposal may move it to another active team, or clear it with null.
const resolveTeamChange = async (dependencies: AuthorDependencies, proposalId: string, updates: Record<string, unknown>) => {
  if (!("teamId" in updates)) return;
  const teamId = updates.teamId;
  if (teamId === null || teamId === "") {
    updates.teamId = null;
    return;
  }
  if (typeof teamId !== "string" || !dependencies.teams || !(await dependencies.teams.isAssignable({ teamId, proposalId }))) {
    throw new ProposalTeamNotAssignableError();
  }
};

const removeSystemFields = (input: Record<string, unknown>) => {
  const proposal = { ...input };
  delete proposal._id;
  delete proposal.__v;
  delete proposal.createdAt;
  delete proposal.updatedAt;
  delete proposal.userId;
  delete proposal.proposalSetting;
  // Derived by the lifecycle module (ORG-403); a client can't set its own stage or award.
  delete proposal.lifecycle;
  return proposal;
};

const recordIdOf = (proposal: object) => String((proposal as { _id?: unknown })._id ?? "");

const settingsForResponse = (
  dependencies: AuthorDependencies,
  ownerUserId: string,
) => dependencies.settings.findByUserId(ownerUserId, { createIfMissing: true });

export const createCreateOwnedProposal = (dependencies: AuthorDependencies) =>
  async (input: {
    ownerUserId: string;
    proposal: Record<string, unknown>;
  }) => {
    const proposalData = activeProposalWorkflowContent(
      removeSystemFields(input.proposal),
    );
    if (typeof proposalData.isDraft !== "boolean") {
      proposalData.isDraft =
        !proposalData.status ||
        proposalData.status === "draft" ||
        proposalData.status === "unsubmitted";
    }
    if (proposalData.status === "draft" || !proposalData.status) {
      proposalData.status = "unsubmitted";
    }
    proposalData.teamId = await defaultTeamId(dependencies, input.ownerUserId);
    const proposal = await dependencies.proposals.createOwned({
      ownerUserId: input.ownerUserId,
      proposal: proposalData,
    });
    await dependencies.references?.synchronize({ proposal, ownerUserId: input.ownerUserId, eventType: "proposal.reference.updated" });
    await dependencies.lifecycle?.recordChange({ proposalId: recordIdOf(proposal), actorUserId: input.ownerUserId, reason: "created" });
    const settings = await settingsForResponse(dependencies, input.ownerUserId);
    return withLiveSettings(proposal, settings);
  };

export const createUpdateOwnedProposal = (dependencies: AuthorDependencies) =>
  async (input: {
    proposalId: string;
    ownerUserId: string;
    updates: Record<string, unknown>;
  }) => {
    // Omit the dormant root from $set. Existing stored data is deliberately
    // left in place for a future flag restoration, while disabled clients
    // cannot create or replace it.
    const updates = activeProposalWorkflowContent(
      removeSystemFields(input.updates),
    );
    delete updates.isCopy;
    await resolveTeamChange(dependencies, input.proposalId, updates);
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
    await dependencies.references?.synchronize({ proposal, ownerUserId: input.ownerUserId, eventType: "proposal.reference.updated" });
    await dependencies.lifecycle?.recordChange({ proposalId: input.proposalId, actorUserId: input.ownerUserId, reason: "updated" });
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
    const sourceData = activeProposalWorkflowContent(
      removeSystemFields(source as Record<string, unknown>),
    );
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
      teamId: await defaultTeamId(dependencies, input.ownerUserId),
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
    await dependencies.references?.synchronize({ proposal, ownerUserId: input.ownerUserId, eventType: "proposal.reference.updated" });
    await dependencies.lifecycle?.recordChange({ proposalId: recordIdOf(proposal), actorUserId: input.ownerUserId, reason: "copied" });
    const settings = await settingsForResponse(dependencies, input.ownerUserId);
    return {
      kind: "copied" as const,
      proposal: withLiveSettings(proposal, settings),
    };
  };
