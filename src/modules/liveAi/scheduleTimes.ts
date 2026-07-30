/**
 * Schedule fields are stored as UTC instants, but an RFP quotes vendors venue
 * wall-clock times. Handing the drafting model a raw instant made it print the
 * UTC clock face and label it with the event's zone — "3:15 PM CT" for a
 * 9:15 AM CT keynote. Render the venue reading before it becomes evidence.
 */

/** Venue & Schedule stores display labels, not IANA identifiers. */
const IANA_BY_LABEL: Record<string, string> = {
  "Eastern Time (ET)": "America/New_York",
  "Central Time (CT)": "America/Chicago",
  "Mountain Time (MT)": "America/Denver",
  "Pacific Time (PT)": "America/Los_Angeles",
  "Alaska Time (AKT)": "America/Anchorage",
  "Hawaii Time (HT)": "Pacific/Honolulu",
};

/** Short suffix the RFP text should carry, e.g. "CT". */
const ABBREVIATION_BY_LABEL: Record<string, string> = {
  "Eastern Time (ET)": "ET",
  "Central Time (CT)": "CT",
  "Mountain Time (MT)": "MT",
  "Pacific Time (PT)": "PT",
  "Alaska Time (AKT)": "AKT",
  "Hawaii Time (HT)": "HT",
};

export const ianaZoneForLabel = (label: unknown): string | null => {
  if (typeof label !== "string" || !label.trim()) return null;
  const trimmed = label.trim();
  return IANA_BY_LABEL[trimmed] ?? (/^[A-Za-z]+\/[A-Za-z_+-]+$/.test(trimmed) ? trimmed : null);
};

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * "2027-03-10T15:15:00.000Z" + "Central Time (CT)" -> "2027-03-10 09:15 AM CT".
 * Returns null when the value is not an instant or the zone is unknown, so the
 * caller leaves the original text untouched rather than guessing.
 */
export const formatInstantInEventZone = (value: unknown, timeZoneLabel: unknown): string | null => {
  if (typeof value !== "string" || !ISO_INSTANT.test(value.trim())) return null;
  const zone = ianaZoneForLabel(timeZoneLabel);
  if (!zone) return null;
  const instant = new Date(value.trim());
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: true,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const at = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const abbreviation =
    ABBREVIATION_BY_LABEL[String(timeZoneLabel).trim()] ??
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
      .formatToParts(instant)
      .find((part) => part.type === "timeZoneName")?.value ??
    "";
  return `${at("year")}-${at("month")}-${at("day")} ${at("hour")}:${at("minute")} ${at("dayPeriod")} ${abbreviation}`.trim();
};

/** Schedule instants live on these keys; only they are rewritten. */
const SCHEDULE_KEYS = /^(showStartDateTime|showEndDateTime|loadInDateTime|rehearsalDateTime|strikeDateTime)$/;

/**
 * Deep copy with every schedule instant replaced by its venue reading. Values
 * that are not instants, and every other field, are passed through untouched —
 * this only changes how times are presented, never what they mean.
 */
export const withEventZoneScheduleTimes = <T>(value: T, timeZoneLabel: unknown): T => {
  if (!ianaZoneForLabel(timeZoneLabel)) return value;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([key, child]) => [
        key,
        SCHEDULE_KEYS.test(key)
          ? formatInstantInEventZone(child, timeZoneLabel) ?? child
          : walk(child),
      ]),
    );
  };
  return walk(value) as T;
};
