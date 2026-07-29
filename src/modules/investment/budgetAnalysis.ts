import { createHash } from "node:crypto";
import { computeRoomScheduleAnalysis } from "../guidance/roomScheduleAnalysis";
import { computeScopeGuidance } from "../guidance/scopeRules";
import type {
  AncillaryFactor,
  Assumption,
  ExpertRule,
  LineItem,
  PricingRecord,
  Refusal,
} from "./domain";
import {
  filled,
  text,
  type UnknownRecord,
} from "./proposalAccess";
import type {
  ConfidenceRule,
  PricingModifier,
  RegionalFactor,
} from "./factors";

export const BUDGET_CALCULATION_VERSION = "deterministic-budget.v1";

export type MoneyRange = {
  currency: string;
  lowMinor: number;
  midMinor: number;
  highMinor: number;
};

export type BudgetWarning = {
  code: string;
  severity: "blocking" | "warning" | "info";
  explanation: string;
  suggestedNextAction: string;
  paths: string[];
  estimatedImpact: MoneyRange | null;
};

export type BudgetAnalysis = {
  calculationVersion: typeof BUDGET_CALCULATION_VERSION;
  pricingReleaseVersion: string;
  ruleReleaseVersion: string;
  status: "exact_approved_value" | "estimate_range" | "incomplete";
  currency: string | null;
  included: Array<{ key: string; label: string; source: string }>;
  missing: Array<{ key: string; label: string; reason: string }>;
  needsConfirmation: Array<{ key: string; label: string; reason: string }>;
  optional: Array<{ key: string; label: string; reason: string }>;
  possibleSavings: Array<{
    key: string;
    label: string;
    reason: string;
    estimatedImpact: MoneyRange | null;
  }>;
  categoryBreakdown: Array<{
    category: string;
    amount: MoneyRange;
  }>;
  roomBreakdown: Array<{
    roomKey: string;
    roomLabel: string;
    status: "allocated_range" | "not_allocated";
    amount: MoneyRange | null;
    allocationBasis: string;
  }>;
  laborSubtotal: MoneyRange | null;
  equipmentSubtotal: MoneyRange | null;
  sharedServicesSubtotal: MoneyRange | null;
  estimatedAncillarySubtotal: MoneyRange | null;
  calculatedTotal: MoneyRange | null;
  completeTotal: MoneyRange | null;
  budgetCeiling: {
    amountMinor: number;
    currency: string;
    source: "explicit_amount" | "planning_band";
    label: string;
  } | null;
  warnings: BudgetWarning[];
};

type BuildInput = {
  proposal: UnknownRecord;
  currency: string | null;
  totalLowMinor: number | null;
  totalMidMinor: number | null;
  totalHighMinor: number | null;
  lineItems: LineItem[];
  refusals: Refusal[];
  ancillary: AncillaryFactor[];
  assumptions: Assumption[];
  recommendations: Array<{
    ruleKey: string;
    title: string;
    guidanceText: string;
  }>;
  pricingRecords: PricingRecord[];
  rules: ExpertRule[];
  regionalFactors: RegionalFactor[];
  modifiers: PricingModifier[];
  confidenceRules: ConfidenceRule[];
};

const record = (value: unknown): UnknownRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
const integer = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number(text(value));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};
const shortHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
const byId = <T extends { id: string }>(items: T[]): T[] =>
  [...items].sort((left, right) => left.id.localeCompare(right.id));
