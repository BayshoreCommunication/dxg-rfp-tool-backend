/* The organization details an Owner fills in during onboarding (ORG-301) and later in
   Settings. Mirrors the Organization model's own limits so a bad value is a 400 here,
   not a Mongoose validation error. */

export const ORGANIZATION_TYPES = ["corporate", "association", "agency", "venue", "government", "other"] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

// Paid plans join this list once DXG defines them.
export const ORGANIZATION_PLANS = ["free_trial"] as const;
export type OrganizationPlan = (typeof ORGANIZATION_PLANS)[number];

/* A new organization walks details → plan → team → done. Organizations created before
   onboarding existed default to "done". */
export const ONBOARDING_STEPS = ["details", "plan", "team", "done"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const ORGANIZATION_NAME_MAX_LENGTH = 200;
export const INDUSTRY_MAX_LENGTH = 120;
export const EVENTS_PER_YEAR_MAX = 100_000;

export interface OrganizationDetails {
  name: string;
  type: OrganizationType | null;
  industry: string | null;
  country: string | null;
  timeZone: string | null;
  eventsPerYear: number | null;
}

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();

/** Trimmed, inner whitespace collapsed; null when empty, too long or not a string. */
export const normalizeOrganizationName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const name = collapse(value);
  if (!name || name.length > ORGANIZATION_NAME_MAX_LENGTH) return null;
  return name;
};

const isIanaTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const blank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && !value.trim());

export type OrganizationDetailsUpdate = Pick<OrganizationDetails, "name"> & Partial<Omit<OrganizationDetails, "name">>;
type Parsed = { ok: true; details: OrganizationDetailsUpdate } | { ok: false; field: keyof OrganizationDetails };

/** Validates a details form. The name is required; any other field left out of the input is left
    unchanged, and "" or null clears it. */
export const parseOrganizationDetails = (input: Record<string, unknown>): Parsed => {
  const name = normalizeOrganizationName(input.name);
  if (!name) return { ok: false, field: "name" };
  const has = (key: keyof OrganizationDetails) => Object.prototype.hasOwnProperty.call(input, key);

  let type: OrganizationType | null = null;
  if (!blank(input.type)) {
    if (!ORGANIZATION_TYPES.includes(input.type as OrganizationType)) return { ok: false, field: "type" };
    type = input.type as OrganizationType;
  }

  let industry: string | null = null;
  if (!blank(input.industry)) {
    if (typeof input.industry !== "string") return { ok: false, field: "industry" };
    industry = collapse(input.industry);
    if (industry.length > INDUSTRY_MAX_LENGTH) return { ok: false, field: "industry" };
  }

  let country: string | null = null;
  if (!blank(input.country)) {
    if (typeof input.country !== "string") return { ok: false, field: "country" };
    country = input.country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) return { ok: false, field: "country" };
  }

  let timeZone: string | null = null;
  if (!blank(input.timeZone)) {
    if (typeof input.timeZone !== "string" || !isIanaTimeZone(input.timeZone.trim())) return { ok: false, field: "timeZone" };
    timeZone = input.timeZone.trim();
  }

  let eventsPerYear: number | null = null;
  if (!blank(input.eventsPerYear)) {
    const value = typeof input.eventsPerYear === "string" ? Number(input.eventsPerYear.trim()) : input.eventsPerYear;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > EVENTS_PER_YEAR_MAX) {
      return { ok: false, field: "eventsPerYear" };
    }
    eventsPerYear = value;
  }

  const details: OrganizationDetailsUpdate = { name };
  if (has("type")) details.type = type;
  if (has("industry")) details.industry = industry;
  if (has("country")) details.country = country;
  if (has("timeZone")) details.timeZone = timeZone;
  if (has("eventsPerYear")) details.eventsPerYear = eventsPerYear;
  return { ok: true, details };
};

export const isOnboardingStep = (value: unknown): value is OnboardingStep =>
  ONBOARDING_STEPS.includes(value as OnboardingStep);
