import crypto from "node:crypto";

export const COMPARISON_SCHEMA_VERSION = "proposal-intelligence-comparison.v5";
export const PARTICIPANT_SCHEMA_VERSION = "comparison-participant.v5";
export const RECOMMENDATION_POLICY_VERSION = "human-rubric-recommendation.v2";
export const CLOSE_CALL_MARGIN = 2;
export const HIGH_CONFIDENCE_MARGIN = 5;
export const HIGH_DISAGREEMENT_SPREAD = 1.5;

export class ComparisonOrchestrationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422, public readonly retryable = false) { super(message); }
}

export const comparisonChecksum = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const uniqueReasons = (values: string[]) => [...new Set(values)].sort();

export const weightedProgress = (nodes: Array<{ status: string; weight: unknown }>) => {
  const value = nodes.reduce((total, node) => {
    const weight = Number(node.weight);
    if (node.status === "succeeded") return total + weight;
    if (node.status === "running") return total + (weight * 0.25);
    return total;
  }, 0);
  return Math.round(Math.min(100, Math.max(0, value)) * 1000) / 1000;
};

export const freezeScoreInput = (rows: Array<{
  assignmentId: string;
  role: string;
  conflictStatus: string;
  criterionId: string | null;
  eventId: string | null;
  eventType: string | null;
  score: number | null;
  weightedContribution: number | null;
}>) => {
  const eligible = rows.filter((row) => row.role !== "observer").map((row) => ({
    assignmentId: row.assignmentId,
    role: row.role,
    conflictStatus: row.conflictStatus,
    criterionId: row.criterionId,
    eventId: row.eventId,
    eventType: row.eventType,
    score: row.score,
    weightedContribution: row.weightedContribution,
  })).sort((left, right) =>
    `${left.assignmentId}:${left.criterionId ?? ""}`.localeCompare(`${right.assignmentId}:${right.criterionId ?? ""}`),
  );
  const reasons = uniqueReasons([
    ...(eligible.length === 0 ? ["evaluator_missing"] : []),
    ...(eligible.some((row) => !["clear", "not_applicable"].includes(row.conflictStatus)) ? ["conflict_unresolved"] : []),
    ...(eligible.some((row) => !row.criterionId) ? ["criteria_missing"] : []),
    ...(eligible.some((row) => !["submitted", "superseded"].includes(String(row.eventType))) ? ["score_missing"] : []),
  ]);
  return { complete: reasons.length === 0, reasons, checksum: comparisonChecksum(eligible), rows: eligible };
};

export const evaluatorPanelSignature = (rows: Array<{
  evaluatorExternalUserId: string;
  role: string;
  conflictStatus: string;
  criterionIds: string[];
}>) => comparisonChecksum(rows
  .filter((row) => row.role !== "observer")
  .map((row) => ({
    evaluatorExternalUserId: row.evaluatorExternalUserId,
    role: row.role,
    conflictStatus: row.conflictStatus,
    criterionIds: [...new Set(row.criterionIds)].sort(),
  }))
  .sort((left, right) => left.evaluatorExternalUserId.localeCompare(right.evaluatorExternalUserId)));

export const buildVendorRecommendation = (input: {
  participants: Array<{ participantId: string; vendorLabel: string; score: number; evaluatorCount?: number; maxCriterionSpread?: number }>;
  requirements: Array<{ participantId: string; eligibility: boolean; mandatoryStatus: string; verdict: string; needsHumanReview: boolean }>;
  risks: Array<{ participantId: string; severity: string }>;
}) => {
  const ranking = input.participants.map((participant) => {
    const requirements = input.requirements.filter((item) => item.participantId === participant.participantId);
    const eligibilityFailures = requirements.filter((item) => item.eligibility && item.verdict !== "addressed").length;
    const mandatoryGaps = requirements.filter((item) => item.mandatoryStatus === "mandatory" && item.verdict !== "addressed").length;
    const unresolvedReviews = requirements.filter((item) => item.needsHumanReview).length;
    const highRisks = input.risks.filter((item) => item.participantId === participant.participantId && item.severity === "high").length;
    return {
      participantId: participant.participantId,
      vendorLabel: participant.vendorLabel,
      score: Math.round(Number(participant.score) * 1000) / 1000,
      evaluatorCount: Number(participant.evaluatorCount ?? 0),
      maxCriterionSpread: Math.round(Number(participant.maxCriterionSpread ?? 0) * 1000) / 1000,
      eligible: eligibilityFailures === 0,
      eligibilityFailures,
      mandatoryGaps,
      unresolvedReviews,
      highRisks,
      rank: null as number | null,
    };
  }).sort((left, right) => Number(right.eligible) - Number(left.eligible) || right.score - left.score || left.vendorLabel.localeCompare(right.vendorLabel) || left.participantId.localeCompare(right.participantId));
  ranking.filter((item) => item.eligible).forEach((item, index) => { item.rank = index + 1; });
  const eligible = ranking.filter((item) => item.eligible);
  if (!eligible.length) return {
    policyVersion: RECOMMENDATION_POLICY_VERSION,
    status: "no_eligible_vendor" as const,
    bestParticipantId: null,
    strongestParticipantIds: [] as string[],
    confidence: "low" as const,
    confidenceReasons: ["no_eligible_vendor"],
    margin: null,
    rationale: "No vendor passes every planner-designated eligibility requirement.",
    ranking,
  };
  const margin = eligible.length > 1 ? Math.round((eligible[0].score - eligible[1].score) * 1000) / 1000 : null;
  const strongest = eligible.filter((item) => eligible[0].score - item.score < CLOSE_CALL_MARGIN).map((item) => item.participantId);
  const close = eligible.length > 1 && Number(margin) < CLOSE_CALL_MARGIN;
  const leader = eligible[0];
  const confidenceReasons = uniqueReasons([
    ...(close ? ["close_score_margin"] : []),
    ...(leader.unresolvedReviews > 0 ? ["unresolved_evidence_reviews"] : []),
    ...(leader.evaluatorCount < 2 ? ["insufficient_independent_evaluators"] : []),
    ...(leader.maxCriterionSpread > HIGH_DISAGREEMENT_SPREAD ? ["high_evaluator_disagreement"] : []),
    ...(leader.mandatoryGaps > 0 ? ["mandatory_gaps"] : []),
    ...(leader.highRisks > 0 ? ["high_risks"] : []),
  ]);
  const confidence = confidenceReasons.length
    ? "low"
    : leader.evaluatorCount >= 3 && leader.maxCriterionSpread <= 0.5 && margin !== null && margin >= HIGH_CONFIDENCE_MARGIN ? "high" : "medium";
  return {
    policyVersion: RECOMMENDATION_POLICY_VERSION,
    status: close ? "close_call" as const : "recommended" as const,
    bestParticipantId: close ? null : leader.participantId,
    strongestParticipantIds: close ? strongest : [leader.participantId],
    confidence,
    confidenceReasons,
    margin,
    rationale: close
      ? `The leading eligible vendors are within ${CLOSE_CALL_MARGIN} weighted points; no sole strongest response is declared.`
      : `${leader.vendorLabel} has the highest completed rubric score among vendors that pass all planner-designated eligibility requirements.`,
    ranking,
  };
};
