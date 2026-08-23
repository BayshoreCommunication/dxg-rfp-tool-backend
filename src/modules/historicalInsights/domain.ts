import { aiRuntimeAuthorized } from "../../../config/aiEnvironment";
import { proposalWorkflowSectionEnabled } from "../proposals/domain/workflowSections";

export const HISTORICAL_INSIGHTS_VERSION = "historical-insights.v2";
export const MAX_HISTORICAL_REFERENCES = 5;

export class HistoricalInsightsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422,
  ) {
    super(message);
  }
}

export const historicalInsightsEnabled = () =>
  aiRuntimeAuthorized() &&
  process.env.HISTORICAL_INSIGHTS_ENABLED === "true";

type ProposalRecord = Record<string, unknown>;
type Provenance = {
  source: "selected_historical_reference";
  referenceKey: string;
  proposalVersion: number;
};

export type HistoricalSectionComparison = {
  section: string;
  label: string;
  status:
    | "exists_in_both"
    | "reference_only"
    | "current_only"
    | "not_present";
  detail: string;
  referenceKeys: string[];
  provenance: Provenance[];
};

export type HistoricalInsight = {
  id: string;
  category:
    | "section_structure"
    | "requirement_category"
    | "planning_question"
    | "scope_pattern"
    | "evaluation_criteria"
    | "timeline_checklist"
    | "resource_approach";
  applicability: "may_apply" | "needs_confirmation";
  title: string;
  detail: string;
  question: string | null;
  affectedSection: string;
  provenance: Provenance[];
};

export type HistoricalInsightsResult = {
  analysisVersion: string;
  currentProposalVersion: number;
  references: Array<{
    referenceKey: string;
    label: string;
    proposalVersion: number;
  }>;
  comparisons: HistoricalSectionComparison[];
  insights: HistoricalInsight[];
  privacy: {
    redactedByDefault: true;
    exactPricingExcluded: true;
    rawContentRetained: false;
  };
};

type SectionDefinition = {
  key: string;
  label: string;
  fields: string[];
  category: HistoricalInsight["category"];
  question: string;
};

// Only structural presence is compared. Contact data, client identity, free-form
// private notes, uploads, exact values, and every budget amount are excluded.
const ALL_SECTIONS: readonly SectionDefinition[] = [
  {
    key: "event",
    label: "Event overview",
    fields: ["event.eventFormat", "event.startDate", "event.endDate", "event.attendees"],
    category: "section_structure",
    question: "Would the current proposal benefit from the same event-overview structure?",
  },
  {
    key: "venueSchedule",
    label: "Venue and schedule",
    fields: [
      "venueSchedule.venueCity",
      "venueSchedule.numberOfEventRooms",
      "venueSchedule.loadInDate",
      "venueSchedule.rehearsalDate",
      "venueSchedule.showStartDate",
      "venueSchedule.strikeDate",
    ],
    category: "timeline_checklist",
    question: "Should venue access, rehearsal, show, and strike milestones be confirmed?",
  },
  {
    key: "roomByRoom",
    label: "Room specifications",
    fields: ["roomByRoom"],
    category: "resource_approach",
    question: "Could a room-by-room equipment and staffing plan help this event?",
  },
  {
    key: "hybridVirtual",
    label: "Hybrid and virtual production",
    fields: [
      "hybridVirtual.streamingPlatform",
      "hybridVirtual.virtualAttendeeEstimate",
      "hybridVirtual.closedCaptions",
    ],
    category: "scope_pattern",
    question: "Does this event need streaming, virtual-attendee, or accessibility scope?",
  },
  {
    key: "contentCreative",
    label: "Content and creative",
    fields: ["contentCreative"],
    category: "requirement_category",
    question: "Should content ownership, creative deliverables, or approval timing be defined?",
  },
  {
    key: "videoRecordingStep",
    label: "Video recording",
    fields: ["videoRecordingStep.videoRecordingRequired", "videoRecordingStep.numberOfCameras"],
    category: "resource_approach",
    question: "Should recording deliverables, camera coverage, and crew ownership be confirmed?",
  },
  {
    key: "venue",
    label: "Venue technical requirements",
    fields: [
      "venue.inHouseAvRequired",
      "venue.wirelessInternetRequired",
      "venue.internetUseCases",
      "venue.accessRequirements",
    ],
    category: "requirement_category",
    question: "Should internet, accessibility, power, rigging, or in-house AV constraints be confirmed?",
  },
  {
    key: "budget",
    label: "Evaluation and commercial preferences",
    fields: [
      "budget.estimatedAvBudget",
      "budget.evaluationCriteria",
      "budget.vendorSelectionDate",
    ],
    category: "evaluation_criteria",
    question: "Should evaluation criteria and commercial milestones be clarified?",
  },
];

