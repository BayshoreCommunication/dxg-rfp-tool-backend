import { entitlementsOf } from "../domain/plans";
import {
  PlanManagementError,
  isPlanStaff,
  type OrganizationPlanDirectory,
  type OrganizationPlanRecord,
  type PlanStaff,
} from "./manageOrganizationPlans";

/* Organization account detail for RFPilot staff (owner decision, 2026-11-17). This view carries
   account-level information only: no member list and no customer content (proposals, vendors,
   templates, ticket text); the vendor list and templates are not even counted. (A later decision
   of the same day lets staff read the member list and content with no grant; that is a separate
   set of read routes, src/modules/staffAccess, and this view is unchanged.) It is an allowlist built field by
   field from counts, settings and timestamps. The one person it names is the Owner, who is the
   account contact. Each read is recorded in the staff organization's audit trail, never in the
   customer's. */

export const ORGANIZATION_ACCOUNT_AUDIT = { read: "platform.organization_account.read" } as const;

const MEMBER_ROLES = ["owner", "organization_admin", "team_manager", "planner", "viewer"] as const;
type MemberRole = (typeof MEMBER_ROLES)[number];

/** The organization row: identity, plan state and the settings the Owner or an Admin chose. */
export type OrganizationAccountRecord = OrganizationPlanRecord & {
  country: string | null;
  requireTwoFactor: boolean;
  requireSso: boolean;
  allowManagerInvites: boolean;
  autoApproveDomain: boolean;
};

/** Counts, settings and timestamps only. Nothing here is a member row or customer content. */
export type OrganizationAccountFacts = {
  owner: { name: string; email: string } | null;
  /** Active and deactivated memberships grouped by status and role set. */
  memberGroups: Array<{ status: string; roles: string[]; count: number; lastSignedInAt: Date | null }>;
  teams: { active: number; archived: number };
  /** How many proposals the organization has stored. */
  proposals: number;
  openSupportTickets: number;
  domains: Array<{ domain: string; status: string }>;
  /** The company SSO connection's status, or null when there is none. */
  ssoStatus: string | null;
  /** `admins` accounts that live in this organization: more than zero makes it RFPilot's own. */
  staffAccounts: number;
  hasActiveGrant: boolean;
};

export interface OrganizationAccountSource {
  find(organizationId: string): Promise<OrganizationAccountRecord | null>;
  facts(organizationId: string, now: Date): Promise<OrganizationAccountFacts>;
}

