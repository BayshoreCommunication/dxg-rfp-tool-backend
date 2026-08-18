import crypto from "node:crypto";
import { assignContradictionGroups, validateFactCorrectionPayload } from "../vendorIntelligence/domain";

export const ASSESSMENT_VERSION = "vendor-assessment.v3";
export const RISK_POLICY_VERSION = "evaluation-risk.v1";
export const COMMERCIAL_POLICY_VERSION = "commercial-normalization.v1";
export const SCORING_POLICY_VERSION = "confirmed-rubric-score.v2";

export class EvaluationEngineError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}

const blockingCoverageWarnings = new Set(["SOURCE_COVERAGE_INCOMPLETE", "SOURCE_UNAVAILABLE", "EVIDENCE_COVERAGE_BOUNDED"]);
export const coverageEligibility = (warnings: Array<{ code?: unknown }>) => {
  const blockingCodes = [...new Set(warnings.map((warning) => String(warning.code ?? "")).filter((code) => blockingCoverageWarnings.has(code)))].sort();
  return { eligible: blockingCodes.length === 0, blockingCodes };
};

export type MappingInput = {
  mappingId: string; requirementId: string; title: string; mandatory: boolean; eligibility: boolean;
  relationship: "supports" | "partially_supports" | "contradicts" | "context_only" | "none";
  confidence: number; fragmentIds: string[]; mappingTargetIds?: string[];
  humanReviewDecision?: "accepted" | "rejected" | "corrected" | "escalated" | null;
};
export type FactInput = {
  factId: string; factKey: string; family: string; factType: string; statement: string;
  valueKind: string; normalizedValue: string; typedValue: Record<string, unknown>; currency: string | null;
  contradictionGroup: string | null; fragmentIds: string[];
  humanReviewDecision?: "accepted" | "corrected" | null;
};

export type HumanEvidenceReview = {
  reviewId: string;
  targetType: "fact" | "mapping";
  targetId: string;
  decision: "accepted" | "rejected" | "corrected" | "escalated";
  correctedPayload: Record<string, unknown> | null;
};

const correctedFact = (fact: FactInput, review: HumanEvidenceReview): FactInput => {
  let correction: ReturnType<typeof validateFactCorrectionPayload>;
  try {
    correction = validateFactCorrectionPayload(fact.valueKind, review.correctedPayload);
  } catch {
    throw new EvaluationEngineError("REVIEW_CORRECTION_INVALID", "The reviewed fact correction is not compatible with the extracted fact type.", 409);
  }
  return {
    ...fact,
    normalizedValue: correction.normalizedValue,
    typedValue: correction.typedValue,
    currency: correction.currency ?? fact.currency,
    humanReviewDecision: "corrected",
  };
};

export const applyHumanReviews = (input: {
  mappings: MappingInput[];
  facts: FactInput[];
  reviews: HumanEvidenceReview[];
}) => {
  const latest = new Map<string, HumanEvidenceReview>();
  input.reviews.forEach((review) => latest.set(`${review.targetType}:${review.targetId}`, review));
  const mappings = input.mappings.map((mapping): MappingInput => {
    const targetIds = mapping.mappingTargetIds?.length ? mapping.mappingTargetIds : [mapping.mappingId];
    const review = [...input.reviews].reverse().find((item) =>
      item.targetType === "mapping" && targetIds.includes(item.targetId),
    );
    if (!review) return mapping;
    if (review.decision === "rejected") return {
      ...mapping,
      relationship: "none",
      fragmentIds: [],
      confidence: 1,
      humanReviewDecision: "rejected",
    };
    if (review.decision === "corrected") {
      const relationship = review.correctedPayload?.relationship;
      const fragmentIds = review.correctedPayload?.fragmentIds;
      if (
        !["supports", "partially_supports", "contradicts", "context_only", "none"].includes(String(relationship))
        || !Array.isArray(fragmentIds)
        || fragmentIds.some((id) => typeof id !== "string")
        || (relationship === "none" ? fragmentIds.length !== 0 : fragmentIds.length === 0)
      ) throw new EvaluationEngineError("REVIEW_CORRECTION_INVALID", "The reviewed mapping correction is invalid.", 409);
      return {
        ...mapping,
        relationship: relationship as MappingInput["relationship"],
        fragmentIds: [...new Set(fragmentIds as string[])],
        confidence: 1,
        humanReviewDecision: "corrected",
      };
    }
    return { ...mapping, humanReviewDecision: review.decision };
  });
  const facts = input.facts.flatMap((fact): FactInput[] => {
    const review = latest.get(`fact:${fact.factId}`);
    if (review?.decision === "rejected" || review?.decision === "escalated") return [];
    if (review?.decision === "corrected") return [correctedFact(fact, review)];
    return [{ ...fact, humanReviewDecision: review?.decision === "accepted" ? "accepted" : null }];
  });
  return { mappings, facts: assignContradictionGroups(facts) };
};

const verdictByRelationship = {
  supports: "addressed", partially_supports: "partially_addressed", contradicts: "contradictory",
  context_only: "not_assessable", none: "missing",
} as const;

