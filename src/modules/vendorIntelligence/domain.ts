import crypto from "node:crypto";

export const MAPPING_VERSION = "requirement-mapping.v1";
export const FACT_VERSION = "vendor-fact.v3";
export const VALIDATION_VERSION = "mapping-fact-validation.v7";
export const PROMPT_VERSION = "vendor-intelligence-prompt.v4";
export const MAX_FACTS_PER_CHUNK = 24;

export const factFamilies = [
  "company_profile", "experience", "references", "staffing", "equipment",
  "schedule_logistics", "hybrid_streaming_recording", "accessibility",
  "sustainability_dei", "insurance_policy", "commercial",
  "assumption_exception_dependency", "alternative",
] as const;
export type FactFamily = (typeof factFamilies)[number];

export const factTypes = [
  "company_name", "years_in_business", "organization_size", "relevant_project", "client_reference",
  "staff_role", "named_staff", "staff_count", "coverage_ratio", "shift", "overtime_term",
  "equipment_system", "equipment_item", "equipment_quantity", "technical_approach",
  "setup_schedule", "rehearsal_schedule", "strike_schedule", "logistics_plan",
  "streaming_capability", "recording_capability", "hybrid_capability",
  "accessibility_commitment", "sustainability_commitment", "dei_commitment",
  "insurance_coverage", "policy_statement", "commercial_total", "commercial_component",
  "commercial_option", "commercial_exclusion", "payment_term", "cancellation_term", "proposal_validity",
  "assumption", "exception", "dependency", "alternative",
] as const;
export type FactType = (typeof factTypes)[number];
export type ValueKind = "string" | "number" | "boolean" | "money" | "date" | "date_range" | "duration" | "quantity" | "list" | "unknown";
export type CitationRole = "supports" | "contradicts" | "context";

export type ProviderValue = {
  text: string | null;
  number: number | null;
  boolean: boolean | null;
  list: string[];
  currency: string | null;
  unit: string | null;
  periodStart: string | null;
  periodEnd: string | null;
};
export type ProviderFact = {
  factKey: string;
  family: FactFamily;
  factType: FactType;
  statement: string;
  valueKind: ValueKind;
  value: ProviderValue;
  explicitness: "explicit" | "derived";
  confidence: number;
  citations: Array<{ fragmentId: string; role: CitationRole }>;
};
export type ProviderFactOutput = { facts: ProviderFact[] };
export type ProviderMapping = {
  requirementId: string;
  relationship: "supports" | "partially_supports" | "contradicts" | "context_only" | "none";
  confidence: number;
  candidateFragmentIds: string[];
  ambiguityReasons: string[];
};
export type ProviderMappingOutput = { mappings: ProviderMapping[] };
export type ValidatedFact = ProviderFact & {
  typedValue: Record<string, unknown>;
  normalizedValue: string;
  unit: string | null;
  currency: string | null;
  periodStart: string | null;
  periodEnd: string | null;
};

export class VendorIntelligenceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422,
    public readonly retryable = false,
  ) { super(message); }
}

export type SourceCoverageInput = {
  status: string;
  sourceLabel: string;
  warnings: Array<{ code?: unknown; message?: unknown; locator?: unknown }>;
};

export type IntelligenceCoverageWarning = {
  code: string;
  message: string;
  sourceLabel?: string;
  locator?: Record<string, unknown>;
  availableFragments?: number;
  usedFragments?: number;
};

export const sourceCoverageWarnings = (
  sources: SourceCoverageInput[],
  availableFragments: number,
  usedFragments: number,
): IntelligenceCoverageWarning[] => {
  const warnings: IntelligenceCoverageWarning[] = [];
  for (const source of sources) {
    if (source.status === "partial") {
      for (const warning of source.warnings) {
        const code = String(warning.code ?? "SOURCE_COVERAGE_INCOMPLETE");
        warnings.push({
          code,
          message: String(warning.message ?? "Some source content could not be extracted."),
          sourceLabel: source.sourceLabel,
          ...(warning.locator && typeof warning.locator === "object" ? { locator: warning.locator as Record<string, unknown> } : {}),
        });
      }
      warnings.push({ code: "SOURCE_COVERAGE_INCOMPLETE", message: "This source was only partially readable.", sourceLabel: source.sourceLabel });
    } else if (!["succeeded"].includes(source.status)) {
      warnings.push({ code: "SOURCE_UNAVAILABLE", message: "This source was not available to proposal intelligence.", sourceLabel: source.sourceLabel });
    }
  }
  if (availableFragments > usedFragments) warnings.push({
    code: "EVIDENCE_COVERAGE_BOUNDED",
    message: "The run used a bounded source-fair evidence sample rather than all extracted fragments.",
    availableFragments,
    usedFragments,
  });
  return warnings.filter((warning, index, all) => all.findIndex((candidate) =>
    candidate.code === warning.code && candidate.sourceLabel === warning.sourceLabel,
  ) === index);
};

