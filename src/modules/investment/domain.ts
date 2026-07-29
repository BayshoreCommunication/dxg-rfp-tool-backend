import { aiRuntimeAuthorized } from "../../../config/aiEnvironment";
import {
  appliedStackChoice, BASELINE_IN_HOUSE_KEY, BASELINE_UNION_KEY, findModifier, matchMarket, multiDayFactor,
  scoreConfidence, SERVICE_CHARGE_KEY, TYPICAL_IN_HOUSE_KEY, unionConditionKey,
  type AppliedFactor, type Confidence, type ConfidenceRule, type MarketMatch, type PricingModifier,
  type RegionalFactor, type StackChoice,
} from "./factors";
import { evaluateCondition, readFacts, type ProposalFacts, type UnknownRecord } from "./proposalAccess";
import { deriveDrivers, PACKAGE_TEMPLATES, type Component, type Drivers, type PackageTemplate } from "./templates";
import {
  buildBudgetAnalysis,
  type BudgetAnalysis,
} from "./budgetAnalysis";

export { evaluateCondition } from "./proposalAccess";
export type { AppliedFactor, Confidence, ConfidenceRule, PricingModifier, RegionalFactor } from "./factors";

export class InvestmentError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}

export const investmentEnabled = () => aiRuntimeAuthorized() && process.env.INVESTMENT_GUIDANCE_ENABLED === "true";

export type PricingRecord = {
  id: string; category: string; itemLabel: string; unit: string;
  amountLowMinor: number; amountMidMinor: number; amountHighMinor: number;
  currency: string; market: string | null; dayType: string; laborRole: string | null;
  subcategory?: string | null; spec?: string | null; unitLabel?: string | null;
  quantityDimension?: string | null; calibrationTier?: string | null;
  revision?: number;
};
export type ExpertRule = {
  id: string; ruleKey: string; title: string; explanation: string;
  conditions: Array<{ path: string; op: string; value?: unknown }>;
  effect: { kind: string; category?: string | null; guidanceText?: string; factorPercent?: number };
  revision?: number;
};
export type LineItem = {
  category: string; label: string; currency: string;
  lowMinor: number; midMinor: number; highMinor: number;
  templateKey: string; componentKey: string; kind: "equipment" | "labor";
  quantity: number; unitLabel: string | null; implied: boolean;
  appliedFactors: AppliedFactor[];
  provenance: { pricingRecordIds: string[]; ruleIds: string[]; drivers: Record<string, number> };
};
export type Refusal = { category: string; reason: string; ask: string };
export type AncillaryFactor = { factor: string; status: "estimated" | "venue_dependent" | "no_data"; note: string; lowMinor?: number; midMinor?: number; highMinor?: number };
export type Assumption = { key: string; label: string; note: string };
export type Scenario = { key: string; label: string; lowMinor: number; midMinor: number; highMinor: number; basis: string };
export type PricingBasis = {
  market: string | null; regionalFactor: number;
  unionKey: string; unionFactor: number;
  inHouseKey: string; inHouseFactor: number;
  serviceChargeFactor: number; multiDayFactor: number;
  days: number; showDayEquipmentBasis: string;
};
export type InvestmentResult = {
  currency: string | null;
  totalLowMinor: number | null; totalMidMinor: number | null; totalHighMinor: number | null;
  lineItems: LineItem[]; refusals: Refusal[]; ancillary: AncillaryFactor[];
  recommendations: Array<{ ruleKey: string; title: string; guidanceText: string; explanation: string }>;
  confidence: Confidence; assumptions: Assumption[]; scenarios: Scenario[]; basis: PricingBasis;
  budgetAnalysis: BudgetAnalysis;
};

