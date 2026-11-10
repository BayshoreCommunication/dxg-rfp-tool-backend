import {
  deriveLifecycleStage,
  isPublished,
  isTransition,
  type LifecycleActor,
  type LifecycleReason,
  type LifecycleStage,
  type ProposalLifecycleFacts,
  type ProposalLifecycleState,
} from "./domain";

export type ProposalRef = { organizationId: string; proposalId: string };

export type LifecycleSnapshot = { facts: ProposalLifecycleFacts; state: ProposalLifecycleState };

export type TransitionRecord = {
  fromStage: LifecycleStage | null;
  toStage: LifecycleStage;
  fromStatus: string | null;
  toStatus: string | null;
  actor: LifecycleActor;
  reason: LifecycleReason;
  at: Date;
};

export type StoredTransition = Omit<TransitionRecord, "actor"> & { actorType: LifecycleActor["type"]; actorUserId: string | null };

export interface ProposalLifecycleRepository {
  load(ref: ProposalRef): Promise<LifecycleSnapshot | null>;
  // Oldest first.
  listTransitions(ref: ProposalRef): Promise<StoredTransition[]>;
  countVendorsResponded(ref: ProposalRef): Promise<number>;
  countVendorsInvited(ref: ProposalRef): Promise<number>;
  // Compare-and-set: writes `next` only if the proposal still matches `expected`, and inserts the
  // transition (when given) in the same transaction. Returns false when another writer got there
  // first, so the caller reloads and tries again.
  apply(input: ProposalRef & { expected: LifecycleSnapshot; next: ProposalLifecycleState; transition: TransitionRecord | null }): Promise<boolean>;
}

type Change = (current: LifecycleSnapshot) => Partial<ProposalLifecycleState> | null;

export type SyncInput = ProposalRef & {
  actor: LifecycleActor;
  reason: LifecycleReason;
  recount?: ReadonlyArray<"invited" | "responded">;
  change?: Change;
};

export type SyncResult = { stage: LifecycleStage; transitioned: boolean; state: ProposalLifecycleState };

// What Postgres knows about an RFP's vendor comparisons, used to rebuild review and award facts
// for proposals that predate ORG-403.
export type ComparisonHistory = {
  firstRunAt: Date | null;
  latestDecision: { decisionType: "shortlist" | "selection" | "no_award"; decisionId: string; at: Date; actorUserId: string | null } | null;
};

// Fills only what is missing, so a re-run never moves an award or review start a planner or a
// live hook already recorded.
export const backfillChange = (comparisons: ComparisonHistory | null) => ({ state }: LifecycleSnapshot): Partial<ProposalLifecycleState> | null => {
  if (!comparisons) return null;
  const change: Partial<ProposalLifecycleState> = {};
  if (!state.reviewStartedAt && comparisons.firstRunAt) change.reviewStartedAt = comparisons.firstRunAt;
  const decision = comparisons.latestDecision;
  if (!state.awardedAt && !state.awardSource && decision?.decisionType === "selection") {
    change.awardedAt = decision.at;
    change.awardedByUserId = decision.actorUserId;
    change.awardSource = "comparison";
    change.awardDecisionId = decision.decisionId;
  }
  return Object.keys(change).length ? change : null;
};

const MAX_ATTEMPTS = 4;

export class ProposalLifecycleConflictError extends Error {
  readonly code = "PROPOSAL_LIFECYCLE_CONFLICT";
  constructor() {
    super("The proposal changed repeatedly while its lifecycle was being recorded");
    this.name = "ProposalLifecycleConflictError";
  }
}