export const buildAssessments = (mappings: MappingInput[]) => mappings.map((mapping, ordinal) => {
  const verdict = verdictByRelationship[mapping.relationship];
  if (mapping.relationship !== "none" && mapping.fragmentIds.length === 0)
    throw new EvaluationEngineError("ASSESSMENT_CITATION_INVALID", "An assessable requirement must retain cited evidence.");
  const terminalHumanReview = ["accepted", "corrected", "rejected"].includes(String(mapping.humanReviewDecision));
  const reviewReasons = terminalHumanReview ? [] : [
    ...(mapping.confidence < 0.75 ? ["low_extraction_confidence"] : []),
    ...(mapping.relationship === "contradicts" ? ["contradictory_evidence"] : []),
    ...(mapping.mandatory && ["none", "partially_supports", "contradicts"].includes(mapping.relationship) ? ["mandatory_disposition_required"] : []),
    ...(mapping.eligibility && mapping.relationship !== "supports" ? ["eligibility_disposition_required"] : []),
    ...(mapping.humanReviewDecision === "escalated" ? ["human_evidence_escalated"] : []),
  ];
  const relationshipRationale = mapping.relationship === "supports"
    ? "The vendor response contains cited evidence addressing this requirement."
    : mapping.relationship === "partially_supports"
      ? "The cited response addresses part of this requirement; a reviewer must determine whether the remaining detail is material."
      : mapping.relationship === "contradicts"
        ? "The cited response contains evidence that conflicts with this requirement or with another vendor statement."
        : mapping.relationship === "context_only"
          ? "The cited response provides context but does not establish that the requirement is addressed."
          : "No evidence in the evaluated response version was mapped to this requirement.";
  const rationale = mapping.humanReviewDecision === "rejected"
    ? "A human reviewer rejected the extracted evidence mapping, so this requirement is treated as missing."
    : mapping.humanReviewDecision === "corrected"
      ? `A human reviewer corrected the evidence mapping. ${relationshipRationale}`
      : relationshipRationale;
  return { ...mapping, ordinal, verdict, rationale, reviewReasons, needsHumanReview: !terminalHumanReview && (reviewReasons.length > 0 || verdict !== "addressed") };
});

export type DerivedRisk = {
  category: "mandatory_gap" | "contradiction" | "commercial_exception" | "commercial_non_comparable" | "missing_detail" | "reference_unverified";
  severity: "high" | "medium" | "low"; title: string; basis: string;
  requirementId: string | null; factId: string | null; fragmentIds: string[]; question: string;
};

export const buildRisks = (mappings: MappingInput[], facts: FactInput[]): DerivedRisk[] => {
  const risks: DerivedRisk[] = [];
  for (const mapping of mappings) {
    if (mapping.mandatory && mapping.relationship !== "supports") risks.push({
      category: "mandatory_gap", severity: "high", title: `Mandatory item needs disposition: ${mapping.title}`,
      basis: "The response did not fully address a mandatory requirement. This is a review flag, not an automatic disqualification.",
      requirementId: mapping.requirementId, factId: null, fragmentIds: mapping.fragmentIds,
      question: `Please clarify how your proposal fully addresses the mandatory requirement: ${mapping.title}.`,
    });
    else if (["none", "context_only", "partially_supports"].includes(mapping.relationship)) risks.push({
      category: "missing_detail", severity: mapping.relationship === "none" ? "medium" : "low",
      title: `Response detail needed: ${mapping.title}`,
      basis: mapping.relationship === "none" ? "No cited response evidence addresses this requirement." : "The cited response does not fully establish compliance with this requirement.",
      requirementId: mapping.requirementId, factId: null, fragmentIds: mapping.fragmentIds,
      question: `Please provide specific response details for: ${mapping.title}.`,
    });
  }
  for (const fact of facts) {
    if (fact.contradictionGroup) risks.push({
      category: "contradiction", severity: "high", title: "Conflicting vendor statements require clarification",
      basis: `Conflicting values were preserved for ${fact.factKey}; the system did not select one as authoritative.`,
      requirementId: null, factId: fact.factId, fragmentIds: fact.fragmentIds,
      question: `Please confirm the authoritative value for ${fact.factKey} and identify which cited statement it replaces.`,
    });
    if (["commercial_exclusion", "commercial_option", "assumption", "exception", "dependency"].includes(fact.factType)) risks.push({
      category: "commercial_exception", severity: "medium", title: "Commercial assumption or exclusion requires review",
      basis: fact.statement, requirementId: null, factId: fact.factId, fragmentIds: fact.fragmentIds,
      question: `Please confirm whether this item is included in the submitted total: ${fact.statement}`,
    });
    if (fact.factType === "client_reference") risks.push({
      category: "reference_unverified", severity: "low", title: "Vendor reference has not been independently verified",
      basis: fact.statement, requirementId: null, factId: fact.factId, fragmentIds: fact.fragmentIds,
      question: `Please confirm the current contact and permission to verify this reference: ${fact.statement}`,
    });
  }
  return risks.slice(0, 200);
};

