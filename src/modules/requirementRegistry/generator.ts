import { checksum } from "./domain";
import type { GeneratedCriterion, GeneratedRequirement, RequirementKind } from "./domain";

const ROOTS = [
  "event",
  "venueSchedule",
  "roomByRoom",
  "production",
  "hybridVirtual",
  "contentCreative",
  "videoRecordingStep",
  "venue",
  "uploads",
  "budget",
  "proposalSettings",
] as const;
const PRIVATE_OR_DERIVED = new Set([
  "contact",
  "evaluationMatrix",
  "evaluationMatrixConfirmed",
  "_id",
  "id",
  "createdAt",
  "updatedAt",
  "__v",
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

const words = (value: string) => value
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/[_-]+/g, " ")
  .trim();
const title = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  const leaf = parts.at(-1) ?? "Requirement";
  const room = parts[0] === "roomByRoom" && /^\d+$/.test(parts[1] ?? "") ? `Room ${Number(parts[1]) + 1}: ` : "";
  const label = words(leaf);
  return `${room}${label.charAt(0).toUpperCase()}${label.slice(1)}`.slice(0, 300);
};
const scalarText = (value: unknown) => {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return typeof value === "string" ? value.trim() : "";
};
const kindFor = (path: string): RequirementKind => {
  const lower = path.toLowerCase();
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

export const generateCriteria = (proposal: Record<string, unknown>): GeneratedCriterion[] => {
  const budget = proposal.budget && typeof proposal.budget === "object" ? proposal.budget as Record<string, unknown> : {};
  const matrix = budget.evaluationMatrix && typeof budget.evaluationMatrix === "object" ? budget.evaluationMatrix as Record<string, unknown> : {};
  return Object.entries(CRITERIA).flatMap(([key, presentation], ordinal) => {
    const weight = Number(matrix[presentation.proposalKey]);
    return Number.isFinite(weight) && weight >= 0 && weight <= 100
      ? [{ key, name: presentation.name, description: presentation.description, weight, ordinal }]
      : [];
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
    if (PRIVATE_OR_DERIVED.has(leaf) || PRIVATE_LEAF.test(leaf)) return;
    if (Array.isArray(value)) {
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
      title: title(path),
      text: text.slice(0, 8000),
      mandatoryStatus: "pending",
      sourceKind: "canonical_proposal",
      sourceLocator: { kind: "canonical_proposal", path: `/content${path}` },
      suggestedCriterionKey: criterionFor(path, kind),
      importance: kind === "submission" || kind === "legal_policy" ? "high" : "medium",
      verificationMethod: "pending",
      groupKey: segments[0] ?? "proposal",
      ordinal: output.length,
    });
  };
  ROOTS.forEach((root) => visit(proposal[root], [root]));
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