const TIERS = ["low", "mid", "high"] as const;
type Tier = (typeof TIERS)[number];
const amountAt = (record: PricingRecord, tier: Tier) =>
  tier === "low" ? record.amountLowMinor : tier === "mid" ? record.amountMidMinor : record.amountHighMinor;
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const FACTOR_SCALE = 1_000_000;
const scaledMinor = (
  baseMinor: number,
  quantity: number,
  factors: number[],
): number => {
  let numerator = BigInt(baseMinor) * BigInt(quantity);
  let denominator = 1n;
  for (const factor of factors) {
    const scaled = Math.round(factor * FACTOR_SCALE);
    if (!Number.isSafeInteger(scaled) || scaled < 0)
      throw new InvestmentError(
        "INVALID_PRICING_FACTOR",
        "An approved pricing factor is outside the supported range.",
      );
    numerator *= BigInt(scaled);
    denominator *= BigInt(FACTOR_SCALE);
  }
  const rounded = (numerator + denominator / 2n) / denominator;
  const output = Number(rounded);
  if (!Number.isSafeInteger(output))
    throw new InvestmentError(
      "PRICING_RANGE_EXCEEDED",
      "The calculated amount exceeds the supported currency range.",
    );
  return output;
};

const ANCILLARY_FACTORS: Array<{ factor: string; category: string; venueDependent: boolean; note: string }> = [
  { factor: "Trucking & freight", category: "trucking_freight", venueDependent: false, note: "Includes delivery planning; depends on vendor location, equipment volume, delivery windows, and venue access." },
  { factor: "Crew travel & per diem", category: "travel_per_diem", venueDependent: false, note: "Includes accommodation planning; depends on crew origin, lodging nights, travel policy, and event duration." },
  { factor: "Venue fees & exclusivity", category: "venue_fee", venueDependent: true, note: "Ask the venue for AV exclusivity, patch and facility fees." },
  { factor: "Rigging fees", category: "rigging", venueDependent: true, note: "Ask the venue for rigging rates and required house riggers." },
  { factor: "Power charges", category: "power", venueDependent: true, note: "Ask the venue for power drop rates and available amperage." },
  { factor: "Insurance", category: "insurance", venueDependent: false, note: "Confirm COI requirements and coverage limits." },
  { factor: "Service charges & taxes", category: "service_charge_tax", venueDependent: true, note: "Ask the venue and vendors for service charge and tax percentages." },
  { factor: "Contingency", category: "contingency", venueDependent: false, note: "No contingency is included unless an approved contingency rule or rate is loaded." },
];

// A component resolves to the median-priced approved record for each tier, so a
// range reflects the middle of the market rather than the sum of a catalog.
type Selection = { template: PackageTemplate; component: Component; quantity: number; picks: Record<Tier, PricingRecord> };

const candidatesFor = (records: PricingRecord[], component: Component): PricingRecord[] => {
  const matching = records.filter((record) => {
    if (record.category !== component.category) return false;
    const subcategory = record.subcategory ?? "";
    if (component.subcategory instanceof RegExp ? !component.subcategory.test(subcategory) : subcategory !== component.subcategory) return false;
    if (component.dimension && (record.quantityDimension ?? "") !== component.dimension) return false;
    return true;
  });
  if (!component.labelHint) return matching;
  const preferred = matching.filter((record) => component.labelHint!.test(`${record.itemLabel} ${record.spec ?? ""}`));
  return preferred.length ? preferred : matching;
};

const medianRecord = (candidates: PricingRecord[], tier: Tier): PricingRecord => {
  const sorted = [...candidates].sort((a, b) =>
    amountAt(a, tier) - amountAt(b, tier) || byText(a.itemLabel, b.itemLabel) || byText(a.id, b.id));
  return sorted[Math.floor((sorted.length - 1) / 2)];
};

const selectComponent = (records: PricingRecord[], component: Component): Record<Tier, PricingRecord> | null => {
  const candidates = candidatesFor(records, component);
  if (!candidates.length) return null;
  return { low: medianRecord(candidates, "low"), mid: medianRecord(candidates, "mid"), high: medianRecord(candidates, "high") };
};

type StackContext = {
  market: MarketMatch;
  modifiers: PricingModifier[];
  multiDay: { factor: number; source: PricingModifier | null; rehearsalSource: PricingModifier | null };
  laborRules: { overtime: number; doubleTime: number };
  drivers: Drivers;
  currency: string;
};

