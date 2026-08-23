import Proposal from "../../../modal/proposalsModel";
import { normalizeCandidate } from "../candidateApplication/canonicalMapping";
import { CandidateApplicationError } from "../candidateApplication/domain";
import { isLoadInAfterShow } from "./domain";
import { resolveVenueLocation } from "./venueLocationResolver";
import { isRetiredProposalWorkflowPath } from "../proposals/domain/workflowSections";

export type AppliedAnswerField = { path: string; mongoPath: string; value: unknown };

// Writes a clarification-question answer into the owner's unsubmitted draft
// proposal as human data entry. The value passes through normalizeCandidate so
// only approved paths and valid values ever reach Mongo; an invalid value
// throws CandidateApplicationError (422) with a friendly message so the UI can
// re-ask. Follows the guarded findOneAndUpdate + version-increment pattern of
// mongoProposalCandidateMutation. Returns null when the proposal is no longer
// an owned unsubmitted draft — the answer then stays chat-only.
type AnswerFieldInput = { path: string; answer: string };

const isEmptyProposalValue = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" &&
    ["", "untitled proposal"].includes(value.trim().toLowerCase()));

const readMongoPath = (row: Record<string, unknown>, mongoPath: string): unknown =>
  mongoPath.split(".").reduce<unknown>(
    (value, key) =>
      value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined,
    row,
  );

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
  const incomingEventStart = answers.find(
    (item) => item.path === "/content/event/startDate",
  )?.answer;
  const showDate = incomingEventStart || (
    typeof venueSchedule.showStartDate === "string" && venueSchedule.showStartDate
      ? venueSchedule.showStartDate
      : typeof event.startDate === "string" ? event.startDate : ""
  );
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
  onlyIfEmpty?: boolean;
}): Promise<AppliedAnswerField[] | null> => {
  if (input.answers.length === 0) return [];
  if (input.answers.some((item) => isRetiredProposalWorkflowPath(item.path))) {
    throw new CandidateApplicationError(
      "CANDIDATE_PATH_NOT_APPROVED",
      "This proposal field is not available in the active workflow.",
    );
  }
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
  // Automatic document/conversation extraction may only fill a blank target.
  // Keep this guard inside the Mongo update, not in a prior read, so a manual
  // edit racing the extraction can never be overwritten.
  const normalizedString = (mongoPath: string) => ({
    $toLower: {
      $trim: {
        input: {
          $convert: {
            input: { $ifNull: [`$${mongoPath}`, ""] },
            to: "string",
            onError: "__material_value__",
            onNull: "",
          },
        },
      },
    },
  });
  const empty = (mongoPath: string) => ({
    $in: [normalizedString(mongoPath), ["", "untitled proposal"]],
  });
  const directSet = Object.fromEntries(
    normalizedFields.map((field) => [
      field.mongoPath,
      input.onlyIfEmpty
        ? { $cond: [empty(field.mongoPath), field.mongoValue, `$${field.mongoPath}`] }
        : field.mongoValue,
    ]),
  );
  const currentVersion = { $ifNull: ["$version", 1] };
  const locationCompatible = location
    ? {
        $or: [
          empty("venueSchedule.venueCity"),
          { $eq: ["$venueSchedule.venueCity", location.city] },
        ],
      }
    : null;
  const derivedSet = location
    ? {
        "venueSchedule.venueState": {
          $cond: [
            {
              $and: [
                empty("venueSchedule.venueState"),
                ...(input.onlyIfEmpty && locationCompatible ? [locationCompatible] : []),
              ],
            },
            location.state,
            "$venueSchedule.venueState",
          ],
        },
        "venueSchedule.timeZone": {
          $cond: [
            {
              $and: [
                empty("venueSchedule.timeZone"),
                ...(input.onlyIfEmpty && locationCompatible ? [locationCompatible] : []),
              ],
            },
            location.timeZone,
            "$venueSchedule.timeZone",
          ],
        },
      }
    : {};
  const changes = [
    ...normalizedFields.map((field) =>
      input.onlyIfEmpty
        ? {
            $and: [
              empty(field.mongoPath),
              { $ne: [`$${field.mongoPath}`, field.mongoValue] },
            ],
          }
        : { $ne: [`$${field.mongoPath}`, field.mongoValue] },
    ),
    ...(location
      ? [
          input.onlyIfEmpty && locationCompatible
            ? { $and: [empty("venueSchedule.venueState"), locationCompatible] }
            : empty("venueSchedule.venueState"),
          input.onlyIfEmpty && locationCompatible
            ? { $and: [empty("venueSchedule.timeZone"), locationCompatible] }
            : empty("venueSchedule.timeZone"),
        ]
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
    // The pre-image tells the caller which blank fields this operation really
    // filled. The update itself remains atomic because the conditional writes
    // above are evaluated against that same document state.
    { new: false },
  )
    .select(["version", ...normalizedFields.map((field) => field.mongoPath)].join(" "))
    .lean<Record<string, unknown>>();
  if (!row) return null;
  const appliedFields = input.onlyIfEmpty
    ? normalizedFields.filter((field) =>
        isEmptyProposalValue(readMongoPath(row, field.mongoPath)),
      )
    : normalizedFields;
  return appliedFields.map((field) => ({
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