const releaseVersions = (input: BuildInput) => ({
  pricingReleaseVersion: `approved-pricing.v1:${shortHash(
    byId(input.pricingRecords).map((item) => [
      item.id,
      item.revision ?? 1,
      item.amountLowMinor,
      item.amountMidMinor,
      item.amountHighMinor,
      item.currency,
    ]),
  )}`,
  ruleReleaseVersion: `approved-rules.v1:${shortHash({
    rules: byId(input.rules).map((item) => [
      item.id,
      item.revision ?? 1,
      item.conditions,
      item.effect,
    ]),
    regional: byId(input.regionalFactors).map((item) => [
      item.id,
      item.market,
      item.factor,
    ]),
    modifiers: byId(input.modifiers).map((item) => [
      item.id,
      item.kind,
      item.conditionKey,
      item.factor,
    ]),
    confidence: byId(input.confidenceRules).map((item) => [
      item.id,
      item.ruleKey,
      item.deduction,
    ]),
  })}`,
});
const sum = (items: number[]): number => {
  const total = items.reduce((value, item) => value + BigInt(item), 0n);
  const output = Number(total);
  if (!Number.isSafeInteger(output))
    throw new Error("Budget subtotal exceeds the supported integer range.");
  return output;
};
const range = (
  lines: Array<Pick<LineItem, "lowMinor" | "midMinor" | "highMinor">>,
  currency: string | null,
): MoneyRange | null =>
  currency && lines.length
    ? {
        currency,
        lowMinor: sum(lines.map((line) => line.lowMinor)),
        midMinor: sum(lines.map((line) => line.midMinor)),
        highMinor: sum(lines.map((line) => line.highMinor)),
      }
    : null;
const addRange = (
  base: MoneyRange | null,
  extra: MoneyRange | null,
): MoneyRange | null => {
  if (!base) return extra;
  if (!extra || extra.currency !== base.currency) return base;
  return {
    currency: base.currency,
    lowMinor: sum([base.lowMinor, extra.lowMinor]),
    midMinor: sum([base.midMinor, extra.midMinor]),
    highMinor: sum([base.highMinor, extra.highMinor]),
  };
};
const allocate = (total: number, count: number, index: number): number => {
  const base = Math.floor(total / count);
  return base + (index < total % count ? 1 : 0);
};

const BUDGET_BANDS: Record<string, { label: string; highMinor: number | null }> = {
  essential: { label: "Essential", highMinor: 2_500_000 },
  standard: { label: "Standard", highMinor: 5_000_000 },
  production: { label: "Production", highMinor: 10_000_000 },
  premium: { label: "Premium", highMinor: 25_000_000 },
  enterprise: { label: "Enterprise", highMinor: 50_000_000 },
  signature: { label: "Signature", highMinor: null },
};
const budgetCeiling = (
  proposal: UnknownRecord,
  estimateCurrency: string | null,
): BudgetAnalysis["budgetCeiling"] => {
  const budget = record(proposal.budget);
  const amountMinor = integer(budget.amountMinor);
  const explicitCurrency = text(budget.currency).toLocaleUpperCase("en-US");
  if (
    amountMinor !== null &&
    /^[A-Z]{3}$/.test(explicitCurrency)
  )
    return {
      amountMinor,
      currency: explicitCurrency,
      source: "explicit_amount",
      label: "Explicit planning ceiling",
    };
  const bandKey = text(budget.estimatedAvBudget)
    .toLocaleLowerCase("en-US")
    .split(/\s|·/)[0];
  const band = BUDGET_BANDS[bandKey];
  return band?.highMinor !== null && band?.highMinor !== undefined
    ? {
        amountMinor: band.highMinor,
        currency: estimateCurrency ?? "USD",
        source: "planning_band",
        label: `${band.label} planning band`,
      }
    : null;
};

const lineBreakdowns = (
  lines: LineItem[],
  currency: string | null,
): BudgetAnalysis["categoryBreakdown"] =>
  [...new Set(lines.map((line) => line.category))]
    .sort()
    .flatMap((category) => {
      const amount = range(
        lines.filter((line) => line.category === category),
        currency,
      );
      return amount ? [{ category, amount }] : [];
    });

