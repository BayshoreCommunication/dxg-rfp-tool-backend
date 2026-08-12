import crypto from "node:crypto";

export const MAPPING_VERSION = "requirement-mapping.v1";
export const FACT_VERSION = "vendor-fact.v1";
export const VALIDATION_VERSION = "mapping-fact-validation.v1";
export const PROMPT_VERSION = "vendor-intelligence-prompt.v1";

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
  if (!output || !Array.isArray(output.facts) || output.facts.length > 120)
    throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "Provider fact output is invalid.");
  const seen = new Set<string>();
  return output.facts.map((fact) => {
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
    const value = validateValue(fact.valueKind, fact.value);
    const fingerprint = `${fact.factKey}:${fact.valueKind}:${value.normalizedValue}:${fact.citations.map((item) => item.fragmentId).sort().join(",")}`;
    if (seen.has(fingerprint))
      throw new VendorIntelligenceError("SCHEMA_VALIDATION_FAILED", "Provider returned a duplicate fact.");
    seen.add(fingerprint);
    return { ...fact, statement, confidence: finiteConfidence(fact.confidence), ...value };
  });
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

export const contentChecksum = (value: unknown): string =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