export const createProposalLifecycle = (dependencies: {
  repository: ProposalLifecycleRepository;
  now?: () => Date;
  onSyncFailure?: (error: unknown, input: SyncInput) => void;
}) => {
  const now = dependencies.now ?? (() => new Date());

  const sync = async (input: SyncInput): Promise<SyncResult | null> => {
    const ref = { organizationId: input.organizationId, proposalId: input.proposalId };
    // Counts come from their own collections and don't depend on the proposal row, so they are
    // read once rather than on every retry.
    const counts: Partial<ProposalLifecycleState> = {};
    if (input.recount?.includes("responded")) counts.vendorsResponded = await dependencies.repository.countVendorsResponded(ref);
    if (input.recount?.includes("invited")) counts.vendorsInvited = await dependencies.repository.countVendorsInvited(ref);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const current = await dependencies.repository.load(ref);
      if (!current) return null;
      const at = now();
      const next: ProposalLifecycleState = { ...current.state, ...counts, ...(input.change?.(current) ?? {}) };
      const stage = deriveLifecycleStage(current.facts, next);
      const status = current.facts.status ?? null;
      const transitioned = isTransition(current.state, stage, status);
      next.stage = stage;
      next.status = status;
      next.revision = (current.state.revision ?? 0) + 1;
      if (transitioned) next.changedAt = at;
      const transition = transitioned
        ? {
            fromStage: current.state.stage ?? null,
            toStage: stage,
            fromStatus: current.state.status ?? null,
            toStatus: status,
            actor: input.actor,
            reason: input.reason,
            at,
          }
        : null;
      if (await dependencies.repository.apply({ ...ref, expected: current, next, transition })) {
        return { stage, transitioned, state: next };
      }
    }
    throw new ProposalLifecycleConflictError();
  };

  // For hooks after a write that already succeeded: the primary operation must not fail because
  // its history could not be written. The failure is logged, and the backfill script repairs any
  // proposal whose stored stage has drifted.
  const record = async (input: SyncInput): Promise<SyncResult | null> => {
    try {
      return await sync(input);
    } catch (error) {
      dependencies.onSyncFailure?.(error, input);
      return null;
    }
  };

  return {
    sync,
    record,

    history: async (ref: ProposalRef) => {
      const current = await dependencies.repository.load(ref);
      if (!current) return null;
      return {
        stage: current.state.stage ?? deriveLifecycleStage(current.facts, current.state),
        lifecycle: current.state,
        transitions: await dependencies.repository.listTransitions(ref),
      };
    },

    // A vendor comparison was opened: the RFP is under review from now on, even if the run is
    // later cancelled (the planner started reviewing). Earlier start times are kept.
    markReviewStarted: (input: ProposalRef & { actor: LifecycleActor }) =>
      record({
        ...input,
        reason: "review_started",
        change: ({ state }) => (state.reviewStartedAt ? null : { reviewStartedAt: now() }),
      }),

    // The newest comparison decision decides a comparison-sourced award: a final selection awards
    // the RFP, any later shortlist or no-award decision withdraws that award. A planner's own
    // award is never overridden by a comparison.
    applyComparisonDecision: (input: ProposalRef & {
      actor: LifecycleActor;
      decisionType: "shortlist" | "selection" | "no_award";
      decisionId: string;
    }) =>
      record({
        ...input,
        reason: "comparison_decision",
        change: ({ state }) => {
          if (state.awardSource === "manual") return null;
          if (input.decisionType === "selection") {
            return {
              awardedAt: state.awardSource === "comparison" && state.awardedAt ? state.awardedAt : now(),
              awardedByUserId: input.actor.type === "user" ? input.actor.userId : null,
              awardSource: "comparison",
              awardDecisionId: input.decisionId,
            };
          }
          return state.awardSource === "comparison" ? CLEARED_AWARD : null;
        },
      }),

    // The planner's explicit "Mark as awarded". Only a published, unarchived RFP can be awarded.
    markAwarded: async (input: ProposalRef & { userId: string }) => {
      const current = await dependencies.repository.load(input);
      if (!current) return { kind: "not_found" as const };
      if (!isPublished(current.facts) || current.facts.isArchived === true) return { kind: "not_awardable" as const };
      const result = await sync({
        ...input,
        actor: { type: "user", userId: input.userId },
        reason: "awarded",
        change: ({ state, facts }) =>
          !isPublished(facts) || facts.isArchived === true || state.awardSource === "manual"
            ? null
            : { awardedAt: now(), awardedByUserId: input.userId, awardSource: "manual", awardDecisionId: null },
      });
      if (!result) return { kind: "not_found" as const };
      if (result.stage !== "awarded") return { kind: "not_awardable" as const };
      return { kind: "awarded" as const, lifecycle: result.state };
    },

    clearAward: async (input: ProposalRef & { userId: string }) => {
      const result = await sync({
        ...input,
        actor: { type: "user", userId: input.userId },
        reason: "award_cleared",
        change: ({ state }) => (state.awardedAt ? CLEARED_AWARD : null),
      });
      return result ? { kind: "cleared" as const, lifecycle: result.state } : { kind: "not_found" as const };
    },
  };
};

const CLEARED_AWARD: Partial<ProposalLifecycleState> = {
  awardedAt: null,
  awardedByUserId: null,
  awardSource: null,
  awardDecisionId: null,
};

export type ProposalLifecycle = ReturnType<typeof createProposalLifecycle>;