const laborDayFactor = (
  hours: number,
  union: boolean,
  rules: { overtime: number; doubleTime: number },
) => {
  if (hours <= 0) return 1;
  const overtimeStarts = union ? 8 : 10;
  const doubleTimeStarts = 12;
  const straightHours = Math.min(hours, overtimeStarts);
  const overtimeHours = Math.max(Math.min(hours, doubleTimeStarts) - overtimeStarts, 0);
  const doubleTimeHours = Math.max(hours - doubleTimeStarts, 0);
  return (
    straightHours +
    overtimeHours * rules.overtime +
    doubleTimeHours * rules.doubleTime
  ) / hours;
};

// Order matters and mirrors the workbook: base rate x regional x union x
// in-house x multi-day, then the subtotal-scope service charge compounds.
const buildLine = (selection: Selection, context: StackContext, stack: StackChoice): LineItem => {
  const { component, template, quantity, picks } = selection;
  const union = findModifier(context.modifiers, "union", stack.unionKey);
  const inHouse = findModifier(context.modifiers, "in_house", stack.inHouseKey);
  const serviceCharge = stack.serviceCharge ? findModifier(context.modifiers, "service_charge", SERVICE_CHARGE_KEY) : null;
  const isEquipment = component.kind === "equipment";
  const heldByDay = /^(per_day|per_room)$/.test(picks.mid.unit);

  const factors: AppliedFactor[] = [{
    kind: "regional",
    label: context.market.market ? `Regional factor - ${context.market.market}` : "Regional factor - national baseline (market not matched)",
    factor: context.market.factor,
  }];
  if (
    isEquipment &&
    heldByDay &&
    context.multiDay.factor !== 1 &&
    (context.multiDay.source || context.multiDay.rehearsalSource)
  ) {
    factors.push({
      kind: "multi_day",
      label:
        context.multiDay.source && context.multiDay.rehearsalSource
          ? `${context.multiDay.source.label} plus ${context.multiDay.rehearsalSource.label}`
          : `${(context.multiDay.source ?? context.multiDay.rehearsalSource)!.label}`,
      factor: context.multiDay.factor,
    });
  }
  if (!isEquipment && component.hoursPerPersonPerDay) {
    const hours = component.hoursPerPersonPerDay(context.drivers);
    const factor = laborDayFactor(
      hours,
      stack.unionKey !== BASELINE_UNION_KEY,
      context.laborRules,
    );
    if (factor !== 1) {
      factors.push({
        kind: "overtime",
        label: `Overtime and double-time rules across a ${hours}-hour call`,
        factor,
      });
    }
  }
  if (!isEquipment && !component.unionExempt && union && union.factor !== 1) {
    factors.push({ kind: "union", label: union.label, factor: union.factor });
  }
  if (isEquipment && !component.inHouseExempt && inHouse && inHouse.factor !== 1) {
    factors.push({ kind: "in_house", label: inHouse.label, factor: inHouse.factor });
  }
  if (serviceCharge) {
    factors.push({ kind: "service_charge", label: serviceCharge.label, factor: serviceCharge.factor });
  }

  const ids = [...new Set(TIERS.map((tier) => picks[tier].id))];
  return {
    category: component.category,
    label: `${template.label} - ${component.label}`,
    currency: context.currency,
    lowMinor: scaledMinor(
      amountAt(picks.low, "low"),
      quantity,
      factors.map((factor) => factor.factor),
    ),
    midMinor: scaledMinor(
      amountAt(picks.mid, "mid"),
      quantity,
      factors.map((factor) => factor.factor),
    ),
    highMinor: scaledMinor(
      amountAt(picks.high, "high"),
      quantity,
      factors.map((factor) => factor.factor),
    ),
    templateKey: template.key,
    componentKey: component.key,
    kind: component.kind,
    quantity,
    unitLabel: picks.mid.unitLabel ?? null,
    implied: component.implied === true,
    appliedFactors: factors,
    provenance: { pricingRecordIds: ids, ruleIds: [], drivers: { [component.driver]: quantity, days: context.drivers.days } },
  };
};

