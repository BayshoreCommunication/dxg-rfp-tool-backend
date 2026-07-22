// Multiplier stack for the DXG AV pricing engine. Every number comes from the
// approved pricing_regional_factors / pricing_modifiers / pricing_confidence_rules
// rows; only the *selection* logic (which market, which union tier, what a
// factor is allowed to touch) lives in code.

import type { ProposalFacts } from "./proposalAccess";

export type ModifierScope = "labor" | "equipment" | "subtotal";
export type RegionalFactor = { id: string; market: string; factor: number; notes: string };
export type PricingModifier = { id: string; kind: string; conditionKey: string; label: string; factor: number; scope: ModifierScope; notes: string };
export type ConfidenceRule = { id: string; ruleKey: string; label: string; deduction: number; reason: string };
export type AppliedFactor = { kind: string; label: string; factor: number };

// Buckets, not places: they are fallbacks a human picks, never auto-matched.
const GENERIC_MARKET = /^(secondary|tertiary)\b/i;
// Colloquial names and anchor venues that map onto a workbook market.
const MARKET_HINTS: Array<{ hint: RegExp; market: RegExp }> = [
  { hint: /\bnyc\b|\bnew york\b|\bmanhattan\b|\bbrooklyn\b|\bjavits\b/i, market: /^new york city$/i },
  { hint: /\bbay area\b|\bsan francisco\b|\bmoscone\b|\boakland\b|\bsan jose\b/i, market: /^san francisco/i },
  { hint: /\bwashington\b|\bd\.?c\.?\b|\bnational harbor\b/i, market: /^washington dc$/i },
  { hint: /\bvegas\b|\bmandalay\b|\bvenetian\b/i, market: /^las vegas$/i },
  { hint: /\banaheim\b|\blong beach\b/i, market: /^los angeles$/i },
  { hint: /\bmccormick\b/i, market: /^chicago$/i },
  { hint: /\borange county convention\b/i, market: /^orlando$/i },
];
// Markets where the workbook calls the local jurisdiction "heavy".
const HEAVY_UNION_MARKET = /^(new york city|chicago|san francisco)/i;
const STANDARD_UNION_FLOOR = 1.15;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const aliases = (market: string) => market.split("/").map((part) => part.trim()).filter(Boolean);

export type MarketMatch = { market: string; factor: number; source: RegionalFactor | null };
export const UNKNOWN_MARKET: MarketMatch = { market: "", factor: 1, source: null };

export const matchMarket = (facts: ProposalFacts, factors: RegionalFactor[]): MarketMatch => {
  const haystack = facts.marketText;
  if (!haystack.trim()) return UNKNOWN_MARKET;
  const usable = factors.filter((factor) => !GENERIC_MARKET.test(factor.market));
  let best: { source: RegionalFactor; length: number } | null = null;
  for (const source of usable)
    for (const alias of aliases(source.market)) {
      if (!new RegExp(`\\b${escape(alias)}\\b`, "i").test(haystack)) continue;
      if (!best || alias.length > best.length) best = { source, length: alias.length };
    }
  if (!best)
    for (const { hint, market } of MARKET_HINTS) {
      if (!hint.test(haystack)) continue;
      const source = usable.find((factor) => market.test(factor.market));
      if (source) { best = { source, length: source.market.length }; break; }
    }
  return best ? { market: best.source.market, factor: best.source.factor, source: best.source } : UNKNOWN_MARKET;
};

export const findModifier = (modifiers: PricingModifier[], kind: string, conditionKey: string): PricingModifier | null =>
  modifiers.find((modifier) => modifier.kind === kind && modifier.conditionKey === conditionKey) ?? null;

// Union tier is chosen from market heaviness, exactly as the workbook does:
// NYC / Chicago / SF carry a separate rigging local and strict jurisdiction.
export const unionConditionKey = (market: MarketMatch): string =>
  HEAVY_UNION_MARKET.test(market.market) ? "union_heavy_nyc_chicago_sf"
    : market.factor >= STANDARD_UNION_FLOOR ? "union_standard"
      : "union_light";

export type StackChoice = { unionKey: string; inHouseKey: string; serviceCharge: boolean };
export const BASELINE_UNION_KEY = "non_union_baseline";
export const BASELINE_IN_HOUSE_KEY = "outside_independent_av_baseline";
export const TYPICAL_IN_HOUSE_KEY = "hotel_in_house_typical";
export const SERVICE_CHARGE_KEY = "service_charge_commission";
export const DAY_TWO_KEY = "day_2_per_additional_show_day";