const roomBreakdowns = (
  proposal: UnknownRecord,
  lines: LineItem[],
  currency: string | null,
): {
  rooms: BudgetAnalysis["roomBreakdown"];
  shared: MoneyRange | null;
} => {
  const roomAnalysis = computeRoomScheduleAnalysis(proposal);
  const generalPattern =
    /general session|plenary|main stage|keynote|main room|opening|closing/i;
  const generalRooms = roomAnalysis.rooms.filter((room) =>
    generalPattern.test(room.roomLabel),
  );
  const breakoutRooms = roomAnalysis.rooms.filter(
    (room) => !generalPattern.test(room.roomLabel),
  );
  const general = lines.filter((line) => line.templateKey === "GENERAL_SESSION");
  const breakout = lines.filter((line) => line.templateKey === "BREAKOUT_ROOM");
  const sharedLines = lines.filter(
    (line) =>
      line.templateKey !== "GENERAL_SESSION" &&
      line.templateKey !== "BREAKOUT_ROOM",
  );
  const generalRange = range(general, currency);
  const breakoutRange = range(breakout, currency);
  const allocation = (
    rooms: typeof roomAnalysis.rooms,
    subtotal: MoneyRange | null,
    basis: string,
  ): BudgetAnalysis["roomBreakdown"] =>
    rooms.map((room, index) => ({
      roomKey: room.roomKey,
      roomLabel: room.roomLabel,
      status: subtotal ? "allocated_range" : "not_allocated",
      amount: subtotal
        ? {
            currency: subtotal.currency,
            lowMinor: allocate(subtotal.lowMinor, rooms.length, index),
            midMinor: allocate(subtotal.midMinor, rooms.length, index),
            highMinor: allocate(subtotal.highMinor, rooms.length, index),
          }
        : null,
      allocationBasis: subtotal
        ? basis
        : "No approved room-package lines were available for this room group.",
    }));
  return {
    rooms: [
      ...allocation(
        generalRooms,
        generalRange,
        generalRooms.length === 1
          ? "Approved general-session package lines assigned to the identified general-session room."
          : "Approved general-session package range allocated evenly across matching rooms; validate room-specific scope.",
      ),
      ...allocation(
        breakoutRooms,
        breakoutRange,
        "Approved aggregate breakout-room package range allocated evenly; validate room-specific scope and quantities.",
      ),
    ],
    shared: range(sharedLines, currency),
  };
};

