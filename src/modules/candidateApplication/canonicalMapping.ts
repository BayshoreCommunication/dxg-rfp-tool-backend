import { CandidateApplicationError } from "./domain";

// Declarative candidate mapping between the legacy-Mongo-shaped source paths the AI/dashboard
// emits, the canonical proposal.v1 contract paths, and the legacy Mongo wizard storage format.
// Field names and reverse-normalization semantics are derived from contracts/proposal/v1/legacyAdapter.ts
// (canonical <- legacy) and modal/proposalsModel.ts; mongoValue must reproduce exactly what the
// legacy wizard stores (display enum strings such as "In-Person", "YES"/"NO"/"NOT_SURE", and
// numeric counts persisted as strings).

type Mapping = {
  canonicalPath: string;
  mongoPath: string;
  normalize: (value: unknown) => unknown;
  mongoValue: (value: unknown) => unknown;
};

const invalid = (message: string): never => {
  throw new CandidateApplicationError("INVALID_CANDIDATE_VALUE", message);
};

const text = (max: number) => (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) return invalid("Candidate text is invalid.");
  return value.trim();
};

const integer = (min: number, max: number, message: string) => (value: unknown): number => {
  if (value === null || value === undefined || typeof value === "boolean") return invalid(message);
  if (typeof value === "string" && !value.trim()) return invalid(message);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return invalid(message);
  return parsed;
};

// Mirrors legacyAdapter.booleanOrNull in reverse; the legacy wizard persists "YES"/"NO"/"NOT_SURE".
const normalizeBooleanOrNull = (value: unknown): boolean | null => {
  if (typeof value === "boolean") return value;
  if (value === null) return null;
  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["yes", "y", "true"].includes(key)) return true;
  if (["no", "n", "false"].includes(key)) return false;
  if (["not_sure", "unknown", "tbd"].includes(key)) return null;
  return invalid("Candidate yes/no value is invalid.");
};
const booleanMongoValue = (value: unknown): string => (value === null ? "NOT_SURE" : value === true ? "YES" : "NO");

type EnumOption = { canonical: string; mongo: string; aliases?: readonly string[] };
const enumKey = (value: unknown): string => String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
const enumeration = (options: readonly EnumOption[], message: string) => ({
  normalize: (value: unknown): string => {
    const key = enumKey(value);
    const match = options.find((option) => enumKey(option.canonical) === key || (option.aliases ?? []).some((alias) => enumKey(alias) === key));
    if (match) return match.canonical;
    // Extraction returns prose ("Human captioner preferred"), not tokens, so a
    // value that clearly contains exactly one option's wording still resolves.
    const contained = options.filter((option) =>
      [option.canonical, ...(option.aliases ?? [])].some((candidate) => {
        const token = enumKey(candidate);
        return token.length > 2 && (key.includes(token) || token.includes(key));
      }));
    return contained.length === 1 ? contained[0].canonical : invalid(message);
  },
  mongoValue: (value: unknown): string => options.find((option) => option.canonical === String(value))!.mongo,
});

const normalizeIsoDate = (value: unknown): string => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return invalid("Candidate date must use the YYYY-MM-DD format.");
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) return invalid("Candidate date is not a valid calendar date.");
  return normalized;
};

const normalizeLocalTime = (value: unknown): string => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(normalized)) return invalid("Candidate time must use the HH:MM 24-hour format.");
  return normalized;
};

const normalizeCurrency = (value: unknown): string => {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(normalized)) return invalid("Candidate currency must be a 3-letter ISO code.");
  return normalized;
};

const normalizeEmail = (value: unknown): string => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return invalid("Candidate email is invalid.");
  return normalized;
};

// The legacy wizard stores amperage as e.g. "200A"; the canonical contract stores {value, unit: "amp"}.
const normalizeAmperage = (value: unknown): { value: number; unit: "amp" } => {
  const raw = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).value : value;
  const parsed =
    typeof raw === "number" ? raw
      : typeof raw === "string" && raw.trim() ? Number.parseFloat(raw.trim().replace(/\s*(amps?|a)\s*$/i, "")) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10000) return invalid("Candidate amperage is invalid.");
  return { value: parsed, unit: "amp" };
};

const identity = (value: unknown): unknown => value;
const asString = (value: unknown): string => String(value);

