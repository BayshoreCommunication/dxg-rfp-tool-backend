/* ORG-604: what a template keeps from an RFP (DXG decision Q4: "content and presentation layout,
   without vendors, responses or dates"). The snapshot is an allowlist of content sections, then a
   scrub of every key that names a date, a person to contact, an uploaded file or a co-vendor.
   Anything not listed here (status, lifecycle and its vendor counts, team, owner, settings, the
   contact section, uploads) never reaches a template. The same function runs again when an RFP
   is created from a template, so a rule added later also applies to templates saved before it. */

export const TEMPLATE_CONTENT_SECTIONS = [
  "event",
  "venueSchedule",
  "roomByRoom",
  "production",
  "hybridVirtual",
  "contentCreative",
  "venue",
  "budget",
] as const;
export type TemplateContentSection = (typeof TEMPLATE_CONTENT_SECTIONS)[number];
export type TemplateContent = Partial<Record<TemplateContentSection, unknown>>;

/** Largest snapshot a template may hold, measured as JSON. */
export const MAX_TEMPLATE_CONTENT_BYTES = 512 * 1024;
const MAX_DEPTH = 12;

const EXCLUDED_KEYS: readonly RegExp[] = [
  // Dates: startDate, endDate, scheduleDate, loadInDateTime, proposalSubmissionDueDate, ...
  /^date|Date/,
  // Schedule times of day and other event-specific timing.
  /^(loadIn|rehearsal|showStart|showEnd|strike)Time$/,
  /^(editionYear|rfpTimeline)$/,
  // People: venueAvContactName, contactEmail, contactPhone, ...
  /contact(Name|Email|Phone)/i,
  // Uploaded documents: brandGuideFiles, venueDocs, supportDocuments, ...
  /(Files?|Docs|Documents)$/,
  // Other vendors working the event, the venue's in-house AV company included.
  /^coVendors?$/i,
  /^inHouseAv/,
];

export const isExcludedTemplateKey = (key: string): boolean =>
  // Keys Mongo treats as operators or paths are dropped too.
  key.startsWith("$") || key.includes(".") || EXCLUDED_KEYS.some((pattern) => pattern.test(key));

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const scrub = (value: unknown, depth: number): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => scrub(entry, depth + 1)).filter((entry) => entry !== undefined);
  }
  // Dates, ids, buffers and other class instances are not template content.
  if (!isPlainObject(value)) return undefined;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isExcludedTemplateKey(key)) continue;
    const kept = scrub(entry, depth + 1);
    if (kept !== undefined) copy[key] = kept;
  }
  return copy;
};

/** The template snapshot of an RFP (or of a stored snapshot): allowlisted sections, scrubbed. */
export const templateContentOf = (source: unknown): TemplateContent => {
  const record = isPlainObject(source) ? source : {};
  const content: TemplateContent = {};
  for (const section of TEMPLATE_CONTENT_SECTIONS) {
    const kept = scrub(record[section], 0);
    if (kept !== undefined && kept !== null) content[section] = kept;
  }
  return content;
};

export const templateContentBytes = (content: TemplateContent): number => Buffer.byteLength(JSON.stringify(content), "utf8");