export type OrganizationAccountAudit = {
  append(input: {
    organizationId: string;
    actorUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    decision: "allowed";
    reason: string;
    correlationId: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
};

type Dependencies = {
  source: OrganizationAccountSource;
  planHistory: Pick<OrganizationPlanDirectory, "history" | "staffNames">;
  audit: OrganizationAccountAudit;
  isValidId(value: string): boolean;
  passwordSignInEnabled?: () => boolean;
  clock?: () => Date;
  env?: NodeJS.ProcessEnv;
};

const standingOf = (organization: OrganizationAccountRecord, staffAccounts: number) => {
  if (organization.kind === "legacy_holding") return "awaiting_placement" as const;
  if (staffAccounts > 0) return "platform" as const;
  return organization.status === "active" ? ("active" as const) : ("inactive" as const);
};

const memberCounts = (groups: OrganizationAccountFacts["memberGroups"]) => {
  const byRole = Object.fromEntries(MEMBER_ROLES.map((role) => [role, 0])) as Record<MemberRole, number>;
  let active = 0;
  let deactivated = 0;
  let otherRoles = 0;
  let lastSignInAt: Date | null = null;
  for (const group of groups) {
    if (group.lastSignedInAt && (!lastSignInAt || group.lastSignedInAt > lastSignInAt)) lastSignInAt = group.lastSignedInAt;
    if (group.status === "suspended") deactivated += group.count;
    if (group.status !== "active") continue;
    active += group.count;
    const customerRoles = MEMBER_ROLES.filter((role) => group.roles.includes(role));
    for (const role of customerRoles) byRole[role] += group.count;
    if (customerRoles.length === 0) otherRoles += group.count;
  }
  return { active, deactivated, byRole, otherRoles, lastSignInAt };
};

export const createOrganizationAccountDetail = (dependencies: Dependencies) => {
  const { source, planHistory, audit } = dependencies;
  const env = () => dependencies.env ?? process.env;
  const now = () => (dependencies.clock ? dependencies.clock() : new Date());

  const lastPlanChange = async (organizationId: string) => {
    const [event] = await planHistory.history(organizationId, 1);
    if (!event) return null;
    const names = event.actorId ? await planHistory.staffNames([event.actorId]) : new Map<string, string>();
    return {
      at: event.at,
      fromPlan: event.fromPlan,
      toPlan: event.toPlan,
      changedBy: event.actorId ? { id: event.actorId, name: names.get(event.actorId) ?? null } : null,
    };
  };

  return {
    async get(staff: PlanStaff, organizationId: string) {
      if (!isPlanStaff(staff)) throw new PlanManagementError("PLAN_MANAGEMENT_FORBIDDEN", "Only RFPilot staff can do that.", 403);
      if (!dependencies.isValidId(organizationId)) {
        throw new PlanManagementError("INVALID_ORGANIZATION_ID", "That is not an organization id.", 400);
      }
      const organization = await source.find(organizationId);
      if (!organization) throw new PlanManagementError("ORGANIZATION_NOT_FOUND", "Organization not found.", 404);

      // Recorded before anything is returned, in the staff organization: the customer's audit log
      // has no entry for this read. If the event can't be written the read fails.
      await audit.append({
        organizationId: staff.organizationId,
        actorUserId: staff.adminId,
        action: ORGANIZATION_ACCOUNT_AUDIT.read,
        targetType: "organization",
        targetId: organization.id,
        decision: "allowed",
        reason: "organization_account_detail",
        correlationId: staff.correlationId,
        metadata: { agentAccountType: "admin" },
      });

      const [facts, planChange] = await Promise.all([source.facts(organization.id, now()), lastPlanChange(organization.id)]);
      const entitlements = entitlementsOf(organization, env());
      const members = memberCounts(facts.memberGroups);
      const ssoEnabled = facts.ssoStatus === "active";
      const passwordEnabled = dependencies.passwordSignInEnabled ? dependencies.passwordSignInEnabled() : true;

      return {
        organization: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          createdAt: organization.createdAt,
          country: organization.country,
          status: organization.status,
          kind: organization.kind,
          standing: standingOf(organization, facts.staffAccounts),
        },
        owner: facts.owner ? { name: facts.owner.name, email: facts.owner.email } : null,
        plan: {
          plan: entitlements.plan,
          exempt: entitlements.exempt,
          proposals: {
            created: entitlements.proposals.created,
            limit: entitlements.proposals.limit,
            remaining: entitlements.proposals.remaining,
            canCreate: entitlements.proposals.canCreate,
          },
          features: {
            vendorResponses: entitlements.features.vendorResponses,
            proposalIntelligence: entitlements.features.proposalIntelligence,
          },
          lastChange: planChange,
        },
        counts: {
          members: {
            active: members.active,
            deactivated: members.deactivated,
            byRole: { ...members.byRole, other: members.otherRoles },
          },
          teams: { active: facts.teams.active, archived: facts.teams.archived },
          proposals: { total: facts.proposals },
          openSupportTickets: facts.openSupportTickets,
        },
        security: {
          signInMethods: [...(passwordEnabled ? ["password"] : []), "google", "microsoft", ...(ssoEnabled ? ["company_sso"] : [])],
          requireTwoFactor: organization.requireTwoFactor,
          companySso: {
            configured: facts.ssoStatus !== null,
            enabled: ssoEnabled,
            required: organization.requireSso,
            type: facts.ssoStatus !== null ? ("oidc" as const) : null,
          },
          domains: facts.domains.map((row) => ({ domain: row.domain, status: row.status })),
          autoApproveDomain: organization.autoApproveDomain,
          allowManagerInvites: organization.allowManagerInvites,
        },
        activity: { lastSignInAt: members.lastSignInAt },
        supportAccess: { active: facts.hasActiveGrant === true },
      };
    },
  };
};

export type OrganizationAccountDetail = ReturnType<typeof createOrganizationAccountDetail>;