const FACT_KEY = /^[a-z][a-z0-9_.:-]{0,149}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const forbiddenDecision = /\b(?:winner|award(?:ed)?|shortlist(?:ed)?|select(?:ed)?\s+(?:this|the)\s+vendor|disqualif(?:y|ied))\b/i;
const boundedText = (value: unknown, max: number): string => typeof value === "string" ? value.trim().slice(0, max) : "";
const finiteConfidence = (value: unknown): number => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1)
    throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "Provider confidence is invalid.");
  return number;
};
const validDate = (value: string | null): string | null => {
  if (value === null) return null;
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)))
    throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "Provider date is invalid.");
  return value;
};

const validateValue = (kind: ValueKind, value: ProviderValue) => {
  if (!value || typeof value !== "object")
    throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "Provider typed value is invalid.");
  const text = value.text === null ? null : boundedText(value.text, 2000);
  const numeric = value.number === null ? null : Number(value.number);
  if (numeric !== null && !Number.isFinite(numeric))
    throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "Provider numeric value is invalid.");
  const currency = value.currency === null ? null : String(value.currency).toUpperCase();
  if (currency !== null && !/^[A-Z]{3}$/.test(currency))
    throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "Provider currency is invalid.");
  const periodStart = validDate(value.periodStart), periodEnd = validDate(value.periodEnd);
  if (periodStart && periodEnd && periodEnd < periodStart)
    throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "Provider period is invalid.");
  const list = Array.isArray(value.list) ? value.list.map((item) => boundedText(item, 300)).filter(Boolean).slice(0, 30) : [];
  const unit = value.unit === null ? null : boundedText(value.unit, 80);
  if (["number", "money", "quantity"].includes(kind) && numeric === null)
    throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "Typed numeric fact has no number.");
  if (kind === "money" && currency === null)
    throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "Money fact has no currency.");
  if (kind === "boolean" && typeof value.boolean !== "boolean")
    throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "Boolean fact has no boolean value.");
  if (["string", "date", "date_range", "duration"].includes(kind) && !text)
    throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "Text fact has no value.");
  if (kind === "list" && !list.length)
    throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "List fact has no values.");
  const typedValue: Record<string, unknown> = { kind };
  let normalizedValue = "";
  if (text) { typedValue.text = text; normalizedValue = text; }
  if (numeric !== null) { typedValue.number = numeric; normalizedValue = String(numeric); }
  if (typeof value.boolean === "boolean") { typedValue.boolean = value.boolean; normalizedValue = String(value.boolean); }
  if (list.length) { typedValue.list = list; normalizedValue = list.join(" | "); }
  if (currency) { typedValue.currency = currency; normalizedValue = `${currency} ${normalizedValue}`.trim(); }
  if (unit) typedValue.unit = unit;
  if (periodStart) typedValue.periodStart = periodStart;
  if (periodEnd) typedValue.periodEnd = periodEnd;
  return { typedValue, normalizedValue: normalizedValue.slice(0, 2000), unit, currency, periodStart, periodEnd };
};

export const validateFacts = (output: ProviderFactOutput, allowedFragments: Set<string>): ValidatedFact[] => {
  if (!output || !Array.isArray(output.facts) || output.facts.length > MAX_FACTS_PER_CHUNK)
    throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "Provider fact output is invalid.");
  const seen = new Set<string>();
  const validated = output.facts.map((fact): ValidatedFact | null => {
    if (!FACT_KEY.test(fact.factKey) || !factFamilies.includes(fact.family) || !factTypes.includes(fact.factType))
      throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "Provider fact identity is invalid.");
    const statement = boundedText(fact.statement, 1200);
    if (!statement || forbiddenDecision.test(statement))
      throw new VendorIntelligenceError("PROHIBITED_DECISION_LANGUAGE", "Provider output contains prohibited decision language.");
    if (!Array.isArray(fact.citations) || !fact.citations.length || fact.citations.length > 8)
      throw new VendorIntelligenceError("CITATION_VALIDATION_FAILED", "Every fact requires evidence citations.");
    for (const citation of fact.citations) {
      if (!allowedFragments.has(citation.fragmentId) || !["supports", "contradicts", "context"].includes(citation.role))
        throw new VendorIntelligenceError("CITATION_VALIDATION_FAILED", "Provider citation is outside the vendor evidence boundary.");
    }
    const citations = [...new Map(
      fact.citations.map((citation) => [`${citation.fragmentId}:${citation.role}`, citation]),
    ).values()];
    let value: ReturnType<typeof validateValue>;
    try {
      value = validateValue(fact.valueKind, fact.value);
    } catch (error) {
      if (error instanceof VendorIntelligenceError && error.code === "SCHEMA_VALIDATION_FAILED") return null;
      throw error;
    }
    const fingerprint = `${fact.factKey}:${fact.valueKind}:${value.normalizedValue}:${citations.map((item) => `${item.fragmentId}:${item.role}`).sort().join(",")}`;
    if (seen.has(fingerprint)) return null;
    seen.add(fingerprint);
    return { ...fact, citations, statement, confidence: finiteConfidence(fact.confidence), ...value };
  });
  return validated.filter((fact): fact is ValidatedFact => fact !== null);
};

