import Proposal from "../../../../../modal/proposalsModel";
import VendorResponseQuestionnaireVersion from "../../../../../modal/vendorResponseQuestionnaireVersionModel";
import type { VendorResponseQuestionnaireV1 } from "../../../../../contracts/generated/vendor-response-questionnaire-v1";
import {
  publishQuestionnaireProjection,
  VENDOR_RESPONSE_QUESTIONNAIRE_PROJECTION_VERSION,
} from "../../domain/questionnaire";
import type {
  VendorResponseQuestionnairePublication,
  VendorResponseQuestionnaireRepository,
} from "../../domain/ports/vendorResponseQuestionnaireRepository";
import { configuredVendorResponseFormat } from "../../domain/rollout";

const proposalSelection = [
  "organizationId",
  "userId",
  "status",
  "isDraft",
  "isActive",
  "isOpen",
  "isArchived",
  "version",
  "proposalSettings",
  "event",
  "venueSchedule",
  "roomByRoom",
  "production",
  "hybridVirtual",
  "contentCreative",
  "videoRecordingStep",
  "venue",
  "uploads",
  "budget",
  "contact",
  "createdAt",
  "updatedAt",
].join(" ");

type LeanProposal = Record<string, unknown> & {
  _id: unknown;
  organizationId: unknown;
  userId: unknown;
};

type QuestionnaireRow = {
  sourceChecksum: string;
  questionnaireVersion: number;
  questionnaire: VendorResponseQuestionnaireV1;
};

const publication = (
  row: QuestionnaireRow,
  created: boolean,
): VendorResponseQuestionnairePublication => ({
  questionnaire: row.questionnaire,
  created,
});

const duplicateKey = (error: unknown): boolean =>
  (error as { code?: number } | null)?.code === 11000;

export const mongoVendorResponseQuestionnaireRepository: VendorResponseQuestionnaireRepository = {
  async loadProposal(input) {
    const row = await Proposal.findOne({
      _id: input.proposalId,
      organizationId: input.organizationId,
      ...(input.ownerUserId ? { userId: input.ownerUserId } : {}),
    })
      .select(proposalSelection)
      .lean<LeanProposal>();
    if (!row?.organizationId || !row.userId) return null;
    return {
      organizationId: String(row.organizationId),
      proposalId: String(row._id),
      ownerUserId: String(row.userId),
      status: String(row.status ?? ""),
      isDraft: row.isDraft === true,
      isActive: row.isActive !== false,
      isOpen: row.isOpen !== false,
      isArchived: row.isArchived === true,
      responseFormat: configuredVendorResponseFormat(row.proposalSettings),
      legacyProposal: {
        ...row,
        _id: String(row._id),
        organizationId: String(row.organizationId),
        userId: String(row.userId),
      },
    };
  },

  async setResponseFormat(input) {
    const result = await Proposal.updateOne(
      {
        _id: input.proposalId,
        organizationId: input.organizationId,
        userId: input.ownerUserId,
      },
      {
        $set: {
          "proposalSettings.vendorResponseFormat": input.responseFormat,
        },
      },
    );
    return result.matchedCount === 1;
  },

  async publish(input) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const latest = await VendorResponseQuestionnaireVersion.findOne({
        organizationId: input.organizationId,
        proposalId: input.proposalId,
      })
        .sort({ questionnaireVersion: -1 })
        .lean<QuestionnaireRow>();
      if (latest?.sourceChecksum === input.sourceChecksum) {
        return publication(latest, false);
      }

      const questionnaireVersion = Number(latest?.questionnaireVersion ?? 0) + 1;
      const questionnaire = publishQuestionnaireProjection(
        input.projection,
        questionnaireVersion,
        input.publishedAt.toISOString(),
      );
      try {
        const created = await VendorResponseQuestionnaireVersion.create({
          organizationId: input.organizationId,
          proposalId: input.proposalId,
          proposalVersion: input.proposalVersion,
          questionnaireId: questionnaire.questionnaireId,
          questionnaireVersion,
          questionnaireChecksum: questionnaire.questionnaireChecksum,
          sourceChecksum: input.sourceChecksum,
          schemaVersion: questionnaire.schemaVersion,
          projectionVersion: VENDOR_RESPONSE_QUESTIONNAIRE_PROJECTION_VERSION,
          responseFormat: "structured_v1",
          status: "published",
          questionnaire,
          publishedByActorId: input.publishedByActorId,
          publishedAt: input.publishedAt,
        });
        await VendorResponseQuestionnaireVersion.updateMany(
          {
            organizationId: input.organizationId,
            proposalId: input.proposalId,
            questionnaireVersion: { $lt: questionnaireVersion },
            status: "published",
          },
          {
            $set: {
              status: "superseded",
              supersededAt: input.publishedAt,
            },
          },
        );
        return publication(created.toObject() as QuestionnaireRow, true);
      } catch (error) {
        if (!duplicateKey(error) || attempt === 1) throw error;
      }
    }
    throw new Error("Unable to publish vendor response questionnaire");
  },
};
