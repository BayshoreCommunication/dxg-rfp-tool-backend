import { aiRuntimeAuthorized } from "../../../config/aiEnvironment";
import { approvedCandidatePaths } from "../candidateApplication/canonicalMapping";

export class GuidanceError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}

export const guidanceEnabled = () => aiRuntimeAuthorized() && process.env.GUIDANCE_ENABLED === "true";

export const PROPOSAL_ANALYSIS_VERSION = "proposal-analysis.v2";

export type GuidanceEvidence = {
  path: string;
  state: "missing" | "present" | "conflicting";
  value?: string;
};

export type GuidanceFinding = {
  id: string;
  code: string;
  severity: "info" | "warning" | "blocking";
  category: "completeness" | "schedule" | "production" | "budget" | "risk";
  message: string;
  paths: string[];
  affectedSection: string | null;
  affectedFields: string[];
  evidence: GuidanceEvidence[];
  explanation: string;
  suggestedNextStep: string;
  confidence: "high";
  provenance: {
    source: "current_proposal";
    ruleId: string;
    ruleVersion: string;
  };
  proposalVersion: number;
  analysisVersion: string;
};
export type SectionCompleteness = { section: string; label: string; filled: number; total: number; score: number };
export type ProposalAnalysisSummary = {
  eventName: string | null;
  eventFormat: string | null;
  dateRange: string | null;
  attendeeCount: number | null;
  roomCount: number | null;
};
export type GuidanceResult = {
  analysisVersion: string;
  proposalVersion: number;
  summary: ProposalAnalysisSummary;
  overall: number;
  completeness: SectionCompleteness[];
  findings: GuidanceFinding[];
};

const SECTION_LABELS: Record<string, string> = {
  event: "Event overview",
  venueSchedule: "Venue & schedule",
  hybridVirtual: "Hybrid & virtual",
  contentCreative: "Content & creative",
  videoRecordingStep: "Video recording",
  venue: "Venue technical",
  uploads: "Confidentiality",
  budget: "Budget & timeline",
};

const mongoPathOf = (sourcePath: string) => sourcePath.slice("/content/".length).replace(/\//g, ".");
const valueAt = (proposal: Record<string, unknown>, sourcePath: string): unknown =>
  mongoPathOf(sourcePath).split(".").reduce<unknown>((node, key) =>
    node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined, proposal);
const filled = (value: unknown): boolean =>
  value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "");
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const isYes = (value: unknown): boolean => /^(yes|true)$/i.test(text(value)) || value === true;
const asDate = (value: unknown): Date | null => {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const asCount = (value: unknown): number | null => {
  const n = Number(text(value) || (typeof value === "number" ? value : NaN));
  return Number.isFinite(n) ? n : null;
};
const safeEvidenceValue = (value: unknown): string | undefined => {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 80) return undefined;
  return normalized;
};
const sectionForPath = (path: string): string | null =>
  path.startsWith("/content/") ? path.split("/")[2] || null : null;
const fieldForPath = (path: string): string =>
  path.split("/").filter(Boolean).pop() ?? path;
const findingId = (code: string, paths: readonly string[]): string =>
  `${PROPOSAL_ANALYSIS_VERSION}:${code.toLocaleLowerCase("en-US")}:${paths.join("|") || "proposal"}`;