const numberWords = new Map([
  [0, "zero"], [1, "one"], [2, "two"], [3, "three"], [4, "four"], [5, "five"],
  [6, "six"], [7, "seven"], [8, "eight"], [9, "nine"], [10, "ten"], [11, "eleven"],
  [12, "twelve"], [13, "thirteen"], [14, "fourteen"], [15, "fifteen"], [16, "sixteen"],
  [17, "seventeen"], [18, "eighteen"], [19, "nineteen"], [20, "twenty"],
]);
const containsNumber = (content: string, expected: number) => {
  const values = content.match(/[-+]?\d[\d,]*(?:\.\d+)?/g) ?? [];
  if (values.some((value) => Number(value.replace(/,/g, "")) === expected)) return true;
  const word = numberWords.get(expected);
  return word ? new RegExp(`\\b${word}\\b`, "i").test(content) : false;
};

const meaningfulTokens = (value: string) => value.toLocaleLowerCase().normalize("NFKC")
  .match(/[a-z0-9]{3,}/g)?.filter((token) => !new Set(["and", "the", "with", "from", "this", "that", "will", "for"]).has(token)) ?? [];

const containsTypedValue = (fact: ValidatedFact, content: string) => {
  if (["number", "money", "quantity"].includes(fact.valueKind))
    return containsNumber(content, Number(fact.typedValue.number));
  if (fact.valueKind === "boolean") {
    const expected = fact.typedValue.boolean === true ? /\b(?:yes|true|required|included|provided)\b/i : /\b(?:no|false|excluded)\b|\bnot\s+(?:required|included|provided)\b/i;
    return expected.test(content);
  }
  const tokens = meaningfulTokens(fact.normalizedValue);
  if (!tokens.length) return false;
  const available = new Set(meaningfulTokens(content));
  const matches = tokens.filter((token) => available.has(token)).length;
  return matches >= Math.min(2, tokens.length) && matches / tokens.length >= 0.5;
};

const semanticTypeGrounded = (fact: ValidatedFact, content: string) => {
  if (fact.factType === "organization_size")
    return /\b(?:employees?|staff(?:ing)?|team\s+(?:of|size)|headcount|organization\s+size)\b/i.test(content) && /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand)\b/i.test(content);
  if (fact.factType === "client_reference")
    return /\b(?:client\s+reference|reference\s+contact|past\s+client|reference\s+project|project\s+reference)\b/i.test(content);
  return true;
};

export const validateGroundedFacts = (facts: ValidatedFact[], evidenceContent: Map<string, string>) => {
  for (const fact of facts) {
    if (fact.explicitness !== "explicit") continue;
    const citedContent = fact.citations
      .filter((citation) => citation.role !== "context")
      .map((citation) => evidenceContent.get(citation.fragmentId) ?? "");
    if (!citedContent.some((content) => containsTypedValue(fact, content) && semanticTypeGrounded(fact, content)))
      throw new VendorIntelligenceError("CITATION_GROUNDING_FAILED", "An explicit fact is not grounded by both its typed value and semantic fact type in the cited vendor text.");
  }
  return facts;
};