// Field builders. `mongo` is the dot path inside the legacy Mongo section; `canonical` is the
// slash path inside the canonical content section. The AI/dashboard-facing sourcePath is always
// derived from the mongoPath: `/content/<section>/<mongo path with dots as slashes>`.
type FieldSpec = { mongo: string; canonical: string; normalize: (value: unknown) => unknown; mongoValue?: (value: unknown) => unknown };
const t = (mongo: string, canonical: string, max: number): FieldSpec => ({ mongo, canonical, normalize: text(max) });
const yn = (mongo: string, canonical: string): FieldSpec => ({ mongo, canonical, normalize: normalizeBooleanOrNull, mongoValue: booleanMongoValue });
const count = (mongo: string, canonical: string): FieldSpec => ({ mongo, canonical, normalize: integer(0, 100000, "Candidate count must be an integer between 0 and 100000."), mongoValue: asString });
const day = (mongo: string, canonical: string): FieldSpec => ({ mongo, canonical, normalize: normalizeIsoDate });
const clock = (mongo: string, canonical: string): FieldSpec => ({ mongo, canonical, normalize: normalizeLocalTime });
const pick = (mongo: string, canonical: string, options: readonly EnumOption[], message: string): FieldSpec => ({ mongo, canonical, ...enumeration(options, message) });

const section = (mongoSection: string, canonicalSection: string, fields: readonly FieldSpec[]): Record<string, Mapping> =>
  Object.fromEntries(fields.map((field) => [
    `/content/${mongoSection}/${field.mongo.replace(/\./g, "/")}`,
    {
      canonicalPath: `/content/${canonicalSection}/${field.canonical}`,
      mongoPath: `${mongoSection}.${field.mongo}`,
      normalize: field.normalize,
      mongoValue: field.mongoValue ?? identity,
    },
  ]));

