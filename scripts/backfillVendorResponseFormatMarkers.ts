/**
 * Adds rollout metadata only. This script never reads or writes vendor answers,
 * drafts, submission versions, documents, grants, or contact fields.
 * Dry-run is the default and repeated apply runs are idempotent.
 */
import "../config/env";
import mongoose from "mongoose";
import connectDB from "../config/db";
import Proposal from "../modal/proposalsModel";
import VendorResponseQuestionnaireVersion from "../modal/vendorResponseQuestionnaireVersionModel";

const apply = process.argv.includes("--apply");

const help = () => process.stdout.write(`Usage:
  npm run backfill:vendor-response-format-markers
  npm run backfill:vendor-response-format-markers -- --apply

Default mode is dry-run. Unmarked proposals receive legacy_unstructured and
unmarked questionnaire versions receive structured_v1. No vendor response data
is inspected or changed.
`);

const main = async () => {
  if (process.argv.includes("--help")) return help();
  await connectDB();
  const proposalFilter = {
    "proposalSettings.vendorResponseFormat": { $exists: false },
  };
  const questionnaireFilter = { responseFormat: { $exists: false } };
  const [proposalCandidates, questionnaireCandidates] = await Promise.all([
    Proposal.countDocuments(proposalFilter),
    VendorResponseQuestionnaireVersion.collection.countDocuments(
      questionnaireFilter,
    ),
  ]);
  let proposalsUpdated = 0;
  let questionnairesUpdated = 0;
  if (apply) {
    const [proposalResult, questionnaireResult] = await Promise.all([
      Proposal.collection.updateMany(proposalFilter, [
        {
          $set: {
            proposalSettings: {
              $mergeObjects: [
                {
                  $cond: [
                    { $eq: [{ $type: "$proposalSettings" }, "object"] },
                    "$proposalSettings",
                    {},
                  ],
                },
                { vendorResponseFormat: "legacy_unstructured" },
              ],
            },
          },
        },
      ]),
      // responseFormat is rollout metadata outside the immutable questionnaire
      // payload and checksum. A raw collection update avoids relaxing the model's
      // content-immutability guard for normal application writes.
      VendorResponseQuestionnaireVersion.collection.updateMany(
        questionnaireFilter,
        { $set: { responseFormat: "structured_v1" } },
      ),
    ]);
    proposalsUpdated = proposalResult.modifiedCount;
    questionnairesUpdated = questionnaireResult.modifiedCount;
  }
  process.stdout.write(`${JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    proposalCandidates,
    questionnaireCandidates,
    proposalsUpdated,
    questionnairesUpdated,
    answerRecordsRead: 0,
    answerRecordsChanged: 0,
  }, null, 2)}\n`);
};

void main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
