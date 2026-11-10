/* Plan entitlements (ORG-601, DXG decision Q2). Pricing is by RFPs created, not seats. The plan
   table below is the only place a plan's limit and features are defined; the server enforces it
   on every create path and every gated route, so a client can't unlock anything by skipping a
   screen. Paid plans join the table as data once DXG defines them. */

export const PLAN_FEATURES = ["vendorResponses", "proposalIntelligence"] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

export const PLAN_IDS = ["free_trial", "full_access"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export type PlanDefinition = {
  /** RFPs an organization may create over its lifetime on this plan; null is no limit. */
  proposalLimit: number | null;
  features: Record<PlanFeature, boolean>;
};

export const FREE_TRIAL_PROPOSAL_LIMIT = 2;

/** Config: PLAN_FREE_TRIAL_PROPOSAL_LIMIT overrides the free-trial limit (a whole number ≥ 0). */
const freeTrialLimit = (env: NodeJS.ProcessEnv): number => {
  const raw = env.PLAN_FREE_TRIAL_PROPOSAL_LIMIT?.trim();
  if (!raw) return FREE_TRIAL_PROPOSAL_LIMIT;
  if (!/^\d{1,6}$/.test(raw)) throw new Error("PLAN_FREE_TRIAL_PROPOSAL_LIMIT must be a whole number of RFPs");
  return Number(raw);
};

export const planTable = (env: NodeJS.ProcessEnv = process.env): Record<PlanId, PlanDefinition> => ({
  free_trial: {
    proposalLimit: freeTrialLimit(env),
    features: { vendorResponses: false, proposalIntelligence: false },
  },
  // Assigned by DXG staff (ORG-603) until paid plans and checkout exist.
  full_access: {
    proposalLimit: null,
    features: { vendorResponses: true, proposalIntelligence: true },
  },
});

/** What the entitlement decisions read from an organization. Missing fields mean an older row. */
export type OrganizationPlanState = {
  kind?: string | null;
  plan?: string | null;
  proposalsCreated?: number | null;
};

const isPlanId = (value: unknown): value is PlanId => PLAN_IDS.includes(value as PlanId);

/** An absent or unknown plan is the free trial: an unrecognized value never unlocks anything. */
export const planIdOf = (organization: OrganizationPlanState): PlanId =>
  isPlanId(organization.plan) ? organization.plan : "free_trial";

/** Legacy holding tenants (ORG-107/110) keep the access they had before plans existed. */
export const isPlanExempt = (organization: OrganizationPlanState): boolean => organization.kind === "legacy_holding";

const createdCount = (organization: OrganizationPlanState): number =>
  typeof organization.proposalsCreated === "number" && organization.proposalsCreated > 0
    ? Math.floor(organization.proposalsCreated)
    : 0;

export const proposalLimitOf = (organization: OrganizationPlanState, env: NodeJS.ProcessEnv = process.env): number | null =>
  isPlanExempt(organization) ? null : planTable(env)[planIdOf(organization)].proposalLimit;

export const canCreateProposal = (organization: OrganizationPlanState, env: NodeJS.ProcessEnv = process.env): boolean => {
  const limit = proposalLimitOf(organization, env);
  return limit === null || createdCount(organization) < limit;
};

export const hasFeature = (
  organization: OrganizationPlanState,
  feature: PlanFeature,
  env: NodeJS.ProcessEnv = process.env,
): boolean => isPlanExempt(organization) || planTable(env)[planIdOf(organization)].features[feature] === true;

export type EntitlementSummary = {
  plan: PlanId;
  exempt: boolean;
  proposals: { created: number; limit: number | null; remaining: number | null; canCreate: boolean };
  features: Record<PlanFeature, boolean>;
};

export const entitlementsOf = (organization: OrganizationPlanState, env: NodeJS.ProcessEnv = process.env): EntitlementSummary => {
  const limit = proposalLimitOf(organization, env);
  const created = createdCount(organization);
  return {
    plan: planIdOf(organization),
    exempt: isPlanExempt(organization),
    proposals: {
      created,
      limit,
      remaining: limit === null ? null : Math.max(0, limit - created),
      canCreate: canCreateProposal(organization, env),
    },
    features: Object.fromEntries(PLAN_FEATURES.map((feature) => [feature, hasFeature(organization, feature, env)])) as Record<PlanFeature, boolean>,
  };
};

const FEATURE_LOCKED_MESSAGES: Record<PlanFeature, string> = {
  vendorResponses: "Vendor responses aren't included in your plan. Contact us to upgrade.",
  proposalIntelligence: "RFP intelligence isn't included in your plan. Contact us to upgrade.",
};

export const PLAN_LIMIT_REACHED = "PLAN_LIMIT_REACHED";
export const PLAN_FEATURE_LOCKED = "PLAN_FEATURE_LOCKED";
export const PLAN_ERROR_STATUS = 403;

export class PlanLimitReachedError extends Error {
  readonly status = PLAN_ERROR_STATUS;
  readonly code = PLAN_LIMIT_REACHED;
  constructor(readonly plan: PlanId, readonly limit: number, readonly created: number) {
    super(`Your plan includes ${limit} ${limit === 1 ? "RFP" : "RFPs"} and your organization has created ${created}. Contact us to upgrade.`);
    this.name = "PlanLimitReachedError";
  }
}

export class PlanFeatureLockedError extends Error {
  readonly status = PLAN_ERROR_STATUS;
  readonly code = PLAN_FEATURE_LOCKED;
  constructor(readonly plan: PlanId, readonly feature: PlanFeature) {
    super(FEATURE_LOCKED_MESSAGES[feature]);
    this.name = "PlanFeatureLockedError";
  }
}
