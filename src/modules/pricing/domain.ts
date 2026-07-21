import { aiRuntimeAuthorized } from "../../../config/aiEnvironment";

export class PricingError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}

export const pricingEnabled = () => aiRuntimeAuthorized() && process.env.PRICING_CORPUS_ENABLED === "true";

// Enum values mirror the CHECK constraints on rfpilot.pricing_records and
// rfpilot.expert_rules (migration 020) so invalid input fails with a typed
// 422 before it ever reaches the database.
export const PRICING_CATEGORIES = [
  "audio", "video", "lighting", "staging", "led_wall", "projection", "breakout_room", "general_session",
  "labor", "rigging", "power", "trucking_freight", "travel_per_diem", "venue_fee", "insurance", "service_charge_tax", "other",
] as const;
export const PRICING_UNITS = ["per_day", "per_event", "per_hour", "per_person", "per_room", "flat"] as const;
export const DAY_TYPES = ["standard", "overtime", "holiday", "any"] as const;
export const CONDITION_OPS = ["eq", "neq", "gte", "lte", "contains", "filled", "empty"] as const;
export const EFFECT_KINDS = ["recommendation", "cost_factor", "ancillary_flag"] as const;
export const PRICING_RECORD_STATUSES = ["draft", "approved", "retired"] as const;
export const EXPERT_RULE_STATUSES = ["draft", "active", "retired"] as const;

export type PricingCategory = (typeof PRICING_CATEGORIES)[number];
export type PricingUnit = (typeof PRICING_UNITS)[number];
export type DayType = (typeof DAY_TYPES)[number];
export type ConditionOp = (typeof CONDITION_OPS)[number];
export type EffectKind = (typeof EFFECT_KINDS)[number];

export type PricingRecordInput = {
  category: PricingCategory;
  itemLabel: string;
  unit: PricingUnit;
  amountLowMinor: number;
  amountMidMinor: number;
  amountHighMinor: number;
  currency: string;
  market: string | null;
  dayType: DayType;
  laborRole: string | null;
  sourceFragmentId: string | null;
  sourceNote: string;
};

export type RuleCondition = { path: string; op: ConditionOp; value: string | number | boolean | null };
export type RuleEffect = { kind: EffectKind; category: PricingCategory | null; guidanceText: string; factorPercent: number | null };
export type ExpertRuleInput = {
  ruleKey: string;
  title: string;
  explanation: string;
  conditions: RuleCondition[];
  effect: RuleEffect;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const recordFail = (message: string): never => { throw new PricingError("INVALID_PRICING_RECORD", message); };
const ruleFail = (message: string): never => { throw new PricingError("INVALID_EXPERT_RULE", message); };

const asObject = (value: unknown, fail: (message: string) => never): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("A JSON object body is required.");
  return value as Record<string, unknown>;
};
const requiredText = (value: unknown, label: string, max: number, fail: (message: string) => never): string => {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < 1 || text.length > max) fail(`${label} must be between 1 and ${max} characters.`);
  return text;
};
const optionalText = (value: unknown, label: string, max: number, fail: (message: string) => never): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(`${label} must be a string when provided.`);
  const text = (value as string).trim();
  if (text.length > max) fail(`${label} must be at most ${max} characters.`);
  return text || null;
};
const minorAmount = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    recordFail(`${label} must be a non-negative integer amount in minor units.`);
  return value as number;
};
const memberOf = <T extends string>(allowed: readonly T[], value: unknown, label: string, fail: (message: string) => never): T => {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value))
    fail(`${label} must be one of: ${allowed.join(", ")}.`);
  return value as T;
};