const mappings: Record<string, Mapping> = {
  ...section("event", "event", [
    t("eventName", "name", 300),
    pick("eventFormat", "format", [
      { canonical: "in_person", mongo: "In-Person" },
      { canonical: "hybrid", mongo: "Hybrid" },
      { canonical: "virtual", mongo: "Virtual" },
    ], "Event format is invalid."),
    t("editionYear", "edition", 100),
    t("eventTheme", "theme", 300),
    t("eventWebsite", "website", 2048),
    day("startDate", "startDate"),
    day("endDate", "endDate"),
    t("eventType.eventType", "type", 150),
    t("eventType.eventTypeOther", "typeOther", 200),
    t("eventObjectives", "objectives", 10000),
    t("sacredConstraints", "sacredConstraints", 10000),
    t("aboutOrganization", "organizationBackground", 20000),
    t("statementOfWork", "statementOfWork", 30000),
    t("eventProfile", "eventProfile", 20000),
    t("rfpTimeline", "rfpTimelineNotes", 10000),
  ]),
  ...section("venueSchedule", "venueSchedule", [
    { mongo: "numberOfEventRooms", canonical: "roomCount", normalize: integer(1, 200, "Room count must be between 1 and 200."), mongoValue: asString },
    t("venueName", "venueName", 300),
    t("venueCity", "city", 150),
    t("venueState", "region", 150),
    t("venueAddress", "address", 500),
    t("venueType", "venueType", 150),
    pick("venueConfirmedStatus", "confirmationStatus", [
      { canonical: "contract_signed", mongo: "CONTRACT_SIGNED", aliases: ["contract signed", "signed", "confirmed", "booked", "contracted"] },
      { canonical: "verbal_confirmation", mongo: "VERBAL_CONFIRM", aliases: ["verbal_confirm", "verbal", "verbally confirmed", "verbal hold"] },
      { canonical: "strong_preference", mongo: "STRONG_PREF", aliases: ["strong_pref", "preferred", "leading option", "shortlisted"] },
      { canonical: "not_selected", mongo: "NOT_SELECTED", aliases: ["undecided", "tbd", "not chosen", "still deciding"] },
    ], "Venue confirmation status is invalid."),
    yn("isUnionVenue", "unionVenue"),
    t("unionJurisdictionOther", "unionJurisdictionOther", 500),
    t("timeZone", "timeZone", 100),
    day("loadInDate", "loadIn/date"),
    clock("loadInTime", "loadIn/time"),
    day("rehearsalDate", "rehearsal/date"),
    clock("rehearsalTime", "rehearsal/time"),
    day("showStartDate", "showStart/date"),
    clock("showStartTime", "showStart/time"),
    day("showEndDate", "showEnd/date"),
    clock("showEndTime", "showEnd/time"),
    day("strikeDate", "strike/date"),
    clock("strikeTime", "strike/time"),
  ]),
  ...section("hybridVirtual", "hybridVirtual", [
    count("virtualAttendeeEstimate", "virtualAttendeeCount"),
    t("streamingPlatform", "streamingPlatform", 150),
    t("streamingPlatformOther", "streamingPlatformOther", 150),
    yn("platformIntegrationWithAv", "platformIntegrationWithAv"),
    t("streamOwnership", "streamOwner", 100),
    yn("remoteSpeakers.remoteSpeakers", "remoteSpeakers/required"),
    count("remoteSpeakers.howManyRemoteSpeakers", "remoteSpeakers/count"),
    t("remoteSpeakers.remoteFeedPlatform", "remoteSpeakers/feedPlatform", 150),
    t("remoteSpeakers.techRehearsalOwner", "remoteSpeakers/techRehearsalOwner", 100),
    yn("liveVirtualQa", "liveVirtualQa"),
    yn("virtualOnlyBreakouts", "virtualOnlyBreakouts"),
    yn("dedicatedVirtualProducer", "dedicatedVirtualProducer"),
    yn("closedCaptions.closedCaptions", "closedCaptions/required"),
    t("closedCaptions.captionLanguageOther", "closedCaptions/languageOther", 100),
    pick("closedCaptions.captionType", "closedCaptions/type", [
      { canonical: "ai", mongo: "AI", aliases: ["automatic", "automated", "asr", "machine"] },
      { canonical: "human", mongo: "Human", aliases: ["human captioner", "live captioner", "cart", "stenographer"] },
    ], "Caption type is invalid."),
    yn("onDemandRecording", "onDemandRecording"),
    yn("sponsorOverlays", "sponsorOverlays"),
    yn("virtualNetworking", "virtualNetworking"),
  ]),
  ...section("contentCreative", "contentCreative", [
    yn("contentServicesNeeded", "servicesRequired"),
    t("presentationTemplateDesign", "presentationTemplateOwner", 100),
    t("speakerSlideCollection", "speakerSlideCollectionOwner", 100),
    t("motionGraphicsOpenerVideo", "motionGraphicsOwner", 100),
    t("lowerThirdsNameSupers", "lowerThirdsOwner", 100),
    t("eventLogoBrandStandards", "eventLogoBrandStandardsOwner", 100),
    t("sizzleRecapVideo", "sizzleRecapOwner", 100),
    yn("liveDataFeeds.needed", "liveDataFeeds/required"),
    t("liveDataFeeds.ownership", "liveDataFeeds/owner", 100),
    t("sponsorRecognitionContent", "sponsorRecognitionOwner", 100),
    t("socialMediaContentCapture", "socialMediaCaptureOwner", 100),
    t("virtualBackgroundDesign", "virtualBackgroundOwner", 100),
    t("creativeDirectionNotes", "creativeDirectionNotes", 10000),
  ]),
  ...section("videoRecordingStep", "videoRecording", [
    yn("videoRecordingRequired", "required"),
    count("numberOfCameras", "cameraCount"),
    yn("imagRequired", "imagRequired"),
    count("cameraOperators", "cameraOperatorCount"),
    t("isoRecordings", "isoRecordings", 500),
    t("recordingResolution", "resolution", 100),
    t("recordingMedia", "recordingMedia", 100),
    yn("editedDeliverable.needed", "editedDeliverable/required"),
    t("editedDeliverable.turnaroundTime", "editedDeliverable/turnaroundTime", 200),
    t("editedDeliverable.reelLengthPreference", "editedDeliverable/reelLengthPreference", 200),
    yn("rawFootageTurnover", "rawFootageTurnover"),
  ]),
  ...section("venue", "venueTechnical", [
    t("venueAvContactName", "avContact/name", 200),
    { mongo: "venueAvContactEmail", canonical: "avContact/email", normalize: normalizeEmail },
    t("venueAvContactPhone", "avContact/phone", 50),
    t("inHouseAvCompanyName", "inHouseAvCompanyName", 300),
    yn("riggingRequired", "riggingRequired"),
    t("riggingPlotOrSpecs", "riggingPlotOrSpecs", 5000),
    yn("trussAndMotorsProvidedByVenue", "trussAndMotorsProvided"),
    yn("liftsProvidedByVenue", "liftsProvided"),
    yn("powerDropsRequired", "powerDropsRequired"),
    { mongo: "powerDropAmperage", canonical: "powerDropAmperage", normalize: normalizeAmperage, mongoValue: (value) => `${(value as { value: number }).value}A` },
    count("numberOfPowerDrops", "powerDropCount"),
    yn("wirelessInternetRequired", "wirelessInternetRequired"),
    t("coiRequirements", "coiRequirements", 10000),
    t("venueAccessRequirements", "accessRequirements", 10000),
  ]),
  ...section("uploads", "confidentiality", [
    yn("ndaRequired", "ndaRequired"),
    t("ndaType", "ndaType", 200),
  ]),
  ...section("budget", "budgetPreferences", [
    t("estimatedAvBudget", "budgetBand", 100),
    { mongo: "amountMinor", canonical: "budget/amountMinor", normalize: integer(0, 100_000_000_000, "Candidate budget amount must be a non-negative integer of minor units.") },
    { mongo: "currency", canonical: "budget/currency", normalize: normalizeCurrency },
    t("budgetFlexibility", "flexibility", 500),
    t("sustainabilityDeiNotes", "sustainabilityDeiNotes", 5000),
    day("vendorQuestionsDueDate", "vendorQuestionsDueDate"),
    day("responseToVendorQuestionsDate", "vendorAnswersDate"),
    day("proposalSubmissionDueDate", "proposalDueDate"),
    day("shortlistNotificationDate", "shortlistDate"),
    yn("vendorPresentationOpportunity", "vendorPresentation"),
    day("vendorPresentationDate", "vendorPresentationDate"),
    day("vendorSelectionDate", "vendorSelectionDate"),
    day("decisionDate", "decisionDate"),
    yn("competitiveBid", "competitiveBid"),
    count("numberOfProposals", "proposalCount"),
    t("scoringNotes", "scoringNotes", 5000),
    yn("callWithDxgProducer", "producerCallRequested"),
    t("howDidYouHear", "referralSource", 200),
    t("howDidYouHearOther", "referralSourceOther", 500),
  ]),
};