export const validateMappings = (
  output: ProviderMappingOutput,
  allowedRequirements: Set<string>,
  allowedFragments: Set<string>,
): ProviderMapping[] => {
  if (!output || !Array.isArray(output.mappings) || output.mappings.length > 40)
    throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "Provider mapping output is invalid.");
  const seen = new Set<string>();
  const validated = output.mappings.map((mapping) => {
    if (!allowedRequirements.has(mapping.requirementId) || seen.has(mapping.requirementId))
      throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "Provider requirement mapping identity is invalid.");
    seen.add(mapping.requirementId);
    const ids = Array.isArray(mapping.candidateFragmentIds) ? mapping.candidateFragmentIds : [];
    if (mapping.relationship === "none" ? ids.length !== 0 : ids.length === 0)
      throw new VendorIntelligenceError("CITATION_VALIDATION_FAILED", "Requirement mapping citation coverage is invalid.");
    if (ids.length > 8 || ids.some((id) => !allowedFragments.has(id)))
      throw new VendorIntelligenceError("CITATION_VALIDATION_FAILED", "Requirement mapping citation is outside the vendor evidence boundary.");
    return {
      ...mapping,
      confidence: finiteConfidence(mapping.confidence),
      candidateFragmentIds: [...new Set(ids)],
      ambiguityReasons: (Array.isArray(mapping.ambiguityReasons) ? mapping.ambiguityReasons : [])
        .map((item) => boundedText(item, 300)).filter(Boolean).slice(0, 10),
    };
  });
  if (validated.length !== allowedRequirements.size)
    throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "Provider omitted a requirement mapping.");
  return validated;
};

export const assignContradictionGroups = <T extends { factKey: string; normalizedValue: string }>(facts: T[]): Array<T & { contradictionGroup: string | null }> => {
  const byKey = new Map<string, Set<string>>();
  facts.forEach((fact) => {
    const values = byKey.get(fact.factKey) ?? new Set<string>();
    if (fact.normalizedValue) values.add(fact.normalizedValue.toLocaleLowerCase());
    byKey.set(fact.factKey, values);
  });
  return facts.map((fact) => ({
    ...fact,
    contradictionGroup: (byKey.get(fact.factKey)?.size ?? 0) > 1
      ? `contradiction:${crypto.createHash("sha256").update(fact.factKey).digest("hex").slice(0, 16)}`
      : null,
  }));
};

export const validateFactCorrectionPayload = (
  valueKind: string,
  payload: Record<string, unknown> | null,
) => {
  const normalizedValue = typeof payload?.normalizedValue === "string"
    ? payload.normalizedValue.trim()
    : "";
  const candidate = payload?.typedValue;
  if (
    !normalizedValue
    || normalizedValue.length > 2000
    || !candidate
    || typeof candidate !== "object"
    || Array.isArray(candidate)
  ) throw new VendorIntelligenceError("REVIEW_CORRECTION_INVALID", "The reviewed fact correction is invalid.", 409);
  const typedValue = candidate as Record<string, unknown>;
  if (![
    "string", "number", "boolean", "money", "date", "date_range",
    "duration", "quantity", "list", "unknown",
  ].includes(valueKind) || typedValue.kind !== valueKind)
    throw new VendorIntelligenceError("REVIEW_CORRECTION_INVALID", "The reviewed fact correction does not match the extracted fact type.", 409);
  const numeric = Number(typedValue.number);
  if (["number", "money", "quantity"].includes(valueKind) && !Number.isFinite(numeric))
    throw new VendorIntelligenceError("REVIEW_CORRECTION_INVALID", "The reviewed numeric correction is invalid.", 409);
  if (valueKind === "money" && (typeof typedValue.currency !== "string" || !/^[A-Z]{3}$/.test(typedValue.currency)))
    throw new VendorIntelligenceError("REVIEW_CORRECTION_INVALID", "The reviewed money correction requires an ISO currency.", 409);
  if (valueKind === "boolean" && typeof typedValue.boolean !== "boolean")
    throw new VendorIntelligenceError("REVIEW_CORRECTION_INVALID", "The reviewed boolean correction is invalid.", 409);
  if (valueKind === "list" && (
    !Array.isArray(typedValue.list)
    || typedValue.list.length === 0
    || typedValue.list.length > 30
    || typedValue.list.some((item) => typeof item !== "string" || !item.trim() || item.length > 300)
  )) throw new VendorIntelligenceError("REVIEW_CORRECTION_INVALID", "The reviewed list correction is invalid.", 409);
  if (["string", "date", "date_range", "duration"].includes(valueKind) && (typeof typedValue.text !== "string" || !typedValue.text.trim()))
    throw new VendorIntelligenceError("REVIEW_CORRECTION_INVALID", "The reviewed text correction is invalid.", 409);
  return {
    normalizedValue,
    typedValue,
    currency: valueKind === "money" ? String(typedValue.currency) : null,
  };
};

export const contentChecksum = (value: unknown): string =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
