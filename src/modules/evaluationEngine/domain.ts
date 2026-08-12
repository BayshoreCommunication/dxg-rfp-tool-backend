import crypto from "node:crypto";

export const ASSESSMENT_VERSION = "vendor-assessment.v1";
export const RISK_POLICY_VERSION = "evaluation-risk.v1";
export const COMMERCIAL_POLICY_VERSION = "commercial-normalization.v1";
export const SCORING_POLICY_VERSION = "confirmed-rubric-score.v1";

export class EvaluationEngineError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}

export type MappingInput = {
  mappingId: string; requirementId: string; title: string; mandatory: boolean; eligibility: boolean;
  relationship: "supports" | "partially_supports" | "contradicts" | "context_only" | "none";
  confidence: number; fragmentIds: string[];
};
export type FactInput = {
  factId: string; factKey: string; family: string; factType: string; statement: string;
  valueKind: string; normalizedValue: string; typedValue: Record<string, unknown>; currency: string | null;
  contradictionGroup: string | null; fragmentIds: string[];
};

const verdictByRelationship = {
  supports: "addressed", partially_supports: "partially_addressed", contradicts: "contradictory",
  context_only: "not_assessable", none: "missing",
} as const;

export const buildAssessments = (mappings: MappingInput[]) => mappings.map((mapping, ordinal) => {
  const verdict = verdictByRelationship[mapping.relationship];
  if (mapping.relationship !== "none" && mapping.fragmentIds.length === 0)
    throw new EvaluationEngineError("ASSESSMENT_CITATION_INVALID", "An assessable requirement must retain cited evidence.");
  const reviewReasons = [
    ...(mapping.confidence < 0.75 ? ["low_extraction_confidence"] : []),
    ...(mapping.relationship === "contradicts" ? ["contradictory_evidence"] : []),
    ...(mapping.mandatory && ["none", "partially_supports", "contradicts"].includes(mapping.relationship) ? ["mandatory_disposition_required"] : []),
    ...(mapping.eligibility && mapping.relationship !== "supports" ? ["eligibility_disposition_required"] : []),
  ];
  const rationale = mapping.relationship === "supports"
    ? "The vendor response contains cited evidence addressing this requirement."
    : mapping.relationship === "partially_supports"
      ? "The cited response addresses part of this requirement; a reviewer must determine whether the remaining detail is material."
      : mapping.relationship === "contradicts"
        ? "The cited response contains evidence that conflicts with this requirement or with another vendor statement."
        : mapping.relationship === "context_only"
          ? "The cited response provides context but does not establish that the requirement is addressed."
          : "No evidence in the evaluated response version was mapped to this requirement.";
  return { ...mapping, ordinal, verdict, rationale, reviewReasons, needsHumanReview: reviewReasons.length > 0 || verdict !== "addressed" };
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

export const calculateContribution = (input: { score: unknown; rubricMaximum: number; weight: number }) => {
  const score = Number(input.score);
  if (!Number.isFinite(score) || score < 0 || score > input.rubricMaximum)
    throw new EvaluationEngineError("SCORE_OUT_OF_RANGE", `Score must be between 0 and ${input.rubricMaximum}.`);
  if (!Number.isFinite(input.weight) || input.weight < 0 || input.weight > 100)
    throw new EvaluationEngineError("SCORING_MATRIX_INVALID", "The frozen criterion weight is invalid.", 409);
  return Math.round(((score / input.rubricMaximum) * input.weight) * 10_000) / 10_000;
};

export const checksum = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