const SECTIONS: readonly SectionDefinition[] = ALL_SECTIONS.filter(
  (section) =>
    section.key !== "videoRecordingStep" ||
    proposalWorkflowSectionEnabled("video_recording"),
);

const record = (value: unknown): ProposalRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as ProposalRecord)
    : {};

const valueAt = (proposal: ProposalRecord, path: string): unknown =>
  path.split(".").reduce<unknown>(
    (node, key) => (node && typeof node === "object" ? (node as ProposalRecord)[key] : undefined),
    proposal,
  );

const present = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object")
    return Object.values(record(value)).some(present);
  return true;
};

const sectionPresent = (proposal: ProposalRecord, section: SectionDefinition) =>
  section.fields.some((path) => present(valueAt(proposal, path)));

export const parseHistoricalReferenceIds = (
  value: unknown,
  currentProposalId: string,
): string[] => {
  if (!Array.isArray(value))
    throw new HistoricalInsightsError(
      "HISTORICAL_REFERENCES_REQUIRED",
      "Select at least one historical proposal.",
      400,
    );
  const ids = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase());
  if (
    ids.length < 1 ||
    ids.length > MAX_HISTORICAL_REFERENCES ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[0-9a-f]{24}$/.test(id) || id === currentProposalId)
  )
    throw new HistoricalInsightsError(
      "HISTORICAL_REFERENCES_INVALID",
      `Select between 1 and ${MAX_HISTORICAL_REFERENCES} different accessible proposals.`,
      400,
    );
  return ids;
};

export const computeHistoricalInsights = (
  current: ProposalRecord,
  references: Array<{ proposal: ProposalRecord; proposalVersion: number }>,
): HistoricalInsightsResult => {
  const currentProposalVersion = Math.max(1, Number(current.version) || 1);
  const referenceMetadata = references.map((reference, index) => ({
    referenceKey: `reference-${index + 1}`,
    label: `Selected reference ${index + 1}`,
    proposalVersion: Math.max(1, Number(reference.proposalVersion) || 1),
  }));

  const provenanceFor = (indexes: number[]): Provenance[] =>
    indexes.map((index) => ({
      source: "selected_historical_reference",
      referenceKey: referenceMetadata[index].referenceKey,
      proposalVersion: referenceMetadata[index].proposalVersion,
    }));

  const comparisons: HistoricalSectionComparison[] = [];
  const insights: HistoricalInsight[] = [];

  for (const section of SECTIONS) {
    const currentHas = sectionPresent(current, section);
    const referenceIndexes = references.flatMap((reference, index) =>
      sectionPresent(reference.proposal, section) ? [index] : [],
    );
    const referencesHave = referenceIndexes.length > 0;
    const status: HistoricalSectionComparison["status"] =
      currentHas && referencesHave
        ? "exists_in_both"
        : referencesHave
          ? "reference_only"
          : currentHas
            ? "current_only"
            : "not_present";
    const provenance = provenanceFor(referenceIndexes);
    comparisons.push({
      section: section.key,
      label: section.label,
      status,
      detail:
        status === "exists_in_both"
          ? "This section has planning structure in both the current proposal and at least one selected reference."
          : status === "reference_only"
            ? "This planning area appears in a selected reference but not in the current proposal."
            : status === "current_only"
              ? "This planning area appears in the current proposal but not in the selected references."
              : "No compared proposal currently contains structured information for this area.",
      referenceKeys: referenceIndexes.map(
        (index) => referenceMetadata[index].referenceKey,
      ),
      provenance,
    });

    if (status === "reference_only") {
      insights.push({
        id: `${HISTORICAL_INSIGHTS_VERSION}:${section.key}:may-apply`,
        category: section.category,
        applicability: "may_apply",
        title: `Consider ${section.label.toLowerCase()}`,
        detail:
          "A selected historical reference included structure for this area. Treat it as an idea, not as a fact about the current event.",
        question: section.question,
        affectedSection: section.key,
        provenance,
      });
    } else if (status === "exists_in_both") {
      insights.push({
        id: `${HISTORICAL_INSIGHTS_VERSION}:${section.key}:confirm`,
        category: "planning_question",
        applicability: "needs_confirmation",
        title: `Confirm the ${section.label.toLowerCase()} approach`,
        detail:
          "Both proposals address this area, but the historical approach may not fit the current event.",
        question: section.question,
        affectedSection: section.key,
        provenance,
      });
    }
  }

  return {
    analysisVersion: HISTORICAL_INSIGHTS_VERSION,
    currentProposalVersion,
    references: referenceMetadata,
    comparisons,
    insights: insights.slice(0, 16),
    privacy: {
      redactedByDefault: true,
      exactPricingExcluded: true,
      rawContentRetained: false,
    },
  };
};
