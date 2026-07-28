import { aiRuntimeAuthorized } from "../../../config/aiEnvironment";

export class RoomRecommendationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}

export const roomRecommendationsEnabled = () =>
  aiRuntimeAuthorized() && process.env.ROOM_RECOMMENDATIONS_ENABLED === "true";

export const SCHEMA_VERSION = "room-recommendation.v1";
// v2: crew roles became apply-eligible appends and automatic application into
// empty fields became the default flow. Bumping the engine version changes
// the generation fingerprint, so proposals regenerate instead of replaying
// stored v1 payloads whose eligibility flags predate the policy.
// v3: multi-function physical rooms use every function for core-fact and
// schedule validation, while shared AV sizing uses peak function attendance.
export const ENGINE_VERSION = "room-rules.v3";

/**
 * Every generated value carries exactly one classification. Only the first two
 * may ever become eligible for application, and even then application is
 * always an explicit human selection in this slice — recommendations never
 * write to the proposal on their own. `recommended_assumption` is a bounded
 * suggestion from an approved rule or knowledge entry, never a client fact.
 * `unknown` never carries a value; it surfaces as a clarification question.
 */
export const CLASSIFICATIONS = ["confirmed_fact", "deterministic_derivation", "recommended_assumption", "unknown"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export type RecommendationEvidence = { path: string; value: string };
export type RoomRecommendation = {
  recommendationKey: string;
  path: string;
  mongoPath: string;
  value: string;
  classification: Classification;
  confidence: number;
  explanation: string;
  evidence: RecommendationEvidence[];
  ruleIds: string[];
  knowledgeIds: string[];
  assumptions: string[];
  requiresHumanReview: boolean;
  applyEligible: boolean;
};
export type RoomClarificationQuestion = { questionKey: string; ruleId: string; prompt: string; paths: string[] };
export type RoomWarning = { code: string; ruleId: string; severity: "warning" | "blocking"; message: string; paths: string[] };
export type RoomBlock = {
  roomKey: string;
  roomIndex: number;
  roomLabel: string;
  recommendations: RoomRecommendation[];
  clarificationQuestions: RoomClarificationQuestion[];
  warnings: RoomWarning[];
};
export type RoomRecommendationResult = {
  schemaVersion: typeof SCHEMA_VERSION;
  engineVersion: typeof ENGINE_VERSION;
  proposalId: string;
  proposalVersion: number;
  rooms: RoomBlock[];
  globalClarificationQuestions: RoomClarificationQuestion[];
  globalWarnings: RoomWarning[];
  knowledgeIds: string[];
};

export type ReviewDecision = "pending" | "accepted" | "edited" | "rejected";

/**
 * The first enumerated reviewer-feedback vocabulary in the codebase. Free-text
 * reasons already exist elsewhere; these codes exist so producer outcomes can
 * be aggregated as governed evaluation data before any tuning is considered.
 */
export const REASON_CODES = [
  "correct",
  "excessive",
  "insufficient",
  "unsupported_assumption",
  "wrong_room_type",
  "client_constraint",
  "venue_constraint",
  "budget_constraint",
  "schedule_constraint",
  "other",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

const PATH_PATTERN = /^\/content\/roomByRoom\/\d{1,3}(?:\/[A-Za-z0-9_]+){1,4}$/;
const KEY_PATTERN = /^[A-Z0-9_]{3,80}:\d{1,3}(?::[A-Za-z0-9_/]{1,120})?$/;

const invalid = (message: string): never => {
  throw new RoomRecommendationError("INVALID_RECOMMENDATION_PAYLOAD", message);
};
const requireText = (value: unknown, field: string, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) return invalid(`${field} is invalid.`);
  return value;
};

/**
 * Strict structural validation of the versioned contract. The engine is
 * deterministic today, but the payload is persisted verbatim and rendered by
 * the dashboard, so the boundary validates as if a model had produced it —
 * a future AI enrichment stage must not be able to widen the shape.
 */
export const validateRoomRecommendationResult = (value: RoomRecommendationResult): RoomRecommendationResult => {
  if (!value || typeof value !== "object") return invalid("Payload must be an object.");
  if (value.schemaVersion !== SCHEMA_VERSION) return invalid("Unsupported schema version.");
  if (value.engineVersion !== ENGINE_VERSION) return invalid("Unsupported engine version.");
  if (!/^[0-9a-f]{24}$/i.test(String(value.proposalId))) return invalid("Proposal id is invalid.");
  if (!Number.isInteger(value.proposalVersion) || value.proposalVersion < 1) return invalid("Proposal version is invalid.");
  if (!Array.isArray(value.rooms) || value.rooms.length > 200) return invalid("Rooms are invalid.");
  const seenKeys = new Set<string>();
  const validateQuestion = (question: RoomClarificationQuestion) => {
    requireText(question.questionKey, "Question key", 160);
    requireText(question.ruleId, "Question rule id", 80);
    requireText(question.prompt, "Question prompt", 1000);
    if (!Array.isArray(question.paths) || question.paths.length > 10) return invalid("Question paths are invalid.");
  };
  const validateWarning = (warning: RoomWarning) => {
    requireText(warning.code, "Warning code", 80);
    requireText(warning.ruleId, "Warning rule id", 80);
    if (!["warning", "blocking"].includes(warning.severity)) return invalid("Warning severity is invalid.");
    requireText(warning.message, "Warning message", 1000);
    if (!Array.isArray(warning.paths) || warning.paths.length > 10) return invalid("Warning paths are invalid.");
  };
  for (const room of value.rooms) {
    if (!Number.isInteger(room.roomIndex) || room.roomIndex < 0 || room.roomIndex > 199) return invalid("Room index is invalid.");
    requireText(room.roomKey, "Room key", 120);
    if (typeof room.roomLabel !== "string" || room.roomLabel.length > 200) return invalid("Room label is invalid.");
    if (!Array.isArray(room.recommendations) || room.recommendations.length > 50) return invalid("Room recommendations are invalid.");
    for (const item of room.recommendations) {
      requireText(item.recommendationKey, "Recommendation key", 200);
      if (!KEY_PATTERN.test(item.recommendationKey)) return invalid("Recommendation key format is invalid.");
      if (seenKeys.has(item.recommendationKey)) return invalid("Recommendation keys must be unique.");
      seenKeys.add(item.recommendationKey);
      if (!PATH_PATTERN.test(item.path)) return invalid("Recommendation path is invalid.");
      if (!item.path.startsWith(`/content/roomByRoom/${room.roomIndex}/`)) return invalid("Recommendation path does not match its room.");
      requireText(item.mongoPath, "Recommendation mongo path", 200);
      requireText(item.value, "Recommendation value", 500);
      if (!CLASSIFICATIONS.includes(item.classification) || item.classification === "unknown" || item.classification === "confirmed_fact")
        return invalid("Recommendation classification must be a derivation or assumption.");
      if (typeof item.confidence !== "number" || item.confidence < 0 || item.confidence > 1) return invalid("Recommendation confidence is invalid.");
      requireText(item.explanation, "Recommendation explanation", 1000);
      if (!Array.isArray(item.evidence) || item.evidence.length > 10) return invalid("Recommendation evidence is invalid.");
      for (const fact of item.evidence) { requireText(fact.path, "Evidence path", 200); requireText(fact.value, "Evidence value", 500); }
      if (!Array.isArray(item.ruleIds) || item.ruleIds.length < 1 || item.ruleIds.length > 5) return invalid("Recommendation rule ids are invalid.");
      if (!Array.isArray(item.knowledgeIds) || item.knowledgeIds.length > 5) return invalid("Recommendation knowledge ids are invalid.");
      if (!Array.isArray(item.assumptions) || item.assumptions.length > 10) return invalid("Recommendation assumptions are invalid.");
      if (item.classification === "recommended_assumption" && (item.requiresHumanReview !== true || item.assumptions.length === 0))
        return invalid("Assumptions must be reviewed by a human and must state what is assumed.");
      if (typeof item.requiresHumanReview !== "boolean" || typeof item.applyEligible !== "boolean") return invalid("Recommendation flags are invalid.");
    }
    if (!Array.isArray(room.clarificationQuestions) || room.clarificationQuestions.length > 20) return invalid("Room questions are invalid.");
    room.clarificationQuestions.forEach(validateQuestion);
    if (!Array.isArray(room.warnings) || room.warnings.length > 20) return invalid("Room warnings are invalid.");
    room.warnings.forEach(validateWarning);
  }
  if (!Array.isArray(value.globalClarificationQuestions) || value.globalClarificationQuestions.length > 20) return invalid("Global questions are invalid.");
  value.globalClarificationQuestions.forEach(validateQuestion);
  if (!Array.isArray(value.globalWarnings) || value.globalWarnings.length > 20) return invalid("Global warnings are invalid.");
  value.globalWarnings.forEach(validateWarning);
  if (!Array.isArray(value.knowledgeIds) || value.knowledgeIds.length > 20) return invalid("Knowledge ids are invalid.");
  return value;
};

export const parseReview = (value: Record<string, unknown>) => {
  const revision = Number(value.revision);
  if (!Number.isInteger(revision) || revision < 0) throw new RoomRecommendationError("INVALID_REVIEW_REVISION", "A valid review revision is required.");
  if (!Array.isArray(value.decisions) || value.decisions.length < 1 || value.decisions.length > 200)
    throw new RoomRecommendationError("INVALID_REVIEW_DECISION", "Review decisions are invalid.");
  return {
    revision,
    decisions: value.decisions.map((item) => {
      const x = item as Record<string, unknown>;
      const recommendationKey = String(x.recommendationKey || "");
      const decision = String(x.decision || "") as ReviewDecision;
      if (!KEY_PATTERN.test(recommendationKey) || !["pending", "accepted", "edited", "rejected"].includes(decision))
        throw new RoomRecommendationError("INVALID_REVIEW_DECISION", "Review decision is invalid.");
      if (decision === "edited" && typeof x.value !== "string")
        throw new RoomRecommendationError("INVALID_REVIEW_DECISION", "Edited decisions require a value.");
      const reasonCode = x.reasonCode === undefined || x.reasonCode === null ? null : String(x.reasonCode);
      if (reasonCode !== null && !REASON_CODES.includes(reasonCode as ReasonCode))
        throw new RoomRecommendationError("INVALID_REVIEW_DECISION", "Review reason code is invalid.");
      if (decision === "rejected" && reasonCode === null)
        throw new RoomRecommendationError("INVALID_REVIEW_DECISION", "Rejected decisions require a reason code.");
      const note = x.note === undefined || x.note === null ? null : String(x.note).trim();
      if (note && note.length > 500) throw new RoomRecommendationError("INVALID_REVIEW_DECISION", "Review note is too long.");
      return { recommendationKey, decision, value: decision === "edited" ? String(x.value) : null, reasonCode: reasonCode as ReasonCode | null, note };
    }),
  };
};

/**
 * Two application modes. `automatic: true` (the default product flow since
 * 2026-07-27) applies every allowlisted recommendation whose target is still
 * empty — no review required, values stay user-editable in the form. The
 * manual selection shape remains supported for explicit per-field application.
 */
export const parseApplication = (value: Record<string, unknown>) => {
  if (value.automatic === true) return { automatic: true as const };
  const expectedProposalVersion = Number(value.expectedProposalVersion);
  if (!Number.isInteger(expectedProposalVersion) || expectedProposalVersion < 1)
    throw new RoomRecommendationError("INVALID_PROPOSAL_VERSION", "Expected proposal version is required.");
  const recommendationKeys = Array.isArray(value.recommendationKeys) ? [...new Set(value.recommendationKeys.map(String))] : [];
  if (!recommendationKeys.length || recommendationKeys.length > 50 || recommendationKeys.some((key) => !KEY_PATTERN.test(key)))
    throw new RoomRecommendationError("INVALID_APPLICATION_SELECTION", "Select between 1 and 50 valid recommendations.");
  return { automatic: false as const, expectedProposalVersion, recommendationKeys };
};