const applyCostFactorRules = (lines: LineItem[], matchedRules: ExpertRule[]) => {
  for (const rule of matchedRules) {
    if (rule.effect?.kind !== "cost_factor" || typeof rule.effect.factorPercent !== "number") continue;
    const factor = 1 + rule.effect.factorPercent / 100;
    for (const line of lines) {
      if (rule.effect.category && line.category !== rule.effect.category) continue;
      line.lowMinor = scaledMinor(line.lowMinor, 1, [factor]);
      line.midMinor = scaledMinor(line.midMinor, 1, [factor]);
      line.highMinor = scaledMinor(line.highMinor, 1, [factor]);
      line.provenance.ruleIds.push(rule.id);
      line.appliedFactors.push({ kind: "expert_rule", label: rule.title, factor });
    }
  }
  return lines;
};

const priceStack = (selections: Selection[], context: StackContext, stack: StackChoice, matchedRules: ExpertRule[]) =>
  applyCostFactorRules(selections.map((selection) => buildLine(selection, context, stack)), matchedRules);

const sumTier = (lines: LineItem[], tier: Tier) => {
  const total = lines.reduce(
    (value, line) =>
      value +
      BigInt(
        tier === "low"
          ? line.lowMinor
          : tier === "mid"
            ? line.midMinor
            : line.highMinor,
      ),
    0n,
  );
  const output = Number(total);
  if (!Number.isSafeInteger(output))
    throw new InvestmentError(
      "PRICING_RANGE_EXCEEDED",
      "The calculated subtotal exceeds the supported currency range.",
    );
  return output;
};

const quantityFor = (unit: string, facts: ProposalFacts): { quantity: number; driver: string } | null => {
  if (unit === "per_day") return { quantity: facts.days, driver: "days" };
  if (unit === "per_room") return { quantity: Math.max(facts.declaredRoomCount ?? facts.rooms.length, 1), driver: "rooms" };
  if (unit === "per_event" || unit === "flat") return { quantity: 1, driver: "event" };
  return null; // per_person / per_hour need data the ancillary view cannot support
};

