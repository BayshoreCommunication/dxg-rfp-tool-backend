import { checksum } from "./domain";
import type { GeneratedCriterion, GeneratedRequirement, RequirementKind } from "./domain";

export const REQUIREMENT_GENERATOR_VERSION = "requirement-registry.v2";

const VENDOR_SCOPE_ROOTS = [
  "venueSchedule",
  "roomByRoom",
  "production",
  "hybridVirtual",
  "contentCreative",
  "videoRecordingStep",
  "venue",
] as const;
const EVENT_REQUIREMENT_FIELDS = new Set([
  "attendees",
  "attendeeCount",
  "eventObjectives",
  "sacredConstraints",
  "statementOfWork",
  "recordingAllowed",
]);
const BUDGET_REQUIREMENT_FIELDS = new Set([
  "estimatedAvBudget",
  "amountMinor",
  "currency",
  "budgetFlexibility",
  "sustainabilityDeiNotes",
  "vendorQuestionsDueDate",
  "proposalSubmissionDueDate",
  "vendorPresentationOpportunity",
  "vendorPresentationDate",
  "competitiveBid",
  "proposalFormatPreferences",
]);
const CONFIDENTIALITY_REQUIREMENT_FIELDS = new Set(["ndaRequired", "ndaType"]);
const CONTEXT_ONLY_FIELDS = new Set([
  "_id",
  "id",
  "createdAt",
  "updatedAt",
  "__v",
  "eventName",
  "editionYear",
  "eventTheme",
  "eventWebsite",
  "eventType",
  "aboutOrganization",
  "eventProfile",
  "venueName",
  "venueCity",
  "venueState",
  "venueAddress",
  "venueType",
  "venueConfirmedStatus",
  "timeZone",
  "venueAvContactName",
  "venueAvContactEmail",
  "venueAvContactPhone",
]);
const PRIVATE_LEAF = /(files?|urls?|emails?|phones?|docs?|document(ids?)?|storage|objectkey|sha256)$/i;

const CRITERIA: Record<string, { proposalKey: string; name: string; description: string }> = {
  technical_approach: { proposalKey: "technicalApproach", name: "Technical Approach", description: "Technical compliance, equipment, production design, and delivery approach." },
  crew_experience: { proposalKey: "crewExperience", name: "Crew Experience & References", description: "Staffing plan, team qualifications, references, and comparable experience." },
  hybrid_virtual: { proposalKey: "hybridVirtual", name: "Hybrid / Virtual Production Capability", description: "Streaming, platform integration, virtual production, and remote attendee experience." },
  pricing: { proposalKey: "pricing", name: "Pricing & Value", description: "Price competitiveness, transparency, assumptions, alternatives, and value." },
  creative_scenic: { proposalKey: "creativeScenic", name: "Creative & Scenic Design Capability", description: "Creative approach, scenic design, brand experience, and content services." },
  responsiveness: { proposalKey: "responsiveness", name: "Responsiveness & Communication", description: "Submission quality, response completeness, communication, and project management." },
  sustainability_dei: { proposalKey: "sustainabilityDei", name: "Sustainability & DEI Practices", description: "Sustainability, accessibility, diversity, equity, and inclusion practices." },
};
const DEFAULT_CRITERION_WEIGHTS: Record<string, number> = {
  technical_approach: 30,
  crew_experience: 20,
  hybrid_virtual: 10,
  pricing: 20,
  creative_scenic: 8,
  responsiveness: 8,
  sustainability_dei: 4,
};

const words = (value: string) => value
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/[_-]+/g, " ")
  .trim();
