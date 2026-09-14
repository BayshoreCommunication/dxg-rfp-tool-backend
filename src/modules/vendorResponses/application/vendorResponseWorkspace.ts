import type { VendorResponseWorkspaceV1 } from "../../../../contracts/generated/vendor-response-workspace-v1";
import { validateVendorResponseWorkspaceV1 } from "../../../../contracts/vendor-response/v1/validators";
import { mapLegacyProposalToV1 } from "../../../../contracts/proposal/v1/legacyAdapter";
import {
  projectProposalToVendorResponseQuestionnaire,
  questionnaireProjectionChecksum,
} from "../domain/questionnaire";
import { validateVendorResponseQuestionnaire } from "../domain/structuredResponse";
import type { VendorResponseQuestionnaireRepository } from "../domain/ports/vendorResponseQuestionnaireRepository";

export class VendorResponseWorkspaceError extends Error {
  constructor(
    public readonly code:
      | "PROPOSAL_NOT_FOUND"
      | "QUESTIONNAIRE_SOURCE_INVALID"
      | "QUESTIONNAIRE_INVALID"
      | "WORKSPACE_INVALID",
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const dateOnly = (date: Date): string => date.toISOString().slice(0, 10);

export const createVendorResponseQuestionnaireService = (
  repository: VendorResponseQuestionnaireRepository,
  now: () => Date = () => new Date(),
) => {
  const publish = async (input: {
    organizationId: string;
    proposalId: string;
    actorId: string;
    ownerUserId?: string;
  }) => {
    const publicationTime = now();
    const source = await repository.loadProposal({
      organizationId: input.organizationId,
      proposalId: input.proposalId,
      ownerUserId: input.ownerUserId,
    });
    if (!source) {
      throw new VendorResponseWorkspaceError(
        "PROPOSAL_NOT_FOUND",
        404,
        "Proposal not found",
      );
    }
    const mapped = mapLegacyProposalToV1(source.legacyProposal, {
      organizationId: source.organizationId,
      ownerUserId: source.ownerUserId,
      now: publicationTime.toISOString(),
    });
    if (!mapped.success) {
      throw new VendorResponseWorkspaceError(
        "QUESTIONNAIRE_SOURCE_INVALID",
        422,
        "Proposal cannot be published as a vendor questionnaire",
      );
    }
    const projection = projectProposalToVendorResponseQuestionnaire(mapped.proposal);
    const errors = validateVendorResponseQuestionnaire({
      ...projection,
      questionnaireVersion: 1,
      questionnaireChecksum: "0".repeat(64),
      publishedAt: publicationTime.toISOString(),
    });
    if (errors.length > 0) {
      throw new VendorResponseWorkspaceError(
        "QUESTIONNAIRE_INVALID",
        422,
        "Generated vendor questionnaire is invalid",
      );
    }
    return {
      source,
      publication: await repository.publish({
        organizationId: source.organizationId,
        proposalId: source.proposalId,
        proposalVersion: mapped.proposal.version,
        projection,
        sourceChecksum: questionnaireProjectionChecksum(projection),
        publishedByActorId: input.actorId,
        publishedAt: publicationTime,
      }),
    };
  };

  return {
    publish,
    async workspace(input: {
      organizationId: string;
      proposalId: string;
      grantActorId: string;
    }): Promise<VendorResponseWorkspaceV1> {
      const { source, publication } = await publish({
        organizationId: input.organizationId,
        proposalId: input.proposalId,
        actorId: input.grantActorId,
      });
      const dueDate = publication.questionnaire.context.proposalDueDate;
      const expired = Boolean(dueDate && dueDate < dateOnly(now()));
      const closed = source.isArchived
        || !source.isActive
        || !source.isOpen
        || source.isDraft
        || source.status === "unsubmitted";
      const access = expired
        ? {
            state: "expired" as const,
            canEdit: false,
            canSubmit: false,
            message: "The response deadline has passed.",
          }
        : closed
          ? {
              state: "closed" as const,
              canEdit: false,
              canSubmit: false,
              message: "This proposal is not accepting vendor responses.",
            }
          : { state: "open" as const, canEdit: true, canSubmit: true };
      const workspace: VendorResponseWorkspaceV1 = {
        schemaVersion: "vendor-response-workspace.v1",
        access,
        questionnaire: publication.questionnaire,
        draft: null,
        currentSubmission: null,
      };
      if (!validateVendorResponseWorkspaceV1(workspace)) {
        throw new VendorResponseWorkspaceError(
          "WORKSPACE_INVALID",
          500,
          "Vendor response workspace could not be created",
        );
      }
      return workspace;
    },
  };
};