export const normalizeCommercial = (facts: FactInput[]) => {
  const commercial = facts.filter((fact) => fact.family === "commercial");
  const totals = commercial.filter((fact) => fact.factType === "commercial_total" && fact.valueKind === "money");
  const currencies = new Set(commercial.map((fact) => fact.currency).filter((value): value is string => Boolean(value)));
  const exclusions = commercial.filter((fact) => ["commercial_exclusion", "commercial_option"].includes(fact.factType));
  const refusals: string[] = [];
  if (totals.length === 0) refusals.push("SUBMITTED_TOTAL_MISSING");
  if (totals.length > 1 || totals.some((fact) => fact.contradictionGroup)) refusals.push("SUBMITTED_TOTAL_CONTRADICTORY");
  if (currencies.size > 1) refusals.push("MIXED_CURRENCY");
  if (exclusions.length > 0) refusals.push("UNRESOLVED_OPTIONS_OR_EXCLUSIONS");
  const total = totals.length === 1 ? Number(totals[0].typedValue.number) : null;
  if (total !== null && (!Number.isFinite(total) || total < 0)) refusals.push("SUBMITTED_TOTAL_INVALID");
  const comparable = refusals.length === 0 && total !== null;
  return {
    commercialFacts: commercial,
    submittedTotal: totals.length === 1 && Number.isFinite(total) ? total : null,
    submittedCurrency: totals.length === 1 ? totals[0].currency : null,
    totalFactId: totals.length === 1 ? totals[0].factId : null,
    comparable,
    normalizedTotal: comparable ? total : null,
    currency: comparable ? totals[0].currency : null,
    refusalCodes: [...new Set(refusals)],
    assumptions: comparable ? ["No adjustment was applied; normalized total equals the single explicit submitted total."] : [],
  };
};

export const rubricMaximum = (rubric: unknown): number => {
  if (rubric && typeof rubric === "object") {
    const maximum = Number((rubric as Record<string, unknown>).maximum);
    if (Number.isFinite(maximum) && maximum > 0 && maximum <= 100) return maximum;
  }
  return 5;
};

export const rubricAnchors = (rubric: unknown): Array<{ score: number; label: string; description: string }> => {
  if (!rubric || typeof rubric !== "object" || !Array.isArray((rubric as Record<string, unknown>).anchors)) return [];
  return ((rubric as Record<string, unknown>).anchors as unknown[]).flatMap((anchor) => {
    if (!anchor || typeof anchor !== "object") return [];
    const value = anchor as Record<string, unknown>;
    const score = Number(value.score);
    const label = typeof value.label === "string" ? value.label.trim() : "";
    const description = typeof value.description === "string" ? value.description.trim() : "";
    return Number.isFinite(score) && label && description ? [{ score, label, description }] : [];
  }).sort((left, right) => left.score - right.score);
};

export const calculateContribution = (input: { score: unknown; rubricMaximum: number; weight: number }) => {
  const score = Number(input.score);
  if (!Number.isFinite(score) || score < 0 || score > input.rubricMaximum)
    throw new EvaluationEngineError("SCORE_OUT_OF_RANGE", `Score must be between 0 and ${input.rubricMaximum}.`);
  if (!Number.isFinite(input.weight) || input.weight < 0 || input.weight > 100)
    throw new EvaluationEngineError("SCORING_MATRIX_INVALID", "The frozen criterion weight is invalid.", 409);
  return Math.round(((score / input.rubricMaximum) * input.weight) * 10_000) / 10_000;
};

export const aggregateCriterionScores = (input: {
  criterionIds: string[];
  assignments: Array<{
    assignmentId: string;
    role: string;
    conflictStatus: string;
    criterionIds: string[];
  }>;
  scores: Array<{
    assignmentId: string;
    criterionId: string;
    eventType: string;
    score: number;
    weightedContribution: number;
  }>;
}) => {
  const eligible = input.assignments.filter((assignment) =>
    assignment.role !== "observer" && assignment.conflictStatus === "clear",
  );
  const eligibleIds = new Set(eligible.map((assignment) => assignment.assignmentId));
  return input.criterionIds.map((criterionId) => {
    const submitted = input.scores.filter((score) =>
      score.criterionId === criterionId
      && eligibleIds.has(score.assignmentId)
      && ["submitted", "superseded"].includes(score.eventType),
    );
    const values = submitted.map((score) => Number(score.score));
    const contributions = submitted.map((score) => Number(score.weightedContribution));
    return {
      criterionId,
      submittedCount: values.length,
      assignedCount: eligible.filter((assignment) => assignment.criterionIds.includes(criterionId)).length,
      mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      minimum: values.length ? Math.min(...values) : null,
      maximum: values.length ? Math.max(...values) : null,
      spread: values.length ? Math.max(...values) - Math.min(...values) : null,
      meanWeightedContribution: contributions.length
        ? contributions.reduce((sum, value) => sum + value, 0) / contributions.length
        : null,
    };
  });
};

export const checksum = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