const FIELD_TITLES: Record<string, string> = { sacredConstraints: "Non-negotiable constraints" };
const title = (segments: string[]) => {
  const leaf = [...segments].reverse().find((part) => !/^\d+$/.test(part)) ?? "Requirement";
  const room = segments[0] === "roomByRoom" && /^\d+$/.test(segments[1] ?? "") ? `Room ${Number(segments[1]) + 1}: ` : "";
  const label = FIELD_TITLES[leaf] ?? words(leaf);
  return `${room}${label.charAt(0).toUpperCase()}${label.slice(1)}`.slice(0, 300);
};
const scalarText = (value: unknown) => {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return typeof value === "string" ? value.trim() : "";
};
const requirementText = (segments: string[], value: string) => `${title(segments)}: ${value}`.slice(0, 8000);
const kindFor = (path: string): RequirementKind => {
  const lower = path.toLowerCase();
  if (/sacredconstraints|nonnegotiable/.test(lower)) return "mandatory";
  if (/submission|proposalformat|duedate|questionsdate|selectiondate|decisiondate/.test(lower)) return "submission";
  if (/budget|pricing|competitivebid|commercial/.test(lower)) return "commercial";
  if (/crew|staff|labor|producer|technician/.test(lower)) return "staffing";
  if (/reference|experience|portfolio/.test(lower)) return "references";
  if (/sustain|dei|divers|accessib/.test(lower)) return "sustainability_dei";
  if (/nda|coi|insurance|policy|legal|terms/.test(lower)) return "legal_policy";
  return "technical";
};
const criterionFor = (path: string, kind: RequirementKind) => {
  const lower = path.toLowerCase();
  if (kind === "commercial") return "pricing";
  if (kind === "staffing" || kind === "references") return "crew_experience";
  if (kind === "sustainability_dei") return "sustainability_dei";
  if (/hybrid|virtual|stream|remote/.test(lower)) return "hybrid_virtual";
  if (/creative|scenic|brand|content/.test(lower)) return "creative_scenic";
  if (kind === "submission" || kind === "legal_policy") return "responsiveness";
  return "technical_approach";
};
const safeKey = (prefix: string, locator: unknown) => `${prefix}_${checksum(locator).slice(0, 20)}`;

const rubric = (criterion: string) => ({
  minimum: 0 as const,
  maximum: 5 as const,
  anchors: [
    { score: 0, label: "No usable evidence", description: `The response provides no cited evidence that addresses ${criterion.toLocaleLowerCase()}.` },
    { score: 1, label: "Major deficiencies", description: `The response addresses little of ${criterion.toLocaleLowerCase()} and contains material gaps or unsupported claims.` },
    { score: 2, label: "Partially meets", description: `The response addresses some of ${criterion.toLocaleLowerCase()}, but important requirements, detail, or evidence are missing.` },
    { score: 3, label: "Meets", description: `The cited response evidence adequately meets the approved requirements associated with ${criterion.toLocaleLowerCase()}.` },
    { score: 4, label: "Exceeds", description: `The cited response evidence exceeds the associated requirements with a strong, credible, and low-risk approach.` },
    { score: 5, label: "Exceptional", description: `The cited response evidence is complete and exceptionally differentiated for ${criterion.toLocaleLowerCase()}, with no material unresolved concern.` },
  ],
});

export const generateCriteria = (proposal: Record<string, unknown>): GeneratedCriterion[] => {
  const budget = proposal.budget && typeof proposal.budget === "object" ? proposal.budget as Record<string, unknown> : {};
  const matrix = budget.evaluationMatrix && typeof budget.evaluationMatrix === "object" ? budget.evaluationMatrix as Record<string, unknown> : {};
  return Object.entries(CRITERIA).flatMap(([key, presentation], ordinal) => {
    const weight = Number(matrix[presentation.proposalKey]);
    const resolvedWeight = Number.isFinite(weight) && weight >= 0 && weight <= 100 ? weight : DEFAULT_CRITERION_WEIGHTS[key];
    return [{ key, name: presentation.name, description: presentation.description, weight: resolvedWeight, ordinal, rubric: rubric(presentation.name) }];
  });
};

export type RenderedParagraph = { runId: string; runChecksum: string | null; sectionKey: string; paragraphId: string; ordinal: number; text: string };

