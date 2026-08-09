import Proposal from "../../../modal/proposalsModel";
import { normalizeCandidate } from "../candidateApplication/canonicalMapping";
import { CandidateApplicationError } from "../candidateApplication/domain";
import { isLoadInAfterShow } from "./domain";
import { resolveVenueLocation } from "./venueLocationResolver";

export type AppliedAnswerField = { path: string; mongoPath: string; value: unknown };

// Writes a clarification-question answer into the owner's unsubmitted draft
// proposal as human data entry. The value passes through normalizeCandidate so
// only approved paths and valid values ever reach Mongo; an invalid value
// throws CandidateApplicationError (422) with a friendly message so the UI can
// re-ask. Follows the guarded findOneAndUpdate + version-increment pattern of
// mongoProposalCandidateMutation. Returns null when the proposal is no longer
// an owned unsubmitted draft — the answer then stays chat-only.
type AnswerFieldInput = { path: string; answer: string };

const ownedDraftFilter = (input: {
  organizationMongoId: string;
  actorUserMongoId: string;
  proposalMongoId: string;
}) => ({
  _id: input.proposalMongoId,
  userId: input.actorUserMongoId,
  organizationId: input.organizationMongoId,
  status: "unsubmitted",
  isDraft: true,
  isArchived: { $ne: true },
});

const validateLoadInOrdering = async (
  input: { organizationMongoId: string; actorUserMongoId: string; proposalMongoId: string },
  answers: AnswerFieldInput[],
): Promise<boolean> => {
  const date = answers.find((item) => item.path === "/content/venueSchedule/loadInDate")?.answer;
  const time = answers.find((item) => item.path === "/content/venueSchedule/loadInTime")?.answer;
  if (!date || !time) return true;
  const proposal = await Proposal.findOne(ownedDraftFilter(input))
    .select("event.startDate venueSchedule.showStartDate venueSchedule.showStartTime")
    .lean<{ event?: Record<string, unknown>; venueSchedule?: Record<string, unknown> }>();
  if (!proposal) return false;
  const venueSchedule = proposal.venueSchedule && typeof proposal.venueSchedule === "object" ? proposal.venueSchedule : {};
  const event = proposal.event && typeof proposal.event === "object" ? proposal.event : {};
  const showDate = typeof venueSchedule.showStartDate === "string" && venueSchedule.showStartDate
    ? venueSchedule.showStartDate
    : typeof event.startDate === "string" ? event.startDate : "";
  const showTime = typeof venueSchedule.showStartTime === "string" ? venueSchedule.showStartTime : "";
  if (isLoadInAfterShow({ loadInDate: date, loadInTime: time, showDate, showTime })) {
    throw new CandidateApplicationError(
      "INVALID_CANDIDATE_VALUE",
      "Production load-in cannot be after the event starts.",
    );
  }
  return true;
};

// Applies one typed answer or one deliberately supported composite answer in a
// single Mongo update. Composite answers advance the proposal version once,
// so the paired load-in date/time can never be observed half-written.
export const applyAnswersToProposalFields = async (input: {
  organizationMongoId: string;
  actorUserMongoId: string;
  proposalMongoId: string;
  answers: AnswerFieldInput[];
}): Promise<AppliedAnswerField[] | null> => {
  if (input.answers.length === 0) return [];
  const draftExists = await validateLoadInOrdering(input, input.answers);
  if (!draftExists) return null;
  const locationAnswer = input.answers.find((item) => item.path === "/content/venueSchedule/venueCity");
  const location = locationAnswer
    ? resolveVenueLocation(locationAnswer.answer)
    : null;
  const normalizedFields = input.answers.map((item) => {
    const value = item.path === "/content/venueSchedule/venueCity" && location ? location.city : item.answer;
    return normalizeCandidate(item.path, value);
  });
  const directSet = Object.fromEntries(normalizedFields.map((field) => [field.mongoPath, field.mongoValue]));
  const currentVersion = { $ifNull: ["$version", 1] };
  const empty = (mongoPath: string) => ({ $eq: [{ $ifNull: [`$${mongoPath}`, ""] }, ""] });
  const derivedSet = location
    ? {
        "venueSchedule.venueState": {
          $cond: [empty("venueSchedule.venueState"), location.state, "$venueSchedule.venueState"],
        },
        "venueSchedule.timeZone": {
          $cond: [empty("venueSchedule.timeZone"), location.timeZone, "$venueSchedule.timeZone"],
        },
      }
    : {};
  const changes = [
    ...normalizedFields.map((field) => ({ $ne: [`$${field.mongoPath}`, field.mongoValue] })),
    ...(location
      ? [empty("venueSchedule.venueState"), empty("venueSchedule.timeZone")]
      : []),
  ];
  const row = await Proposal.findOneAndUpdate(
    ownedDraftFilter(input),
    [{
      $set: {
        ...directSet,
        ...derivedSet,
        // Mongo and the conversation repository live in different databases,
        // so the question-resolution request may be retried after Mongo
        // succeeded but Postgres did not. Re-applying the same answer must not
        // keep advancing the proposal version on every retry.
        version: {
          $cond: [
            { $or: changes },
            { $add: [currentVersion, 1] },
            currentVersion,
          ],
        },
      },
    }],
    { new: true },
  ).select("version").lean<{ version: number }>();
  if (!row) return null;
  return normalizedFields.map((field) => ({
    path: field.sourcePath,
    mongoPath: field.mongoPath,
    value: field.mongoValue,
  }));
};

export const applyAnswerToProposalField = async (input: {
  organizationMongoId: string;
  actorUserMongoId: string;
  proposalMongoId: string;
  path: string;
  answer: string;
}): Promise<AppliedAnswerField | null> => {
  const fields = await applyAnswersToProposalFields({ ...input, answers: [{ path: input.path, answer: input.answer }] });
  return fields?.[0] ?? null;
};
