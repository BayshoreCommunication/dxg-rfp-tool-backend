import {
  ORGANIZATION_PLANS,
  parseOrganizationDetails,
  type OnboardingStep,
  type OrganizationDetails,
  type OrganizationDetailsUpdate,
  type OrganizationPlan,
} from "../domain/organizationDetails";

/* The organization's profile and its onboarding (ORG-301). Every new organization starts at
   "details": the Owner confirms the company details, picks a plan, may invite the team, and
   only then reaches the dashboard. Callers have already checked organization:manage for writes. */

export interface OrganizationProfileRecord extends OrganizationDetails {
  plan: OrganizationPlan;
  onboardingStep: OnboardingStep;
}

export interface OrganizationProfileDirectory {
  find(organizationId: string): Promise<OrganizationProfileRecord | null>;
  update(organizationId: string, changes: Partial<OrganizationProfileRecord>): Promise<void>;
}

export interface OrganizationProfileAudit {
  append(input: {
    organizationId?: string;
    actorUserId?: string;
    action: string;
    targetType: string;
    targetId?: string;
    decision: "allowed" | "denied" | "created" | "revoked" | "detected";
    reason: string;
    correlationId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

type Actor = { organizationId: string; actorUserId: string; correlationId: string };

export const createOrganizationProfile = (dependencies: {
  directory: OrganizationProfileDirectory;
  audit: OrganizationProfileAudit;
}) => {
  const { directory } = dependencies;

  const audit = (actor: Actor, reason: string, metadata: Record<string, unknown>) =>
    dependencies.audit.append({
      organizationId: actor.organizationId,
      actorUserId: actor.actorUserId,
      action: "organization.settings.updated",
      targetType: "organization",
      targetId: actor.organizationId,
      decision: "allowed",
      reason,
      correlationId: actor.correlationId,
      metadata,
    });

  const profile = async (organizationId: string) => directory.find(organizationId);

  /* Saves the details. During onboarding this also moves the organization on to the plan step. */
  const updateDetails = async (input: Actor & { details: Record<string, unknown> }) => {
    const parsed = parseOrganizationDetails(input.details);
    if (!parsed.ok) return { kind: "validation" as const, field: parsed.field };
    const current = await directory.find(input.organizationId);
    if (!current) return { kind: "not_found" as const };
    const onboarding = current.onboardingStep === "details";
    const changes: Partial<OrganizationProfileRecord> & OrganizationDetailsUpdate = { ...parsed.details };
    if (onboarding) changes.onboardingStep = "plan";
    await directory.update(input.organizationId, changes);
    await audit(input, onboarding ? "organization_onboarding_details" : "organization_details_updated", {
      setting: "details",
      fields: Object.keys(parsed.details),
    });
    return { kind: "updated" as const, profile: { ...current, ...changes } };
  };

  /* Onboarding only: picks the plan and moves on to inviting the team. Going back from the team
     step to change the plan is allowed; once onboarding is done the plan is billing's business. */
  const choosePlan = async (input: Actor & { plan: unknown }) => {
    if (!ORGANIZATION_PLANS.includes(input.plan as OrganizationPlan)) return { kind: "validation" as const };
    const current = await directory.find(input.organizationId);
    if (!current) return { kind: "not_found" as const };
    if (current.onboardingStep !== "plan" && current.onboardingStep !== "team") {
      return { kind: "wrong_step" as const, onboardingStep: current.onboardingStep };
    }
    // A plan assigned by RFPilot staff (ORG-603) isn't on the self-service list. The Owner's
    // onboarding choice must not replace it, so the step moves on and the stored plan stays.
    const staffAssigned = !ORGANIZATION_PLANS.includes(current.plan);
    const changes = {
      ...(staffAssigned ? {} : { plan: input.plan as OrganizationPlan }),
      onboardingStep: "team" as const,
    };
    await directory.update(input.organizationId, changes);
    await audit(input, "organization_onboarding_plan", { setting: "plan", plan: staffAssigned ? current.plan : input.plan, ...(staffAssigned ? { kept: true } : {}) });
    return { kind: "updated" as const, profile: { ...current, ...changes } };
  };

  /* Finishes onboarding from the team step (inviting is optional). Repeating it is a no-op. */
  const completeOnboarding = async (input: Actor) => {
    const current = await directory.find(input.organizationId);
    if (!current) return { kind: "not_found" as const };
    if (current.onboardingStep === "done") return { kind: "updated" as const, profile: current };
    if (current.onboardingStep !== "team") return { kind: "wrong_step" as const, onboardingStep: current.onboardingStep };
    await directory.update(input.organizationId, { onboardingStep: "done" });
    await audit(input, "organization_onboarding_completed", { setting: "onboarding" });
    return { kind: "updated" as const, profile: { ...current, onboardingStep: "done" as const } };
  };

  return { profile, updateDetails, choosePlan, completeOnboarding };
};