// Deterministic range engine (SOW WS3 / DXG AV Pricing Engine): every number
// traces to approved pricing records, regional factors and modifiers; anything
// the corpus cannot support is refused explicitly rather than estimated.
// No model calls.
export const computeInvestmentGuidance = (
  proposal: UnknownRecord,
  records: PricingRecord[],
  rules: ExpertRule[],
  regionalFactors: RegionalFactor[] = [],
  modifiers: PricingModifier[] = [],
  confidenceRules: ConfidenceRule[] = [],
): InvestmentResult => {
  const facts = readFacts(proposal);
  const matchedRules = rules.filter((rule) => (rule.conditions ?? []).every((condition) => evaluateCondition(proposal, condition)));
  const { drivers, assumptions: driverAssumptions } = deriveDrivers(facts);

  const currencyVotes = new Map<string, number>();
  for (const record of records) currencyVotes.set(record.currency, (currencyVotes.get(record.currency) ?? 0) + 1);
  const currency = [...currencyVotes.entries()].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))[0]?.[0] ?? null;
  const usable = records.filter((record) => record.currency === currency);

  const market = matchMarket(facts, regionalFactors);
  const stack = appliedStackChoice(facts, market);
  const multiplierRate = (pattern: RegExp, fallback: number) => {
    const record = usable.find(
      (candidate) =>
        candidate.category === "labor" &&
        candidate.unit === "multiplier" &&
        pattern.test(candidate.itemLabel),
    );
    return record ? record.amountMidMinor / 100 : fallback;
  };
  const context: StackContext = {
    market,
    modifiers,
    multiDay: multiDayFactor(facts.days, modifiers, facts.rehearsalDays),
    laborRules: {
      overtime: multiplierRate(/^Overtime/i, 1.5),
      doubleTime: multiplierRate(/^Double Time/i, 2),
    },
    drivers,
    currency: currency ?? "",
  };

  const activeTemplates = PACKAGE_TEMPLATES.filter((template) => template.applies(facts, drivers));
  const selections: Selection[] = [];
  const refusals: Refusal[] = [];
  for (const template of activeTemplates) {
    const components = template.components.filter((component) => component.applies?.(facts, drivers) !== false);
    const resolved: Selection[] = [];
    const gaps: Component[] = [];
    for (const component of components) {
      const quantity = Math.round(component.quantity(drivers));
      const picks = currency ? selectComponent(usable, component) : null;
      if (!picks || quantity <= 0) { gaps.push(component); continue; }
      resolved.push({ template, component, quantity, picks });
    }
    if (!resolved.length) {
      refusals.push({
        category: template.category,
        reason: `No approved pricing data supports a defensible range for ${template.label.toLowerCase()}.`,
        ask: `Load approved pricing for ${template.label.toLowerCase()} (${components.map((component) => component.label.toLowerCase()).join(", ")}), or request line-item pricing from vendors.`,
      });
      continue;
    }
    selections.push(...resolved);
    for (const component of gaps)
      refusals.push({
        category: component.category,
        reason: `No approved pricing data covers ${component.label.toLowerCase()} for ${template.label.toLowerCase()}, so it is excluded from the range.`,
        ask: `Load an approved ${component.category}/${String(component.subcategory)} record, or ask the vendor to quote ${component.label.toLowerCase()} separately.`,
      });
  }

  const lineItems = priceStack(selections, context, stack, matchedRules);
  const unionSource = findModifier(modifiers, "union", stack.unionKey);
  const inHouseSource = findModifier(modifiers, "in_house", stack.inHouseKey);
  const serviceChargeSource = findModifier(modifiers, "service_charge", SERVICE_CHARGE_KEY);

  const scenarioStacks: Array<{ key: string; label: string; basis: string; stack: StackChoice }> = [
    {
      key: "base", label: "Base - non-union, outside AV",
      basis: "Approved base rates with the regional factor only: independent AV vendor in a non-union house.",
      stack: { unionKey: BASELINE_UNION_KEY, inHouseKey: BASELINE_IN_HOUSE_KEY, serviceCharge: false },
    },
    {
      key: "union", label: `Union labor - ${market.market || "national baseline"}`,
      basis: "Labor carries the union modifier for this market (minimum calls, meal penalties, benefits); equipment is unchanged.",
      stack: { unionKey: unionConditionKey(market), inHouseKey: BASELINE_IN_HOUSE_KEY, serviceCharge: false },
    },
    {
      key: "in_house", label: "Venue / hotel in-house AV",
      basis: "Equipment carries the in-house markup and the service charge compounds on the marked-up subtotal; interpretation, captioning, connectivity and management lines are excluded from the markup.",
      stack: { unionKey: BASELINE_UNION_KEY, inHouseKey: TYPICAL_IN_HOUSE_KEY, serviceCharge: true },
    },
  ];
  const scenarios: Scenario[] = selections.length
    ? scenarioStacks.map((scenario) => {
      const lines = priceStack(selections, context, scenario.stack, matchedRules);
      return {
        key: scenario.key, label: scenario.label, basis: scenario.basis,
        lowMinor: sumTier(lines, "low"), midMinor: sumTier(lines, "mid"), highMinor: sumTier(lines, "high"),
      };
    })
    : [];

  const contributing = selections.flatMap((selection) => TIERS.map((tier) => selection.picks[tier]));
  const baselineOnly = contributing.length > 0 && contributing.every((record) => (record.calibrationTier ?? "baseline") === "baseline");
  const confidence = scoreConfidence(confidenceRules, {
    facts, marketMatched: market.source !== null, baselineOnly,
    pricedKeys: selections.map((selection) => selection.component.key),
    hasLines: lineItems.length > 0,
  });

  const pricedTemplates = new Set(selections.map((selection) => selection.template.key));
  const assumptions: Assumption[] = [
    ...driverAssumptions
      .filter((assumption) => pricedTemplates.has(assumption.templateKey))
      .map(({ key, label, note }) => ({ key, label, note })),
    ...selections
      .filter((selection) => selection.component.implied)
      .map((selection) => ({
        key: `implied_${selection.component.key}`,
        label: `${selection.component.label} assumed included`,
        note: `${selection.template.label} pricing includes ${selection.component.label.toLowerCase()} because the rest of the package requires it - assumed included, confirm with the client.`,
      })),
  ];
  if (baselineOnly)
    assumptions.push({
      key: "baseline_calibration_only",
      label: "Baseline national figures",
      note: "Every contributing rate is a baseline national figure, not a calibrated DXG actual. Treat the range as a market reference until the corpus is calibrated.",
    });

  const lineCategories = new Set(lineItems.map((line) => line.category));
  const ancillary: AncillaryFactor[] = ANCILLARY_FACTORS
    .filter((item) => !lineCategories.has(item.category))
    .map((item) => {
      let low = 0, mid = 0, high = 0, priced = false;
      for (const record of usable.filter((candidate) => candidate.category === item.category)) {
        const scaled = quantityFor(record.unit, facts);
        if (!scaled) continue;
        priced = true;
        low += scaledMinor(record.amountLowMinor, scaled.quantity, []);
        mid += scaledMinor(record.amountMidMinor, scaled.quantity, []);
        high += scaledMinor(record.amountHighMinor, scaled.quantity, []);
      }
      if (priced) return { factor: item.factor, status: "estimated" as const, note: item.note, lowMinor: low, midMinor: mid, highMinor: high };
      return { factor: item.factor, status: item.venueDependent ? ("venue_dependent" as const) : ("no_data" as const), note: item.note };
    });
  if (facts.unionVenue === "yes")
    ancillary.push({ factor: "Union labor conditions", status: "venue_dependent", note: "This is a union venue: confirm labor rules, minimum calls and steward requirements - they materially change labor cost." });
  for (const rule of matchedRules) {
    if (rule.effect?.kind !== "ancillary_flag" || !rule.effect.guidanceText) continue;
    ancillary.push({ factor: rule.title, status: "venue_dependent", note: rule.effect.guidanceText });
  }

  const recommendations = matchedRules
    .filter((rule) => rule.effect?.kind === "recommendation" && rule.effect.guidanceText)
    .map((rule) => ({ ruleKey: rule.ruleKey, title: rule.title, guidanceText: rule.effect.guidanceText!, explanation: rule.explanation }));

  const hasLines = lineItems.length > 0;
  const resultWithoutAnalysis = {
    currency: hasLines ? currency : null,
    totalLowMinor: hasLines ? sumTier(lineItems, "low") : null,
    totalMidMinor: hasLines ? sumTier(lineItems, "mid") : null,
    totalHighMinor: hasLines ? sumTier(lineItems, "high") : null,
    lineItems, refusals, ancillary, recommendations, confidence, assumptions, scenarios,
    basis: {
      market: market.source ? market.market : null,
      regionalFactor: market.factor,
      unionKey: stack.unionKey,
      unionFactor: unionSource?.factor ?? 1,
      inHouseKey: stack.inHouseKey,
      inHouseFactor: inHouseSource?.factor ?? 1,
      serviceChargeFactor: stack.serviceCharge ? serviceChargeSource?.factor ?? 1 : 1,
      multiDayFactor: context.multiDay.factor,
      days: facts.days,
      showDayEquipmentBasis:
        `Day 1 at full rate; each additional show day uses the approved hold-over factor` +
        (facts.rehearsalDays > 0
          ? `, plus ${facts.rehearsalDays} rehearsal/dark day${facts.rehearsalDays === 1 ? "" : "s"} at the approved hold rate`
          : "") +
        ` (${facts.days} show days).`,
    },
  };
  return {
    ...resultWithoutAnalysis,
    budgetAnalysis: buildBudgetAnalysis({
      proposal,
      currency: resultWithoutAnalysis.currency,
      totalLowMinor: resultWithoutAnalysis.totalLowMinor,
      totalMidMinor: resultWithoutAnalysis.totalMidMinor,
      totalHighMinor: resultWithoutAnalysis.totalHighMinor,
      lineItems,
      refusals,
      ancillary,
      assumptions,
      recommendations,
      pricingRecords: records,
      rules,
      regionalFactors,
      modifiers,
      confidenceRules,
    }),
  };
};