export const buildBudgetAnalysis = (input: BuildInput): BudgetAnalysis => {
  const versions = releaseVersions(input);
  const scope = computeScopeGuidance(input.proposal);
  const roomSchedule = computeRoomScheduleAnalysis(input.proposal);
  const ancillaryLines = input.ancillary.flatMap((item) =>
    item.status === "estimated" &&
    item.lowMinor !== undefined &&
    item.midMinor !== undefined &&
    item.highMinor !== undefined
      ? [{
          lowMinor: item.lowMinor,
          midMinor: item.midMinor,
          highMinor: item.highMinor,
        }]
      : [],
  );
  const estimatedAncillarySubtotal = range(ancillaryLines, input.currency);
  const calculatedTotal =
    input.currency &&
    input.totalLowMinor !== null &&
    input.totalMidMinor !== null &&
    input.totalHighMinor !== null
      ? {
          currency: input.currency,
          lowMinor: input.totalLowMinor,
          midMinor: input.totalMidMinor,
          highMinor: input.totalHighMinor,
        }
      : null;
  const missingAncillary = input.ancillary.filter(
    (item) => item.status !== "estimated",
  );
  const incomplete =
    input.refusals.length > 0 ||
    missingAncillary.length > 0 ||
    !calculatedTotal;
  const exact =
    !incomplete &&
    input.lineItems.every(
      (line) =>
        line.lowMinor === line.midMinor && line.midMinor === line.highMinor,
    ) &&
    ancillaryLines.every(
      (line) =>
        line.lowMinor === line.midMinor && line.midMinor === line.highMinor,
    );
  const ceiling = budgetCeiling(input.proposal, input.currency);
  const warnings: BudgetWarning[] = [];
  const addWarning = (warning: BudgetWarning) => warnings.push(warning);

  if (ceiling && calculatedTotal) {
    if (ceiling.currency !== calculatedTotal.currency) {
      addWarning({
        code: "BUDGET_CURRENCY_MISMATCH",
        severity: "warning",
        explanation: `The budget ceiling is ${ceiling.currency}, but approved pricing is ${calculatedTotal.currency}. They cannot be compared without an approved conversion rate.`,
        suggestedNextAction:
          "Align the proposal and pricing currencies or provide an approved exchange rate.",
        paths: ["/content/budget/currency"],
        estimatedImpact: null,
      });
    } else if (calculatedTotal.lowMinor > ceiling.amountMinor) {
      addWarning({
        code: "ESTIMATE_EXCEEDS_BUDGET_CEILING",
        severity: "blocking",
        explanation:
          "Even the low end of the approved estimate range exceeds the stated budget ceiling.",
        suggestedNextAction:
          "Review required scope, request value-engineering options, or revise the budget before sending.",
        paths: ["/content/budget/estimatedAvBudget"],
        estimatedImpact: {
          currency: calculatedTotal.currency,
          lowMinor: calculatedTotal.lowMinor - ceiling.amountMinor,
          midMinor: calculatedTotal.midMinor - ceiling.amountMinor,
          highMinor: calculatedTotal.highMinor - ceiling.amountMinor,
        },
      });
    } else if (calculatedTotal.highMinor > ceiling.amountMinor) {
      addWarning({
        code: "ESTIMATE_MAY_EXCEED_BUDGET_CEILING",
        severity: "warning",
        explanation:
          "The approved estimate range overlaps and may exceed the stated budget ceiling.",
        suggestedNextAction:
          "Confirm missing inputs and compare an approved value-engineered scenario.",
        paths: ["/content/budget/estimatedAvBudget"],
        estimatedImpact: {
          currency: calculatedTotal.currency,
          lowMinor: 0,
          midMinor: Math.max(
            0,
            calculatedTotal.midMinor - ceiling.amountMinor,
          ),
          highMinor: calculatedTotal.highMinor - ceiling.amountMinor,
        },
      });
    }
  }

  const zeroCategories = lineBreakdowns(input.lineItems, input.currency).filter(
    (item) => item.amount.highMinor === 0,
  );
  for (const category of zeroCategories)
    addWarning({
      code: "REQUIRED_CATEGORY_HAS_ZERO_BUDGET",
      severity: "warning",
      explanation: `${category.category} is included in required scope but its approved budget range is zero.`,
      suggestedNextAction:
        "Confirm whether the category is included elsewhere or replace the zero rate with an approved value.",
      paths: [],
      estimatedImpact: category.amount,
    });

  const hasEquipment = input.lineItems.some((line) => line.kind === "equipment");
  const hasLabor = input.lineItems.some((line) => line.kind === "labor");
  if (hasEquipment && !hasLabor)
    addWarning({
      code: "EQUIPMENT_WITHOUT_LABOR",
      severity: "warning",
      explanation:
        "Equipment is priced but no approved labor line is included for setup, operation, or strike.",
      suggestedNextAction:
        "Add approved labor roles and call hours or request vendor labor separately.",
      paths: ["/content/roomByRoom"],
      estimatedImpact: null,
    });

  const venueSchedule = record(input.proposal.venueSchedule);
  const rooms = Array.isArray(input.proposal.roomByRoom)
    ? input.proposal.roomByRoom.map(record)
    : [];
  const anyRoomValue = (key: string) => rooms.some((room) => filled(room[key]));
  const laborWindows = [
    {
      code: "SETUP_LABOR_WINDOW_MISSING",
      label: "load-in/setup",
      present:
        filled(venueSchedule.loadInDate) ||
        anyRoomValue("loadInDateTime"),
      paths: ["/content/venueSchedule/loadInDate"],
    },
    {
      code: "REHEARSAL_LABOR_WINDOW_MISSING",
      label: "rehearsal",
      present:
        filled(venueSchedule.rehearsalDate) ||
        anyRoomValue("rehearsalDateTime"),
      paths: ["/content/venueSchedule/rehearsalDate"],
    },
    {
      code: "STRIKE_LABOR_WINDOW_MISSING",
      label: "strike",
      present: filled(venueSchedule.strikeDate),
      paths: ["/content/venueSchedule/strikeDate"],
    },
  ];
  if (hasEquipment)
    for (const window of laborWindows.filter((item) => !item.present))
      addWarning({
        code: window.code,
        severity: "warning",
        explanation: `Equipment is scoped, but the ${window.label} labor window is not documented.`,
        suggestedNextAction:
          `Add the ${window.label} timing before relying on labor hours or totals.`,
        paths: window.paths,
        estimatedImpact: null,
      });

  const { rooms: roomBreakdown, shared: sharedServicesSubtotal } =
    roomBreakdowns(input.proposal, input.lineItems, input.currency);
  const equipmentSubtotal = range(
    input.lineItems.filter((line) => line.kind === "equipment"),
    input.currency,
  );
  const laborSubtotal = range(
    input.lineItems.filter((line) => line.kind === "labor"),
    input.currency,
  );
  const completeTotal = incomplete
    ? null
    : addRange(calculatedTotal, estimatedAncillarySubtotal);

  return {
    calculationVersion: BUDGET_CALCULATION_VERSION,
    ...versions,
    status: incomplete
      ? "incomplete"
      : exact
        ? "exact_approved_value"
        : "estimate_range",
    currency: input.currency,
    included: [
      ...input.lineItems.map((line) => ({
        key: line.componentKey,
        label: line.label,
        source: "approved_pricing_record",
      })),
      ...input.ancillary
        .filter((item) => item.status === "estimated")
        .map((item) => ({
          key: item.factor,
          label: item.factor,
          source: "approved_ancillary_rate",
        })),
    ],
    missing: [
      ...input.refusals.map((item) => ({
        key: item.category,
        label: item.category,
        reason: item.reason,
      })),
      ...input.ancillary
        .filter((item) => item.status === "no_data")
        .map((item) => ({
          key: item.factor,
          label: item.factor,
          reason: item.note,
        })),
    ],
    needsConfirmation: [
      ...input.ancillary
        .filter((item) => item.status === "venue_dependent")
        .map((item) => ({
          key: item.factor,
          label: item.factor,
          reason: item.note,
        })),
      ...input.assumptions.map((item) => ({
        key: item.key,
        label: item.label,
        reason: item.note,
      })),
      ...scope
        .filter(
          (item) =>
            item.category === "needs_confirmation" ||
            item.severity === "insufficient_information",
        )
        .map((item) => ({
          key: item.id,
          label: item.ruleId,
          reason: item.question ?? item.explanation,
        })),
    ],
    optional: [
      ...input.recommendations.map((item) => ({
        key: item.ruleKey,
        label: item.title,
        reason: item.guidanceText,
      })),
      ...scope
        .filter((item) => item.severity === "optional_optimization")
        .map((item) => ({
          key: item.id,
          label: item.ruleId,
          reason: item.explanation,
        })),
    ],
    possibleSavings: roomSchedule.findings
      .filter((item) => item.duplicateRentalReview)
      .map((item) => ({
        key: item.id,
        label: "Validate shared-equipment alternative",
        reason: item.explanation,
        estimatedImpact: null,
      })),
    categoryBreakdown: lineBreakdowns(input.lineItems, input.currency),
    roomBreakdown,
    laborSubtotal,
    equipmentSubtotal,
    sharedServicesSubtotal,
    estimatedAncillarySubtotal,
    calculatedTotal,
    completeTotal,
    budgetCeiling: ceiling,
    warnings,
  };
};
