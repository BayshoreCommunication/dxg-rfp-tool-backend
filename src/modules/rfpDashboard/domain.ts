// ORG-401: the dashboard's RFP list and summary (PRD P0-8). Both read the same scoped, filtered
// set of RFPs: the summary is defined as an aggregate of the list, and `summarize` is that
// definition, which the repository's aggregation must match.
import { LIFECYCLE_STAGES, type LifecycleStage } from "../proposalLifecycle/domain";

export class RfpDashboardError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "RfpDashboardError";
  }
}

export type DashboardFilters = {
  // Empty means every stage except archived.
  stages: LifecycleStage[];
  ownerUserId?: string;
  teamId?: string;
  // Inclusive bounds on the event's start date, as YYYY-MM-DD.
  eventFrom?: string;
  eventTo?: string;
  // Matched case-insensitively against the whole city name.
  venueCity?: string;
  search?: string;
};

export const SORT_FIELDS = ["updatedAt", "createdAt", "eventStartDate", "eventName"] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export type ListRequest = DashboardFilters & { page: number; limit: number; sortBy: SortField; sortOrder: "asc" | "desc" };

export const ACTIVE_STAGES: readonly LifecycleStage[] = ["sent", "receiving_responses", "under_review"];

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const text = (value: unknown): string | undefined => {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const validDate = (value: string) => {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const invalid = (message: string) => new RfpDashboardError("DASHBOARD_FILTER_INVALID", message);

export const parseFilters = (query: Record<string, unknown>): DashboardFilters => {
  const rawStages = text(query.stage);
  const stages = rawStages ? [...new Set(rawStages.split(",").map((stage) => stage.trim()).filter(Boolean))] : [];
  const unknown = stages.filter((stage) => !(LIFECYCLE_STAGES as readonly string[]).includes(stage));
  if (unknown.length > 0) throw invalid(`Unknown stage: ${unknown.join(", ")}. Use ${LIFECYCLE_STAGES.join(", ")}.`);

  const ownerUserId = text(query.owner);
  if (ownerUserId && !OBJECT_ID.test(ownerUserId)) throw invalid("owner must be a user id");
  const teamId = text(query.team);
  if (teamId && !OBJECT_ID.test(teamId)) throw invalid("team must be a team id");

  const eventFrom = text(query.eventFrom);
  const eventTo = text(query.eventTo);
  for (const [name, value] of [["eventFrom", eventFrom], ["eventTo", eventTo]] as const) {
    if (value && !validDate(value)) throw invalid(`${name} must be a date as YYYY-MM-DD`);
  }
  if (eventFrom && eventTo && eventFrom > eventTo) throw invalid("eventFrom must not be after eventTo");

  const venueCity = text(query.venueCity);
  const search = text(query.search);
  for (const [name, value] of [["venueCity", venueCity], ["search", search]] as const) {
    if (value && value.length > 120) throw invalid(`${name} is too long`);
  }

  return {
    stages: stages as LifecycleStage[],
    ...(ownerUserId ? { ownerUserId } : {}),
    ...(teamId ? { teamId } : {}),
    ...(eventFrom ? { eventFrom } : {}),
    ...(eventTo ? { eventTo } : {}),
    ...(venueCity ? { venueCity } : {}),
    ...(search ? { search } : {}),
  };
};

const positiveInteger = (value: unknown, fallback: number) => {
  const parsed = Number.parseInt(text(value) ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const parseListRequest = (query: Record<string, unknown>): ListRequest => {
  const sortBy = text(query.sortBy) ?? "updatedAt";
  if (!(SORT_FIELDS as readonly string[]).includes(sortBy)) throw invalid(`sortBy must be one of ${SORT_FIELDS.join(", ")}`);
  return {
    ...parseFilters(query),
    page: Math.min(10_000, positiveInteger(query.page, 1)),
    limit: Math.min(100, positiveInteger(query.limit, 25)),
    sortBy: sortBy as SortField,
    sortOrder: text(query.sortOrder) === "asc" ? "asc" : "desc",
  };
};

// The calendar quarter containing `now`, in the organization's time zone, as UTC instants
// [start, end).
export type Quarter = { label: string; start: Date; end: Date; timeZone: string };

const zonedParts = (instant: Date, timeZone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  return parts;
};

// How far the zone's wall clock is ahead of UTC at `instant`, in milliseconds.
const offsetAt = (instant: Date, timeZone: string) => {
  const p = zonedParts(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant.getTime() / 1000) * 1000;
};

// The instant of local midnight on the first of a month in the zone.
const zonedMonthStart = (year: number, month: number, timeZone: string) => {
  const wall = Date.UTC(year, month - 1, 1);
  let guess = wall - offsetAt(new Date(wall), timeZone);
  // A DST change between the guess and the target moves the offset once; settle on it.
  guess = wall - offsetAt(new Date(guess), timeZone);
  return new Date(guess);
};

const usableZone = (timeZone: string | null | undefined) => {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
};

export const quarterOf = (now: Date, timeZone?: string | null): Quarter => {
  const zone = usableZone(timeZone);
  const { year, month } = zonedParts(now, zone);
  const quarter = Math.floor((month - 1) / 3);
  const startMonth = quarter * 3 + 1;
  const end = startMonth + 3 > 12 ? zonedMonthStart(year + 1, 1, zone) : zonedMonthStart(year, startMonth + 3, zone);
  return { label: `${year}-Q${quarter + 1}`, start: zonedMonthStart(year, startMonth, zone), end, timeZone: zone };
};

export type DashboardItemFacts = {
  stage: LifecycleStage;
  vendorsResponded: number;
  awardedAt: Date | string | null;
};

export type DashboardSummary = {
  total: number;
  activeRfps: number;
  responsesReceived: number;
  awardedThisQuarter: number;
  byStage: Record<LifecycleStage, number>;
};

export const emptyByStage = (): Record<LifecycleStage, number> =>
  Object.fromEntries(LIFECYCLE_STAGES.map((stage) => [stage, 0])) as Record<LifecycleStage, number>;

// The definition of the summary over a list of RFPs.
export const summarize = (items: DashboardItemFacts[], quarter: Pick<Quarter, "start" | "end">): DashboardSummary => {
  const summary: DashboardSummary = { total: 0, activeRfps: 0, responsesReceived: 0, awardedThisQuarter: 0, byStage: emptyByStage() };
  for (const item of items) {
    summary.total += 1;
    summary.byStage[item.stage] += 1;
    if (ACTIVE_STAGES.includes(item.stage)) summary.activeRfps += 1;
    summary.responsesReceived += item.vendorsResponded;
    const awardedAt = item.awardedAt ? new Date(item.awardedAt) : null;
    if (item.stage === "awarded" && awardedAt && awardedAt >= quarter.start && awardedAt < quarter.end) summary.awardedThisQuarter += 1;
  }
  return summary;
};