// Deterministic, rule-based guidance: no model calls, every finding traceable
// to concrete proposal fields. Rules mirror the pre-publication checklist the
// client scope describes (missing requirements, conflicts, schedule concerns).
export const computeGuidance = (
  proposal: Record<string, unknown>,
  options: { proposalVersion?: number } = {},
): GuidanceResult => {
  const proposalVersion = Math.max(
    1,
    Math.floor(options.proposalVersion ?? (Number(proposal.version) || 1)),
  );
  const bySection = new Map<string, { filled: number; total: number }>();
  for (const path of approvedCandidatePaths) {
    const section = path.split("/")[2];
    const bucket = bySection.get(section) ?? { filled: 0, total: 0 };
    bucket.total += 1;
    if (filled(valueAt(proposal, path))) bucket.filled += 1;
    bySection.set(section, bucket);
  }
  const completeness: SectionCompleteness[] = [...bySection.entries()].map(([section, counts]) => ({
    section,
    label: SECTION_LABELS[section] ?? section,
    filled: counts.filled,
    total: counts.total,
    score: counts.total ? Number((counts.filled / counts.total).toFixed(4)) : 0,
  }));
  const totals = completeness.reduce((sum, item) => ({ filled: sum.filled + item.filled, total: sum.total + item.total }), { filled: 0, total: 0 });
  const overall = totals.total ? Number((totals.filled / totals.total).toFixed(4)) : 0;

  const findings: GuidanceFinding[] = [];
  const v = (path: string) => valueAt(proposal, path);
  const flag = (
    finding: Pick<GuidanceFinding, "code" | "severity" | "category" | "message" | "paths"> & {
      suggestedNextStep?: string;
      conflictingPaths?: string[];
    },
  ) => {
    const conflicting = new Set(finding.conflictingPaths ?? []);
    findings.push({
      ...finding,
      id: findingId(finding.code, finding.paths),
      affectedSection: finding.paths.map(sectionForPath).find(Boolean) ?? null,
      affectedFields: finding.paths.map(fieldForPath),
      evidence: finding.paths.map((path) => {
        const value = v(path);
        const display = safeEvidenceValue(value);
        return {
          path,
          state: conflicting.has(path)
            ? "conflicting"
            : filled(value)
              ? "present"
              : "missing",
          ...(display === undefined ? {} : { value: display }),
        };
      }),
      explanation: finding.message,
      suggestedNextStep:
        finding.suggestedNextStep ??
        `Review ${finding.paths.map(fieldForPath).join(" and ") || "this requirement"} and update the proposal before sending.`,
      confidence: "high",
      provenance: {
        source: "current_proposal",
        ruleId: finding.code,
        ruleVersion: PROPOSAL_ANALYSIS_VERSION,
      },
      proposalVersion,
      analysisVersion: PROPOSAL_ANALYSIS_VERSION,
    });
  };

  const startDate = asDate(v("/content/event/startDate"));
  const endDate = asDate(v("/content/event/endDate"));
  if (!filled(v("/content/event/eventName")) && !filled(v("/content/event/name")))
    flag({ code: "EVENT_NAME_MISSING", severity: "warning", category: "completeness", message: "The proposal does not identify the event.", paths: ["/content/event/eventName"], suggestedNextStep: "Add the event’s working name so vendors can identify the opportunity." });
  if (!filled(v("/content/event/eventFormat")) && !filled(v("/content/event/format")))
    flag({ code: "EVENT_FORMAT_MISSING", severity: "warning", category: "completeness", message: "The event format is not selected.", paths: ["/content/event/eventFormat"], suggestedNextStep: "Choose in-person, hybrid, or virtual so conditional production requirements can be evaluated." });
  if (!filled(v("/content/event/attendees")) && !filled(v("/content/event/attendeeCount")))
    flag({ code: "ATTENDEE_COUNT_MISSING", severity: "warning", category: "completeness", message: "No attendance estimate is provided.", paths: ["/content/event/attendees"], suggestedNextStep: "Add the best current attendance estimate or planning range." });
  if (startDate && endDate && startDate > endDate)
    flag({ code: "EVENT_DATES_REVERSED", severity: "blocking", category: "schedule", message: "The event start date is after the end date. Vendors cannot quote against this timeline.", paths: ["/content/event/startDate", "/content/event/endDate"], conflictingPaths: ["/content/event/startDate", "/content/event/endDate"], suggestedNextStep: "Correct the event date range before requesting vendor pricing." });

  const loadIn = asDate(v("/content/venueSchedule/loadInDate"));
  const showStart = asDate(v("/content/venueSchedule/showStartDate"));
  const showEnd = asDate(v("/content/venueSchedule/showEndDate"));
  const strike = asDate(v("/content/venueSchedule/strikeDate"));
  if (showStart && !loadIn)
    flag({ code: "LOAD_IN_MISSING", severity: "warning", category: "schedule", message: "A show date is set but no load-in date. Load-in time drives labor cost and venue booking.", paths: ["/content/venueSchedule/loadInDate"] });
  if (loadIn && showStart && loadIn > showStart)
    flag({ code: "LOAD_IN_AFTER_SHOW", severity: "blocking", category: "schedule", message: "Load-in is scheduled after the show starts.", paths: ["/content/venueSchedule/loadInDate", "/content/venueSchedule/showStartDate"], conflictingPaths: ["/content/venueSchedule/loadInDate", "/content/venueSchedule/showStartDate"], suggestedNextStep: "Move load-in before show start and leave enough time for setup and testing." });
  if (showEnd && strike && strike < showEnd)
    flag({ code: "STRIKE_BEFORE_SHOW_END", severity: "warning", category: "schedule", message: "Strike is scheduled before the show ends.", paths: ["/content/venueSchedule/strikeDate", "/content/venueSchedule/showEndDate"], conflictingPaths: ["/content/venueSchedule/strikeDate", "/content/venueSchedule/showEndDate"], suggestedNextStep: "Schedule strike after the final session and confirm venue access." });

  const roomCount = asCount(v("/content/venueSchedule/numberOfEventRooms"));
  const rooms = Array.isArray((proposal as { roomByRoom?: unknown[] }).roomByRoom) ? (proposal as { roomByRoom: unknown[] }).roomByRoom.length : 0;
  if (roomCount === null)
    flag({ code: "ROOM_COUNT_MISSING", severity: "warning", category: "completeness", message: "The proposal does not state how many event rooms are required.", paths: ["/content/venueSchedule/numberOfEventRooms"], suggestedNextStep: "Add the expected room count, even if the venue is not final." });
  if (roomCount !== null && rooms > 0 && roomCount !== rooms)
    flag({ code: "ROOM_COUNT_MISMATCH", severity: "warning", category: "risk", message: `The schedule says ${roomCount} room(s) but ${rooms} room specification(s) are defined. Vendors will price the wrong scope.`, paths: ["/content/venueSchedule/numberOfEventRooms"], conflictingPaths: ["/content/venueSchedule/numberOfEventRooms"], suggestedNextStep: "Make the declared room count match the room-by-room specifications." });
  if (roomCount !== null && roomCount > 0 && rooms === 0)
    flag({ code: "ROOM_SPECS_MISSING", severity: "warning", category: "production", message: "Rooms are declared but no room-by-room AV specifications exist yet.", paths: ["/content/venueSchedule/numberOfEventRooms"] });

  const format = text(v("/content/event/eventFormat")).toLowerCase();
  if ((format.includes("hybrid") || format.includes("virtual")) && !filled(v("/content/hybridVirtual/streamingPlatform")))
    flag({ code: "STREAMING_PLATFORM_MISSING", severity: "warning", category: "production", message: "The event is hybrid or virtual but no streaming platform is specified.", paths: ["/content/hybridVirtual/streamingPlatform"] });

  if (isYes(v("/content/videoRecordingStep/videoRecordingRequired")) && (asCount(v("/content/videoRecordingStep/numberOfCameras")) ?? 0) === 0)
    flag({ code: "CAMERA_COUNT_MISSING", severity: "warning", category: "production", message: "Video recording is required but no camera count is specified.", paths: ["/content/videoRecordingStep/numberOfCameras"] });
  if (
    isYes(v("/content/videoRecordingStep/videoRecordingRequired")) &&
    (asCount(v("/content/videoRecordingStep/cameraOperators")) ?? 0) === 0
  )
    flag({ code: "CAMERA_OPERATOR_MISSING", severity: "warning", category: "production", message: "Video recording is required but no camera operator count is specified.", paths: ["/content/videoRecordingStep/cameraOperators"], suggestedNextStep: "Confirm the operator plan for each camera position and show period." });
  if (
    isYes(v("/content/videoRecordingStep/videoRecordingRequired")) &&
    !filled(v("/content/videoRecordingStep/recordingMedia")) &&
    !filled(v("/content/videoRecordingStep/rawFootageTurnover")) &&
    !filled(v("/content/videoRecordingStep/editedDeliverable/needed"))
  )
    flag({ code: "RECORDING_DELIVERY_MISSING", severity: "warning", category: "production", message: "Recording is requested but storage, handoff, and edited-deliverable requirements are not defined.", paths: ["/content/videoRecordingStep/recordingMedia", "/content/videoRecordingStep/rawFootageTurnover", "/content/videoRecordingStep/editedDeliverable/needed"], suggestedNextStep: "Specify recording media, raw-footage handoff, edited deliverables, and turnaround expectations." });

  if (isYes(v("/content/venueSchedule/isUnionVenue")) && !filled(v("/content/venueSchedule/unionJurisdictionOther")) && !(Array.isArray((proposal as { venueSchedule?: { unionJurisdictions?: unknown[] } }).venueSchedule?.unionJurisdictions) && (proposal as { venueSchedule: { unionJurisdictions: unknown[] } }).venueSchedule.unionJurisdictions.length))
    flag({ code: "UNION_JURISDICTIONS_MISSING", severity: "warning", category: "risk", message: "This is a union venue but no jurisdictions are listed. Union labor rules materially change cost.", paths: ["/content/venueSchedule/isUnionVenue"] });

  if (isYes(v("/content/venue/powerDropsRequired")) && (asCount(v("/content/venue/numberOfPowerDrops")) ?? 0) === 0)
    flag({ code: "POWER_DROP_COUNT_MISSING", severity: "info", category: "production", message: "Power drops are required but the count is not specified.", paths: ["/content/venue/numberOfPowerDrops"] });

  const proposalDue = asDate(v("/content/budget/proposalSubmissionDueDate"));
  if (startDate && proposalDue && proposalDue >= startDate)
    flag({ code: "PROPOSAL_DUE_AFTER_EVENT", severity: "blocking", category: "schedule", message: "The proposal due date is on or after the event start date.", paths: ["/content/budget/proposalSubmissionDueDate", "/content/event/startDate"], conflictingPaths: ["/content/budget/proposalSubmissionDueDate", "/content/event/startDate"], suggestedNextStep: "Set a proposal deadline before the event with enough time for review and vendor selection." });
  const questionsDue = asDate(v("/content/budget/vendorQuestionsDueDate"));
  if (questionsDue && proposalDue && questionsDue > proposalDue)
    flag({ code: "QUESTIONS_DUE_AFTER_PROPOSALS", severity: "warning", category: "schedule", message: "Vendor questions are due after proposals are due.", paths: ["/content/budget/vendorQuestionsDueDate", "/content/budget/proposalSubmissionDueDate"], conflictingPaths: ["/content/budget/vendorQuestionsDueDate", "/content/budget/proposalSubmissionDueDate"], suggestedNextStep: "Move the vendor-question deadline before the proposal deadline." });
  if (!filled(v("/content/budget/estimatedAvBudget")) && !filled(v("/content/budget/amountMinor")))
    flag({ code: "BUDGET_MISSING", severity: "info", category: "budget", message: "No budget guidance is provided. Vendors quote more accurately with at least a budget band.", paths: ["/content/budget/estimatedAvBudget"] });
  const decisionDate = asDate(v("/content/budget/decisionDate"));
  if (decisionDate && proposalDue && decisionDate < proposalDue)
    flag({ code: "DECISION_BEFORE_PROPOSALS_DUE", severity: "blocking", category: "schedule", message: "The decision date is before proposals are due.", paths: ["/content/budget/decisionDate", "/content/budget/proposalSubmissionDueDate"], conflictingPaths: ["/content/budget/decisionDate", "/content/budget/proposalSubmissionDueDate"], suggestedNextStep: "Move the decision date after the proposal deadline and allow time for evaluation." });

  const contactPaths = [
    "/content/contact/contactFirstName",
    "/content/contact/contactLastName",
    "/content/contact/contactEmail",
    "/content/contact/contactPhone",
  ];
  const missingContacts = contactPaths.filter((path) => !filled(v(path)));
  if (missingContacts.length)
    flag({ code: "CONTACT_DETAILS_INCOMPLETE", severity: "warning", category: "completeness", message: "Primary contact information is incomplete.", paths: missingContacts, suggestedNextStep: "Complete the primary contact name, email, and phone before submitting the proposal." });

  for (const item of completeness)
    if (item.score < 0.25 && item.total >= 5)
      flag({ code: `SECTION_SPARSE_${item.section.toUpperCase()}`, severity: "info", category: "completeness", message: `${item.label} is mostly empty (${item.filled} of ${item.total} fields).`, paths: [] });

  const eventName = text(v("/content/event/eventName")) || text(v("/content/event/name"));
  const eventFormat = text(v("/content/event/eventFormat")) || text(v("/content/event/format"));
  const attendeeCount =
    asCount(v("/content/event/attendees")) ??
    asCount(v("/content/event/attendeeCount"));
  return {
    analysisVersion: PROPOSAL_ANALYSIS_VERSION,
    proposalVersion,
    summary: {
      eventName: eventName || null,
      eventFormat: eventFormat || null,
      dateRange:
        startDate && endDate
          ? `${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)}`
          : startDate
            ? startDate.toISOString().slice(0, 10)
            : null,
      attendeeCount,
      roomCount,
    },
    overall,
    completeness,
    findings,
  };
};
