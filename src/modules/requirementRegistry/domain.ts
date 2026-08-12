import crypto from "node:crypto";
import { aiRuntimeAuthorized } from "../../../config/aiEnvironment";

export class RequirementRegistryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422,
  ) {
    super(message);
  }
}

export const requirementRegistryEnabled = () =>
  aiRuntimeAuthorized() && process.env.PROPOSAL_INTELLIGENCE_ENABLED === "true";
export const requirementRegistryWritesEnabled = () =>
  requirementRegistryEnabled() &&
  process.env.PROPOSAL_INTELLIGENCE_WRITES_ENABLED === "true";

export const REQUIREMENT_KINDS = [
  "submission",
  "mandatory",
  "technical",
  "commercial",
  "staffing",
  "references",
  "sustainability_dei",
  "legal_policy",
  "narrative",
] as const;
export const MANDATORY_STATUSES = ["pending", "mandatory", "not_mandatory"] as const;
export const IMPORTANCE_LEVELS = ["high", "medium", "low"] as const;
export const VERIFICATION_METHODS = [
  "pending",
  "document",
  "narrative",
  "demonstration",
  "reference",
  "commercial",
  "administrative",
] as const;

export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];
export type MandatoryStatus = (typeof MANDATORY_STATUSES)[number];
export type Importance = (typeof IMPORTANCE_LEVELS)[number];
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export type GeneratedCriterion = {
  key: string;
  name: string;
  description: string;
  weight: number;
  ordinal: number;
};
export type GeneratedRequirement = {
  key: string;
  kind: RequirementKind;
  title: string;
  text: string;
  mandatoryStatus: MandatoryStatus;
  sourceKind: "canonical_proposal" | "rendered_rfp";
  sourceLocator: Record<string, unknown>;
  suggestedCriterionKey: string | null;
  importance: Importance;
  verificationMethod: VerificationMethod;
  groupKey: string;
  ordinal: number;
};

export type RegistryValidation = {
  blocking: Array<{ code: string; count?: number; message: string }>;
  warnings: Array<{ code: string; count?: number; message: string }>;
};

export const canonicalJson = (value: unknown): string => {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, sort(child)]),
      );
    return item;
  };
  return JSON.stringify(sort(value));
};
export const checksum = (value: unknown) =>
  crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");

const oneOf = <T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] => {
  if (typeof value !== "string" || !allowed.includes(value))
    throw new RequirementRegistryError("INVALID_REQUIREMENT_UPDATE", `${field} is invalid.`, 400);
  return value as T[number];
};
const text = (value: unknown, field: string, max: number) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > max)
    throw new RequirementRegistryError("INVALID_REQUIREMENT_UPDATE", `${field} is required and must be at most ${max} characters.`, 400);
  return normalized;
};

export type RequirementUpdate = {
  title?: string;
  text?: string;
  kind?: RequirementKind;
  mandatoryStatus?: MandatoryStatus;
  mandatoryReviewed?: boolean;
  eligibility?: boolean;
  criterionId?: string | null;
  criterionReviewed?: boolean;
  importance?: Importance;
  verificationMethod?: VerificationMethod;
};

export const parseRequirementUpdate = (value: unknown): RequirementUpdate => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequirementRegistryError("INVALID_REQUIREMENT_UPDATE", "A requirement update is required.", 400);
  const body = value as Record<string, unknown>;
  const update: RequirementUpdate = {};
  if (body.title !== undefined) update.title = text(body.title, "title", 300);
  if (body.text !== undefined) update.text = text(body.text, "text", 8000);
  if (body.kind !== undefined) update.kind = oneOf(body.kind, REQUIREMENT_KINDS, "kind");
  if (body.mandatoryStatus !== undefined) update.mandatoryStatus = oneOf(body.mandatoryStatus, MANDATORY_STATUSES, "mandatoryStatus");
  if (body.importance !== undefined) update.importance = oneOf(body.importance, IMPORTANCE_LEVELS, "importance");
  if (body.verificationMethod !== undefined) update.verificationMethod = oneOf(body.verificationMethod, VERIFICATION_METHODS, "verificationMethod");
  for (const field of ["mandatoryReviewed", "eligibility", "criterionReviewed"] as const) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== "boolean")
        throw new RequirementRegistryError("INVALID_REQUIREMENT_UPDATE", `${field} must be a boolean.`, 400);
      update[field] = body[field] as never;
    }
  }
  if (body.criterionId !== undefined) {
    if (body.criterionId !== null && (typeof body.criterionId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.criterionId)))
      throw new RequirementRegistryError("INVALID_REQUIREMENT_UPDATE", "criterionId is invalid.", 400);
    update.criterionId = body.criterionId as string | null;
  }
  if (!Object.keys(update).length)
    throw new RequirementRegistryError("INVALID_REQUIREMENT_UPDATE", "At least one editable field is required.", 400);
  return update;
};

export const parseExpectedVersion = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new RequirementRegistryError("EXPECTED_VERSION_REQUIRED", "A valid expectedVersion is required.", 400);
  return parsed;
};

export const validateForApproval = (input: {
  weightsConfirmed: boolean;
  criteria: Array<{ id: string; weight: number }>;
  requirements: Array<{
    mandatory_status: MandatoryStatus;
    mandatory_reviewed: boolean;
    source_locator: unknown;
    criterion_id: string | null;
    criterion_reviewed: boolean;
    verification_method: VerificationMethod;
  }>;
}): RegistryValidation => {
  const blocking: RegistryValidation["blocking"] = [];
  const warnings: RegistryValidation["warnings"] = [];
  const total = input.criteria.reduce((sum, item) => sum + Number(item.weight), 0);
  if (!input.weightsConfirmed)
    blocking.push({ code: "WEIGHTS_NOT_CONFIRMED", message: "Confirm the evaluation matrix before approval." });
  if (!input.criteria.length)
    blocking.push({ code: "CRITERIA_REQUIRED", message: "At least one evaluation criterion is required." });
  else if (Math.abs(total - 100) > 0.001)
    blocking.push({ code: "WEIGHTS_MUST_TOTAL_100", message: `Evaluation weights total ${total}, not 100.` });
  const mandatoryPending = input.requirements.filter((item) => !item.mandatory_reviewed || item.mandatory_status === "pending").length;
  const criteriaPending = input.requirements.filter((item) => !item.criterion_reviewed || !item.criterion_id).length;
  const verificationPending = input.requirements.filter((item) => item.verification_method === "pending").length;
  const sourceMissing = input.requirements.filter((item) => item.mandatory_status === "mandatory" && (!item.source_locator || typeof item.source_locator !== "object")).length;
  if (!input.requirements.length)
    blocking.push({ code: "REQUIREMENTS_REQUIRED", message: "At least one requirement is required." });
  if (mandatoryPending)
    blocking.push({ code: "MANDATORY_REVIEW_REQUIRED", count: mandatoryPending, message: `${mandatoryPending} requirements need mandatory-status review.` });
  if (criteriaPending)
    blocking.push({ code: "CRITERION_REVIEW_REQUIRED", count: criteriaPending, message: `${criteriaPending} requirements need criterion review.` });
  if (verificationPending)
    blocking.push({ code: "VERIFICATION_REVIEW_REQUIRED", count: verificationPending, message: `${verificationPending} requirements need a verification method.` });
  if (sourceMissing)
    blocking.push({ code: "MANDATORY_SOURCE_REQUIRED", count: sourceMissing, message: `${sourceMissing} mandatory requirements are missing a source.` });
  return { blocking, warnings };
};
