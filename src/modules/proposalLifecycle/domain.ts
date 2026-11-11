// ORG-403: an RFP's lifecycle stage as planners see it on their dashboards (PRD P0-8), and the
// append-only history of how it got there (P0-10).
//
// The stage is always derived from stored facts by deriveLifecycleStage, never set directly, so
// every write path converges on the same answer. Awarding is an explicit planner action, or a
// final "selection" recorded in a vendor comparison; "under review" starts when a comparison is
// opened (decision 2026-11-09, docs/DECISIONS.md).

export const LIFECYCLE_STAGES = [
  "draft",
  "sent",
  "receiving_responses",
  "under_review",
  "awarded",
  "archived",
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const AWARD_SOURCES = ["manual", "comparison"] as const;
export type AwardSource = (typeof AWARD_SOURCES)[number];

// What triggered a sync. Stored on each transition so the history says why a stage moved.
export const LIFECYCLE_REASONS = [
  "created",
  "copied",
  "updated",
  "status_changed",
  "metadata_changed",
  "archived",
  "restored",
  "expired",
  "vendor_invited",
  "vendor_responded",
  "vendor_response_deleted",
  "review_started",
  "comparison_decision",
  "awarded",
  "award_cleared",
  "backfill",
] as const;
export type LifecycleReason = (typeof LIFECYCLE_REASONS)[number];

export const LIFECYCLE_ACTOR_TYPES = ["user", "vendor", "system"] as const;
export type LifecycleActor =
  | { type: "user"; userId: string }
  | { type: "vendor" }
  | { type: "system" };

// The proposal fields the stage is derived from.
export type ProposalLifecycleFacts = {
  status?: string | null;
  isDraft?: boolean | null;
  isArchived?: boolean | null;
};

// Denormalized on the proposal (Proposal.lifecycle) so dashboards filter and count by stage with
// an index instead of joining vendor, invitation and comparison data per request (ORG-401).
export type ProposalLifecycleState = {
  // Bumped on every write; the compare-and-set token that stops two concurrent syncs from
  // overwriting each other's counts or award fields.
  revision?: number;
  stage?: LifecycleStage | null;
  // Proposal.status as of the last recorded transition, so a status change that leaves the stage
  // alone (the expiry cron's submitted -> rejected) is still recorded.
  status?: string | null;
  changedAt?: Date | null;
  awardedAt?: Date | null;
  awardedByUserId?: string | null;
  awardSource?: AwardSource | null;
  awardDecisionId?: string | null;
  reviewStartedAt?: Date | null;
  vendorsInvited?: number;
  vendorsResponded?: number;
};

export const isPublished = (facts: ProposalLifecycleFacts): boolean =>
  facts.isDraft !== true && (facts.status ?? "unsubmitted") !== "unsubmitted";

// Precedence matters: archiving hides everything else, a draft has no vendor activity that
// counts, and awarding outranks an open review.
export const deriveLifecycleStage = (
  facts: ProposalLifecycleFacts,
  state: ProposalLifecycleState,
): LifecycleStage => {
  if (facts.isArchived === true) return "archived";
  if (!isPublished(facts)) return "draft";
  if (state.awardedAt) return "awarded";
  if (state.reviewStartedAt) return "under_review";
  if ((state.vendorsResponded ?? 0) > 0) return "receiving_responses";
  return "sent";
};

// A transition is recorded when the stage moves, or when the raw status moves under an unchanged
// stage. The first sync of a proposal (no recorded stage yet) always records one.
export const isTransition = (
  previous: ProposalLifecycleState,
  nextStage: LifecycleStage,
  nextStatus: string | null,
): boolean =>
  !previous.stage || previous.stage !== nextStage || (previous.status ?? null) !== nextStatus;
