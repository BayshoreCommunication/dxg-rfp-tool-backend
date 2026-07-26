import Proposal from "../../../modal/proposalsModel";
import { normalizeCandidate } from "../candidateApplication/canonicalMapping";

export type AppliedAnswerField = { path: string; mongoPath: string; value: unknown };

// Writes a clarification-question answer into the owner's unsubmitted draft
// proposal as human data entry. The value passes through normalizeCandidate so
// only approved paths and valid values ever reach Mongo; an invalid value
// throws CandidateApplicationError (422) with a friendly message so the UI can
// re-ask. Follows the guarded findOneAndUpdate + version-increment pattern of
// mongoProposalCandidateMutation. Returns null when the proposal is no longer
// an owned unsubmitted draft — the answer then stays chat-only.
export const applyAnswerToProposalField = async (input: {
  organizationMongoId: string;
  actorUserMongoId: string;
  proposalMongoId: string;
  path: string;
  answer: string;
}): Promise<AppliedAnswerField | null> => {
  const normalized = normalizeCandidate(input.path, input.answer);
  const currentValue = `$${normalized.mongoPath}`;
  const currentVersion = { $ifNull: ["$version", 1] };
  const row = await Proposal.findOneAndUpdate(
    {
      _id: input.proposalMongoId,
      userId: input.actorUserMongoId,
      organizationId: input.organizationMongoId,
      status: "unsubmitted",
      isDraft: true,
      isArchived: { $ne: true },
    },
    [{
      $set: {
        [normalized.mongoPath]: normalized.mongoValue,
        // Mongo and the conversation repository live in different databases,
        // so the question-resolution request may be retried after Mongo
        // succeeded but Postgres did not. Re-applying the same answer must not
        // keep advancing the proposal version on every retry.
        version: {
          $cond: [
            { $eq: [currentValue, normalized.mongoValue] },
            currentVersion,
            { $add: [currentVersion, 1] },
          ],
        },
      },
    }],
    { new: true },
  ).select("version").lean<{ version: number }>();
  if (!row) return null;
  return { path: input.path, mongoPath: normalized.mongoPath, value: normalized.mongoValue };
};
