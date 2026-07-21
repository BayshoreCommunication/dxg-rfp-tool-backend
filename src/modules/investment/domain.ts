import { aiRuntimeAuthorized } from "../../../config/aiEnvironment";

export class InvestmentError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}

export const investmentEnabled = () => aiRuntimeAuthorized() && process.env.INVESTMENT_GUIDANCE_ENABLED === "true";

export type PricingRecord = {
  id: string; category: string; itemLabel: string; unit: string;
  amountLowMinor: number; amountMidMinor: number; amountHighMinor: number;
  currency: string; market: string | null; dayType: string; laborRole: string | null;
};
export type ExpertRule = {
  id: string; ruleKey: string; title: string; explanation: string;
  conditions: Array<{ path: string; op: string; value?: unknown }>;
  effect: { kind: string; category?: string | null; guidanceText?: string; factorPercent?: number };
};
export type LineItem = {
  category: string; label: string; currency: string;
  lowMinor: number; midMinor: number; highMinor: number;
  provenance: { pricingRecordIds: string[]; ruleIds: string[]; drivers: Record<string, number> };
};
export type Refusal = { category: string; reason: string; ask: string };
export type AncillaryFactor = { factor: string; status: "estimated" | "venue_dependent" | "no_data"; note: string; lowMinor?: number; midMinor?: number; highMinor?: number };
export type InvestmentResult = {
  currency: string | null;
  totalLowMinor: number | null; totalMidMinor: number | null; totalHighMinor: number | null;
  lineItems: LineItem[]; refusals: Refusal[]; ancillary: AncillaryFactor[];
  recommendations: Array<{ ruleKey: string; title: string; guidanceText: string; explanation: string }>;
};

const valueAt = (proposal: Record<string, unknown>, path: string): unknown =>
  path.replace(/^\/content\//, "").split("/").reduce<unknown>((node, key) =>
    node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined, proposal);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const isYes = (value: unknown) => /^(yes|true)$/i.test(text(value)) || value === true;
const filled = (value: unknown) => value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "");
const asNumber = (value: unknown): number | null => {
  const n = Number(typeof value === "string" ? value.trim() : value);
  return Number.isFinite(n) ? n : null;
};

export const evaluateCondition = (proposal: Record<string, unknown>, condition: { path: string; op: string; value?: unknown }): boolean => {
  const actual = valueAt(proposal, condition.path);
  switch (condition.op) {
    case "filled": return filled(actual);
    case "empty": return !filled(actual);
    case "eq": return text(actual).toLowerCase() === text(condition.value).toLowerCase() || (asNumber(actual) !== null && asNumber(actual) === asNumber(condition.value));
    case "neq": return !evaluateCondition(proposal, { ...condition, op: "eq" });
    case "gte": { const a = asNumber(actual), b = asNumber(condition.value); return a !== null && b !== null && a >= b; }
    case "lte": { const a = asNumber(actual), b = asNumber(condition.value); return a !== null && b !== null && a <= b; }
    case "contains": return text(actual).toLowerCase().includes(text(condition.value).toLowerCase());
    default: return false;
  }
};

const eventDays = (proposal: Record<string, unknown>): number => {
  const start = new Date(text(valueAt(proposal, "/content/event/startDate")));
  const end = new Date(text(valueAt(proposal, "/content/event/endDate")));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;
  const span = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  return Math.min(Math.max(span, 1), 30);
};

const CORE_LABELS: Record<string, string> = {
  audio: "Audio", video: "Video", lighting: "Lighting", staging: "Staging",
  labor: "Labor", general_session: "General session", breakout_room: "Breakout rooms",
  led_wall: "LED wall", projection: "Projection", rigging: "Rigging", power: "Power",
};
const ANCILLARY_FACTORS: Array<{ factor: string; category: string; venueDependent: boolean; note: string }> = [
  { factor: "Trucking & freight", category: "trucking_freight", venueDependent: false, note: "Depends on vendor location and equipment volume." },
  { factor: "Crew travel & per diem", category: "travel_per_diem", venueDependent: false, note: "Depends on crew origin and event duration." },
  { factor: "Venue fees & exclusivity", category: "venue_fee", venueDependent: true, note: "Ask the venue for AV exclusivity, patch and facility fees." },
  { factor: "Rigging fees", category: "rigging", venueDependent: true, note: "Ask the venue for rigging rates and required house riggers." },
  { factor: "Power charges", category: "power", venueDependent: true, note: "Ask the venue for power drop rates and available amperage." },
  { factor: "Insurance", category: "insurance", venueDependent: false, note: "Confirm COI requirements and coverage limits." },
  { factor: "Service charges & taxes", category: "service_charge_tax", venueDependent: true, note: "Ask the venue and vendors for service charge and tax percentages." },
];

