import { safeLog, telemetryErrorCode } from "../../../../shared/observability/safeTelemetry";
import Proposal from "../../../../../modal/proposalsModel";
import { explainProposalMiss, proposalFilterFor } from "../../../identity/application/proposalAccess";
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
    // Planner calls (publish, capability) edit the proposal and go through the access policy. The
    // vendor portal has no user: its grant already pins the organization and the proposal.
    const actingUser = input.ownerUserId ? { organizationId: input.organizationId, userId: input.ownerUserId } : null;
    const filter = actingUser
      ? await proposalFilterFor(actingUser, "edit", { _id: input.proposalId })
      : { _id: input.proposalId, organizationId: input.organizationId };
    const row = await Proposal.findOne(filter) // tenant-scoped: policy scope, or the grant's organization
      .select(proposalSelection)
      .lean<LeanProposal>();
    if (!row && actingUser) await explainProposalMiss(actingUser, input.proposalId, "edit");
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
      await proposalFilterFor({ organizationId: input.organizationId, userId: input.ownerUserId }, "edit", { _id: input.proposalId }), // tenant-scoped: policy scope
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
        // The version row is the commit point: once it exists the publish has
        // succeeded and the caller's questionnaire is correct. Marking older
        // rows superseded is bookkeeping that changes nothing the caller
        // receives — no read path selects the active version by status, and the
        // next publish's sweep picks up any stragglers. Letting a failure here
        // escape turned a successful publish into an error page for whichever
        // vendor happened to trigger the republish.
        try {
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
        } catch (error) {
          safeLog("warn", "vendor_questionnaire_supersede_failed", {
            versionNumber: questionnaireVersion,
            outcome: "failure",
            errorCode: telemetryErrorCode(error),
          });
        }
        return publication(created.toObject() as QuestionnaireRow, true);
      } catch (error) {
        if (!duplicateKey(error) || attempt === 1) throw error;
      }
    }
    throw new Error("Unable to publish vendor response questionnaire");
  },
};