export const appliedStackChoice = (facts: ProposalFacts, market: MarketMatch): StackChoice => ({
  unionKey: facts.unionVenue === "yes" ? unionConditionKey(market) : BASELINE_UNION_KEY,
  inHouseKey: facts.avProvider === "in_house" ? TYPICAL_IN_HOUSE_KEY : BASELINE_IN_HOUSE_KEY,
  serviceCharge: facts.avProvider === "in_house",
});

// Equipment is not billed at full rate every day: day 1 is full, each further
// show day carries the day_2 hold-over factor. Labor is hours x days instead.
export const multiDayFactor = (days: number, modifiers: PricingModifier[]): { factor: number; source: PricingModifier | null } => {
  const source = findModifier(modifiers, "multi_day", DAY_TWO_KEY);
  if (days <= 1 || !source) return { factor: 1, source: null };
  return { factor: 1 + source.factor * (days - 1), source };
};

export type ConfidenceContext = {
  facts: ProposalFacts;
  marketMatched: boolean;
  baselineOnly: boolean;
  pricedKeys: string[];
  hasLines: boolean;
};
const priced = (context: ConfidenceContext, pattern: RegExp) => context.pricedKeys.some((key) => pattern.test(key));

// Each rule_key that the corpus can carry is mapped to an explicit "is this
// input missing?" test. Rule keys with no mapping are ignored - the engine
// never invents a deduction it cannot explain.
export const CONFIDENCE_CHECKS: Record<string, (context: ConfidenceContext) => boolean> = {
  audience_room_size_not_stated_sound_gs: (c) => !c.facts.audienceStated,
  connectivity_bandwidth_needs_unknown: (c) => !c.facts.internetAnswered,
  hotel_in_house_vs_outside_av_unknown: (c) => c.facts.avProvider === "unknown",
  hybrid_streaming_scope_unclear: (c) => c.facts.hybridRequested && !c.facts.streamingScopeStated,
  interpretation_accessibility_needs_unstated: (c) => !c.facts.accessibilityAnswered,
  market_city_unknown: (c) => !c.marketMatched,
  no_calibrated_dxg_actuals_for_this_category: (c) => c.hasLines && c.baselineOnly,
  projection_brightness_lumens_not_stated: (c) => priced(c, /projector/) && !c.facts.lumensStated,
  scope_vague_av_for_general_session: (c) => !c.facts.roomDetailStated,
  screen_led_size_or_pixel_pitch_not_stated: (c) => priced(c, /screen|led_wall/) && !c.facts.surfaceSizeStated,
  show_days_schedule_unknown: (c) => !c.facts.datesStated,
  union_status_unknown: (c) => c.facts.unionVenue === "unknown",
  wireless_channel_count_not_stated: (c) => priced(c, /wireless_mic/) && c.facts.wirelessChannels === null,
};

export type ConfidenceDeduction = { ruleKey: string; label: string; deduction: number; reason: string };
export type Confidence = { score: number; band: "high" | "medium" | "low"; deductions: ConfidenceDeduction[]; note: string };

export const scoreConfidence = (rules: ConfidenceRule[], context: ConfidenceContext): Confidence => {
  const deductions = rules
    .filter((rule) => CONFIDENCE_CHECKS[rule.ruleKey]?.(context) === true)
    .map((rule) => ({ ruleKey: rule.ruleKey, label: rule.label, deduction: rule.deduction, reason: rule.reason }))
    .sort((a, b) => b.deduction - a.deduction || (a.ruleKey < b.ruleKey ? -1 : a.ruleKey > b.ruleKey ? 1 : 0));
  const score = Math.max(0, Math.min(100, 100 - deductions.reduce((total, item) => total + item.deduction, 0)));
  const band = score >= 85 ? "high" : score >= 65 ? "medium" : "low";
  const missing = deductions.map((item) => item.label).join("; ");
  const note = band === "low"
    ? `Indicative range only - too many inputs are unknown to defend these figures. Confirm before quoting: ${missing || "the event scope"}.`
    : band === "medium"
      ? `Usable planning range. Confirm to tighten it: ${missing || "no outstanding inputs"}.`
      : "All pricing-critical inputs are stated; the range reflects the approved corpus.";
  return { score, band, deductions, note };
};