export const parsePricingRecordInput = (value: unknown): PricingRecordInput => {
  const body = asObject(value, recordFail);
  const category = memberOf(PRICING_CATEGORIES, body.category, "category", recordFail);
  const itemLabel = requiredText(body.itemLabel, "itemLabel", 200, recordFail);
  const unit = memberOf(PRICING_UNITS, body.unit, "unit", recordFail);
  const amountLowMinor = minorAmount(body.amountLowMinor, "amountLowMinor");
  const amountMidMinor = minorAmount(body.amountMidMinor, "amountMidMinor");
  const amountHighMinor = minorAmount(body.amountHighMinor, "amountHighMinor");
  if (amountLowMinor > amountMidMinor || amountMidMinor > amountHighMinor)
    recordFail("Amounts must satisfy low <= mid <= high.");
  const currency = typeof body.currency === "string" ? body.currency.trim() : "";
  if (!/^[A-Z]{3}$/.test(currency)) recordFail("currency must be a 3-letter uppercase ISO code.");
  const market = optionalText(body.market, "market", 100, recordFail);
  const dayType = body.dayType === undefined || body.dayType === null
    ? "any"
    : memberOf(DAY_TYPES, body.dayType, "dayType", recordFail);
  const laborRole = optionalText(body.laborRole, "laborRole", 100, recordFail);
  const sourceFragmentId = body.sourceFragmentId === undefined || body.sourceFragmentId === null
    ? null
    : typeof body.sourceFragmentId === "string" && UUID_PATTERN.test(body.sourceFragmentId)
      ? body.sourceFragmentId.toLowerCase()
      : recordFail("sourceFragmentId must be a UUID when provided.");
  const sourceNote = optionalText(body.sourceNote, "sourceNote", 500, recordFail) ?? "";
  return { category, itemLabel, unit, amountLowMinor, amountMidMinor, amountHighMinor, currency, market, dayType, laborRole, sourceFragmentId, sourceNote };
};

const parseCondition = (value: unknown, ordinal: number): RuleCondition => {
  const body = asObject(value, ruleFail);
  const path = typeof body.path === "string" ? body.path.trim() : "";
  if (!path.startsWith("/content/") || path.length > 200)
    ruleFail(`conditions[${ordinal}].path must start with /content/ and be at most 200 characters.`);
  const op = memberOf(CONDITION_OPS, body.op, `conditions[${ordinal}].op`, ruleFail);
  if (op === "filled" || op === "empty") {
    if (body.value !== undefined && body.value !== null)
      ruleFail(`conditions[${ordinal}].value must be omitted for the ${op} operator.`);
    return { path, op, value: null };
  }
  const raw = body.value;
  if (typeof raw === "string") {
    if (raw.length > 200) ruleFail(`conditions[${ordinal}].value must be at most 200 characters.`);
    return { path, op, value: raw };
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) ruleFail(`conditions[${ordinal}].value must be a finite number.`);
    return { path, op, value: raw };
  }
  if (typeof raw === "boolean") return { path, op, value: raw };
  return ruleFail(`conditions[${ordinal}].value is required for the ${op} operator and must be a string, number, or boolean.`);
};

const parseEffect = (value: unknown): RuleEffect => {
  const body = asObject(value, ruleFail);
  const kind = memberOf(EFFECT_KINDS, body.kind, "effect.kind", ruleFail);
  const category = body.category === undefined || body.category === null
    ? null
    : memberOf(PRICING_CATEGORIES, body.category, "effect.category", ruleFail);
  const guidanceText = requiredText(body.guidanceText, "effect.guidanceText", 500, ruleFail);
  if (kind !== "cost_factor") return { kind, category, guidanceText, factorPercent: null };
  const factorPercent = body.factorPercent;
  if (typeof factorPercent !== "number" || !Number.isFinite(factorPercent) || factorPercent < -50 || factorPercent > 100)
    ruleFail("effect.factorPercent must be a number between -50 and 100 for cost_factor effects.");
  return { kind, category, guidanceText, factorPercent: factorPercent as number };
};

export const parseExpertRuleInput = (value: unknown): ExpertRuleInput => {
  const body = asObject(value, ruleFail);
  const ruleKey = typeof body.ruleKey === "string" ? body.ruleKey.trim() : "";
  if (!/^[a-z0-9_-]{3,80}$/.test(ruleKey))
    ruleFail("ruleKey must be 3-80 characters of lowercase letters, digits, underscores, or hyphens.");
  const title = requiredText(body.title, "title", 200, ruleFail);
  const explanation = optionalText(body.explanation, "explanation", 1000, ruleFail) ?? "";
  if (body.conditions !== undefined && !Array.isArray(body.conditions))
    ruleFail("conditions must be an array.");
  const rawConditions = Array.isArray(body.conditions) ? body.conditions : [];
  if (rawConditions.length > 20) ruleFail("A rule may declare at most 20 conditions.");
  const conditions = rawConditions.map((condition, ordinal) => parseCondition(condition, ordinal));
  const effect = parseEffect(body.effect);
  return { ruleKey, title, explanation, conditions, effect };
};

export const parseStatusChange = (value: unknown, allowed: readonly string[]): string => {
  const body = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const status = typeof body.status === "string" ? body.status.trim() : "";
  if (!allowed.includes(status))
    throw new PricingError("INVALID_STATUS", `status must be one of: ${allowed.join(", ")}.`);
  return status;
};
