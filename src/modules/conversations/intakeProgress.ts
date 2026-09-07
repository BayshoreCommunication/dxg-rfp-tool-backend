import { mongoPathFor } from "../candidateApplication/canonicalMapping";
import {
  IMPORTANT_FIELD_QUESTIONS, MAX_ADAPTIVE_VENUE_QUESTIONS, MAX_OPEN_FIELD_QUESTIONS,
  importantFieldPaths, venueNeedsOperationalFollowUp,
} from "./domain";
import { isDecisionQuestion } from "./questionReconciliation";

// Progress describes the complete intake, not whichever gaps happen to be
// actionable after the latest answer/extraction. Never include AI-generated
// follow-ups in this denominator or persist synthetic clarification rows.
const CORE_FIELDS = IMPORTANT_FIELD_QUESTIONS.slice(0, MAX_ADAPTIVE_VENUE_QUESTIONS);
type Question = {
  id: string; issue_code: string; severity: string;
  canonical_paths: string[]; status: string;
};
const read = (proposal: Record<string, unknown>, path: string): unknown => {
  const mongoPath = mongoPathFor(path);
  return mongoPath?.split(".").reduce<unknown>((value, key) =>
    value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, proposal);
};
const filled = (value: unknown) => value !== undefined && value !== null &&
  (typeof value !== "string" || (value.trim() !== "" && value.trim().toLowerCase() !== "untitled proposal"));

export function buildIntakeProgress(proposal: Record<string, unknown>, questions: Question[]) {
  const ordinary = questions.filter(q => !isDecisionQuestion(q.issue_code, q.severity));
  const venuePath = "/content/venueSchedule/venueName";
  const venueName = read(proposal, venuePath);
  const venueStatus = read(proposal, "/content/venueSchedule/venueConfirmedStatus");
  const venueSelected = venueNeedsOperationalFollowUp(venueName, venueStatus);
  // An unanswered venue does NOT complete eleven future questions. Only an
  // explicit skip/undecided choice can defer the dependent operational intake.
  const venueDeferred = !venueSelected && (
    filled(venueName) || String(venueStatus).toLowerCase().replace(/_/g, " ") === "not selected" ||
    ordinary.some(q => q.canonical_paths?.includes(venuePath) && q.status === "dismissed")
  );
  const coreQuestionIds = new Set<string>();
  const items = CORE_FIELDS.map((field, index) => {
    const paths = importantFieldPaths(field);
    const matching = ordinary.filter(q => q.canonical_paths?.length > 0 &&
      q.canonical_paths.every(path => paths.includes(path)));
    matching.forEach(q => coreQuestionIds.add(q.id));
    const covers = (statuses: string[]) => paths.every(path => filled(read(proposal, path)) ||
      matching.some(q => statuses.includes(q.status) && q.canonical_paths.includes(path)));
    // Saved/confirmed proposal values are authoritative. Suggestions are not
    // input here: extracting a value alone must never pretend it was answered.
    const status = covers(["answered"])
      ? "answered" as const
      : covers(["answered", "dismissed"])
        ? "dismissed" as const
        : index >= MAX_OPEN_FIELD_QUESTIONS && venueDeferred
          ? "not_applicable" as const
          : "open" as const;
    return {
      key: field.path, paths, prompt: field.prompt, status,
      questionId: matching.find(q => q.status === "open")?.id ?? null,
    };
  });
  return {
    total: items.length,
    completed: items.filter(item => item.status !== "open").length,
    items,
    extraQuestionIds: questions.filter(q => !coreQuestionIds.has(q.id)).map(q => q.id),
  };
}