export const generateRequirements = (
  proposal: Record<string, unknown>,
  rendered: RenderedParagraph[] = [],
): GeneratedRequirement[] => {
  const output: GeneratedRequirement[] = [];
  const visit = (value: unknown, segments: string[]) => {
    const leaf = segments.at(-1) ?? "";
    if (CONTEXT_ONLY_FIELDS.has(leaf) || PRIVATE_LEAF.test(leaf)) return;
    if (Array.isArray(value)) {
      const scalarValues = value.map(scalarText).filter(Boolean);
      if (scalarValues.length === value.length && scalarValues.length) {
        const path = `/${segments.join("/")}`;
        const kind = kindFor(path);
        output.push({
          key: safeKey("req", { source: "canonical_proposal", paths: scalarValues.map((_, index) => `/content${path}/${index}`) }),
          kind,
          title: title(segments),
          text: requirementText(segments, scalarValues.join("; ")),
          mandatoryStatus: "pending",
          sourceKind: "canonical_proposal",
          sourceLocator: { kind: "canonical_proposal", path: `/content${path}`, paths: scalarValues.map((_, index) => `/content${path}/${index}`), provenanceLabel: "Planner-authored proposal fields" },
          suggestedCriterionKey: criterionFor(path, kind),
          importance: kind === "submission" || kind === "legal_policy" ? "high" : "medium",
          verificationMethod: "pending",
          groupKey: segments[0] ?? "proposal",
          ordinal: output.length,
        });
        return;
      }
      value.forEach((child, index) => visit(child, [...segments, String(index)]));
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([key, child]) => visit(child, [...segments, key]));
      return;
    }
    const text = scalarText(value);
    if (!text || /^(https?:\/\/|s3:\/\/)/i.test(text) || text.includes("private/")) return;
    const path = `/${segments.join("/")}`;
    const kind = kindFor(path);
    output.push({
      key: safeKey("req", { source: "canonical_proposal", path }),
      kind,
      title: title(segments),
      text: requirementText(segments, text),
      mandatoryStatus: "pending",
      sourceKind: "canonical_proposal",
      sourceLocator: { kind: "canonical_proposal", path: `/content${path}`, provenanceLabel: "Planner-authored proposal field" },
      suggestedCriterionKey: criterionFor(path, kind),
      importance: kind === "submission" || kind === "legal_policy" ? "high" : "medium",
      verificationMethod: "pending",
      groupKey: segments[0] ?? "proposal",
      ordinal: output.length,
    });
  };
  const event = proposal.event && typeof proposal.event === "object" ? proposal.event as Record<string, unknown> : {};
  [...EVENT_REQUIREMENT_FIELDS].sort().forEach((field) => visit(event[field], ["event", field]));
  VENDOR_SCOPE_ROOTS.forEach((root) => visit(proposal[root], [root]));
  const budget = proposal.budget && typeof proposal.budget === "object" ? proposal.budget as Record<string, unknown> : {};
  [...BUDGET_REQUIREMENT_FIELDS].sort().forEach((field) => visit(budget[field], ["budget", field]));
  const uploads = proposal.uploads && typeof proposal.uploads === "object" ? proposal.uploads as Record<string, unknown> : {};
  [...CONFIDENTIALITY_REQUIREMENT_FIELDS].sort().forEach((field) => visit(uploads[field], ["uploads", field]));
  for (const paragraph of rendered) {
    const normalized = paragraph.text.trim();
    if (!normalized) continue;
    output.push({
      key: safeKey("rfp", { runId: paragraph.runId, paragraphId: paragraph.paragraphId }),
      kind: "narrative",
      title: `${words(paragraph.sectionKey).replace(/^./, (value) => value.toUpperCase())} narrative`,
      text: normalized.slice(0, 8000),
      mandatoryStatus: "pending",
      sourceKind: "rendered_rfp",
      sourceLocator: { kind: "rendered_rfp", runId: paragraph.runId, sectionKey: paragraph.sectionKey, paragraphId: paragraph.paragraphId, ordinal: paragraph.ordinal },
      suggestedCriterionKey: criterionFor(paragraph.sectionKey, "narrative"),
      importance: "medium",
      verificationMethod: "pending",
      groupKey: paragraph.sectionKey,
      ordinal: output.length,
    });
  }
  return output;
};