// Deferred (intentionally unmapped) canonical fields:
// - event.attendeeCount / event.attendeeBand: the legacy wizard stores event.attendees as a display
//   band string ("< 100", "100 - 150", ...) so a numeric count cannot be reversed faithfully.
// - venueSchedule.confirmationStatus "unknown" and closedCaptions.type "unknown": no legacy wizard
//   representation exists; the normalizers reject those values.
// - Arrays (event.primaryAudiences, event.toneDirections, venueSchedule.unionJurisdictions,
//   closedCaptions.languages, videoRecording.cameraPositions, editedDeliverable.types,
//   videoRecording.deliverableFormats, videoRecording.deliveryMethods,
//   venueTechnical.internetUseCases, budgetPreferences.proposalFormats).
// - rooms[], sourceReferences[], vendorCoordination, budgetPreferences.evaluationWeights,
//   contacts.*, presentation.*: out of scope for scalar candidate application.

export type NormalizedCandidate = { sourcePath: string; canonicalPath: string; mongoPath: string; canonicalValue: unknown; mongoValue: unknown };

export const normalizeCandidate = (path: string, value: unknown): NormalizedCandidate => {
  if (path.includes("__proto__") || path.includes("prototype") || path.includes("constructor") || path.includes("$") || path.includes(".")) throw new CandidateApplicationError("CANDIDATE_PATH_DENIED", "Candidate path is prohibited.", 403);
  const mapping = mappings[path];
  if (!mapping) throw new CandidateApplicationError("CANDIDATE_PATH_DENIED", "Candidate path is not approved for Slice 2E.", 403);
  const canonicalValue = mapping.normalize(value);
  return { sourcePath: path, canonicalPath: mapping.canonicalPath, mongoPath: mapping.mongoPath, canonicalValue, mongoValue: mapping.mongoValue(canonicalValue) };
};

export const approvedCandidatePaths = Object.freeze(Object.keys(mappings));

// Consumed by the AI extraction schema as the closed enum of proposable candidate paths.
export const extractionPathEnum: readonly string[] = approvedCandidatePaths;