// Deterministic range engine (SOW WS3): every number traces to approved
// pricing records and/or expert rules; unsupported categories are refused
// explicitly rather than estimated. No model calls.
export const computeInvestmentGuidance = (
  proposal: Record<string, unknown>,
  records: PricingRecord[],
  rules: ExpertRule[],
): InvestmentResult => {
  const days = eventDays(proposal);
  const roomCount = asNumber(valueAt(proposal, "/content/venueSchedule/numberOfEventRooms"))
    ?? (Array.isArray((proposal as { roomByRoom?: unknown[] }).roomByRoom) ? (proposal as { roomByRoom: unknown[] }).roomByRoom.length : 0);
  const matchedRules = rules.filter((rule) => (rule.conditions ?? []).every((condition) => evaluateCondition(proposal, condition)));

  const coreCategories = new Set(["audio", "video", "lighting", "staging", "labor"]);
  if ((roomCount ?? 0) > 1) coreCategories.add("breakout_room");
  if (isYes(valueAt(proposal, "/content/venue/riggingRequired"))) coreCategories.add("rigging");
  if (isYes(valueAt(proposal, "/content/venue/powerDropsRequired"))) coreCategories.add("power");
  const optionalCategories = new Set(["general_session", "led_wall", "projection"]);

  const quantityFor = (unit: string): { quantity: number; driver: string } | null => {
    if (unit === "per_day") return { quantity: days, driver: "days" };
    if (unit === "per_room") return { quantity: Math.max(roomCount ?? 0, 1), driver: "rooms" };
    if (unit === "per_event" || unit === "flat") return { quantity: 1, driver: "event" };
    return null; // per_person / per_hour need data the proposal cannot support yet
  };

  const approvedByCategory = new Map<string, PricingRecord[]>();
  for (const record of records) {
    const bucket = approvedByCategory.get(record.category) ?? [];
    bucket.push(record);
    approvedByCategory.set(record.category, bucket);
  }
  const currencyVotes = new Map<string, number>();
  for (const record of records) currencyVotes.set(record.currency, (currencyVotes.get(record.currency) ?? 0) + 1);
  const currency = [...currencyVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const lineItems: LineItem[] = [];
  const refusals: Refusal[] = [];
  const buildLine = (category: string): LineItem | null => {
    const usable = (approvedByCategory.get(category) ?? []).filter((record) => record.currency === currency);
    let low = 0, mid = 0, high = 0;
    const ids: string[] = [];
    const drivers: Record<string, number> = {};
    for (const record of usable) {
      const scaled = quantityFor(record.unit);
      if (!scaled) continue;
      low += record.amountLowMinor * scaled.quantity;
      mid += record.amountMidMinor * scaled.quantity;
      high += record.amountHighMinor * scaled.quantity;
      ids.push(record.id);
      drivers[scaled.driver] = scaled.quantity;
    }
    if (!ids.length) return null;
    return { category, label: CORE_LABELS[category] ?? category, currency: currency!, lowMinor: low, midMinor: mid, highMinor: high, provenance: { pricingRecordIds: ids, ruleIds: [], drivers } };
  };

  for (const category of coreCategories) {
    const line = buildLine(category);
    if (line) lineItems.push(line);
    else refusals.push({
      category,
      reason: `No approved pricing data supports a defensible range for ${CORE_LABELS[category] ?? category}.`,
      ask: `Request line-item ${CORE_LABELS[category]?.toLowerCase() ?? category} pricing from vendors, or load historical cost data for this category.`,
    });
  }
  for (const category of optionalCategories) {
    if (coreCategories.has(category)) continue;
    const line = buildLine(category);
    if (line) lineItems.push(line);
  }

  for (const rule of matchedRules) {
    if (rule.effect?.kind !== "cost_factor" || typeof rule.effect.factorPercent !== "number") continue;
    const factor = 1 + rule.effect.factorPercent / 100;
    for (const line of lineItems) {
      if (rule.effect.category && line.category !== rule.effect.category) continue;
      line.lowMinor = Math.round(line.lowMinor * factor);
      line.midMinor = Math.round(line.midMinor * factor);
      line.highMinor = Math.round(line.highMinor * factor);
      line.provenance.ruleIds.push(rule.id);
    }
  }

  const ancillary: AncillaryFactor[] = ANCILLARY_FACTORS
    .filter((item) => !coreCategories.has(item.category))
    .map((item) => {
      const usable = (approvedByCategory.get(item.category) ?? []).filter((record) => record.currency === currency);
      let low = 0, mid = 0, high = 0, priced = false;
      for (const record of usable) {
        const scaled = quantityFor(record.unit);
        if (!scaled) continue;
        priced = true;
        low += record.amountLowMinor * scaled.quantity;
        mid += record.amountMidMinor * scaled.quantity;
        high += record.amountHighMinor * scaled.quantity;
      }
      if (priced) return { factor: item.factor, status: "estimated" as const, note: item.note, lowMinor: low, midMinor: mid, highMinor: high };
      return { factor: item.factor, status: item.venueDependent ? ("venue_dependent" as const) : ("no_data" as const), note: item.note };
    });
  if (isYes(valueAt(proposal, "/content/venueSchedule/isUnionVenue")))
    ancillary.push({ factor: "Union labor conditions", status: "venue_dependent", note: "This is a union venue: confirm labor rules, minimum calls and steward requirements — they materially change labor cost." });
  for (const rule of matchedRules) {
    if (rule.effect?.kind !== "ancillary_flag" || !rule.effect.guidanceText) continue;
    ancillary.push({ factor: rule.title, status: "venue_dependent", note: rule.effect.guidanceText });
  }

  const recommendations = matchedRules
    .filter((rule) => rule.effect?.kind === "recommendation" && rule.effect.guidanceText)
    .map((rule) => ({ ruleKey: rule.ruleKey, title: rule.title, guidanceText: rule.effect.guidanceText!, explanation: rule.explanation }));

  const hasLines = lineItems.length > 0;
  const sum = (pick: (line: LineItem) => number) => lineItems.reduce((total, line) => total + pick(line), 0);
  return {
    currency: hasLines ? currency : null,
    totalLowMinor: hasLines ? sum((l) => l.lowMinor) : null,
    totalMidMinor: hasLines ? sum((l) => l.midMinor) : null,
    totalHighMinor: hasLines ? sum((l) => l.highMinor) : null,
    lineItems, refusals, ancillary, recommendations,
  };
};
