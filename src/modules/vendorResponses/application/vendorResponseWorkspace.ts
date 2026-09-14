import type { VendorResponseWorkspaceV1 } from "../../../../contracts/generated/vendor-response-workspace-v1";
import { validateVendorResponseWorkspaceV1 } from "../../../../contracts/vendor-response/v1/validators";
import { mapLegacyProposalToV1 } from "../../../../contracts/proposal/v1/legacyAdapter";
import { pseudonym, safeLog } from "../../../shared/observability/safeTelemetry";
import {
  projectProposalToVendorResponseQuestionnaire,
  questionnaireProjectionChecksum,
} from "../domain/questionnaire";
import type { VendorResponseFormat } from "../domain/rollout";
import { resolveVendorStructuredResponseRollout } from "../domain/rollout";
import { validateVendorResponseQuestionnaire } from "../domain/structuredResponse";
import type {
  VendorResponseQuestionnaireProposalSnapshot,
  VendorResponseQuestionnaireRepository,
} from "../domain/ports/vendorResponseQuestionnaireRepository";

export class VendorResponseWorkspaceError extends Error {
  constructor(
    public readonly code:
      | "PROPOSAL_NOT_FOUND"
      | "QUESTIONNAIRE_SOURCE_INVALID"
      | "QUESTIONNAIRE_INVALID"
      | "STRUCTURED_RESPONSE_DISABLED"
      | "WORKSPACE_INVALID",
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const dateOnly = (date: Date): string => date.toISOString().slice(0, 10);

const nestedString = (
  value: Record<string, unknown>,
  parent: string,
  child: string,
): string => {
  const record = value[parent];
  return record && typeof record === "object"
    && typeof (record as Record<string, unknown>)[child] === "string"
    ? String((record as Record<string, unknown>)[child]).trim()
    : "";
};

const proposalTitle = (
  source: VendorResponseQuestionnaireProposalSnapshot,
): string => nestedString(source.legacyProposal, "event", "eventName")
  || "Vendor response";

const accessFor = (
  source: VendorResponseQuestionnaireProposalSnapshot,
  dueDate: string,
  at: Date,
): VendorResponseWorkspaceV1["access"] => {
  const expired = Boolean(dueDate && dueDate < dateOnly(at));
  const closed = source.isArchived
    || !source.isActive
    || !source.isOpen
    || source.isDraft
    || source.status === "unsubmitted";
  if (expired) {
    return {
      state: "expired",
      canEdit: false,
      canSubmit: false,
      message: "The response deadline has passed.",
    };
  }
  if (closed) {
    return {
      state: "closed",
      canEdit: false,
      canSubmit: false,
      message: "This proposal is not accepting vendor responses.",
    };
  }
  return { state: "open", canEdit: true, canSubmit: true };
};

export const createVendorResponseQuestionnaireService = (
  repository: VendorResponseQuestionnaireRepository,
  now: () => Date = () => new Date(),
) => {
  const loadProposal = async (input: {
    organizationId: string;
    proposalId: string;
    ownerUserId?: string;
  }) => {
    const source = await repository.loadProposal(input);
    if (!source) {
      throw new VendorResponseWorkspaceError(
        "PROPOSAL_NOT_FOUND",
        404,
        "Proposal not found",
      );
    }
    return source;
  };

  const publishSource = async (
    source: VendorResponseQuestionnaireProposalSnapshot,
    input: { actorId: string },
  ) => {
    const publicationTime = now();
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

  const publish = async (input: {
    organizationId: string;
    proposalId: string;
    actorId: string;
    ownerUserId?: string;
  }) => publishSource(await loadProposal(input), input);

  const assertStructuredEnabled = async (input: {
    organizationId: string;
    proposalId: string;
    ownerUserId?: string;
  }) => {
    const source = await loadProposal(input);
    const capabilities = resolveVendorStructuredResponseRollout(source.responseFormat);
    if (!capabilities.structuredResponse) {
      throw new VendorResponseWorkspaceError(
        "STRUCTURED_RESPONSE_DISABLED",
        409,
        "Structured vendor responses are not enabled for this proposal",
      );
    }
    return source;
  };

  return {
    publish,
    assertStructuredEnabled,
    async configure(input: {
      organizationId: string;
      proposalId: string;
      actorId: string;
      ownerUserId: string;
      responseFormat: VendorResponseFormat;
    }) {
      const source = await loadProposal(input);
      const publication = input.responseFormat === "structured_v1"
        ? (await publishSource(
            { ...source, responseFormat: input.responseFormat },
            input,
          )).publication
        : null;
      const updated = await repository.setResponseFormat(input);
      if (!updated) {
        throw new VendorResponseWorkspaceError(
          "PROPOSAL_NOT_FOUND",
          404,
          "Proposal not found",
        );
      }
      safeLog("info", "vendor_response_rollout_configured", {
        organizationPseudonym: pseudonym(source.organizationId),
        proposalPseudonym: pseudonym(source.proposalId),
        responseFormat: input.responseFormat,
        operation: "configure",
        outcome: "success",
      });
      return { responseFormat: input.responseFormat, publication };
    },
    async workspace(input: {
      organizationId: string;
      proposalId: string;
      grantActorId: string;
    }): Promise<VendorResponseWorkspaceV1> {
      const source = await loadProposal(input);
      const capabilities = resolveVendorStructuredResponseRollout(source.responseFormat);
      const at = now();
      const fallbackDueDate = nestedString(
        source.legacyProposal,
        "budget",
        "proposalSubmissionDueDate",
      );
      let questionnaire: VendorResponseWorkspaceV1["questionnaire"] = null;
      if (capabilities.structuredResponse) {
        questionnaire = (await publishSource(source, {
          actorId: input.grantActorId,
        })).publication.questionnaire;
      }
      const workspace: VendorResponseWorkspaceV1 = {
        schemaVersion: "vendor-response-workspace.v1",
        proposalTitle: questionnaire?.context.proposalTitle ?? proposalTitle(source),
        capabilities,
        access: accessFor(
          source,
          questionnaire?.context.proposalDueDate ?? fallbackDueDate,
          at,
        ),
        questionnaire,
        draft: null,
        currentSubmission: null,
      };
      safeLog("info", "vendor_response_workspace_resolved", {
        organizationPseudonym: pseudonym(source.organizationId),
        proposalPseudonym: pseudonym(source.proposalId),
        responseFormat: capabilities.responseFormat,
        rolloutReason: capabilities.reason,
        outcome: workspace.access.state,
      });
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
