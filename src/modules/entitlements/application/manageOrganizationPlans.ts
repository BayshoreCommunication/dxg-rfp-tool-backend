import {
  PLAN_IDS,
  entitlementsOf,
  isPlanExempt,
  planIdOf,
  planTable,
  type PlanId,
} from "../domain/plans";

/* Plan management (ORG-603, DXG decision Q2). RFPilot staff, signed in to the admin app with an
   `admins` account, see every customer organization's plan and RFP usage and change the plan.
   This is the only place a plan is raised: an organization's own members reach `plan` only
   through onboarding, which offers the self-service plans and never `full_access`. Every change
   writes an audit event in the organization whose plan changed. */

export const PLAN_AUDIT = { changed: "organization.plan_changed" } as const;

export class PlanManagementError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "PlanManagementError";
  }
}

/** A signed-in admin-app account. Role and account type come from the stored account. */
export type PlanStaff = { adminId: string; organizationId: string; role?: string; accountType?: string; correlationId: string };

const STAFF_ROLES = ["admin", "super_admin", "superadmin"];
export const isPlanStaff = (staff: Pick<PlanStaff, "role" | "accountType">) =>
  staff.accountType === "admin" && STAFF_ROLES.includes(String(staff.role ?? "").toLowerCase().trim().replace(/[\s-]/g, "_"));

export type OrganizationPlanRecord = {
  id: string;
  name: string;
  slug: string;
  status: string;
  kind: string;
  /** As stored: absent on rows older than plans, and never trusted to be a known plan. */
  plan: string | null;
  proposalsCreated: number | null;
  createdAt: Date | null;
};

export type PlanChangeRecord = {
  at: Date;
  actorId: string | null;
  fromPlan: string | null;
  toPlan: string | null;
  note: string | null;
};

export type PlanChangeAudit = {
  actorUserId: string;
  action: string;
  reason: string;
  correlationId: string;
  metadata: Record<string, unknown>;
};

export interface OrganizationPlanDirectory {
  // Customer organizations only: legacy holding tenants are exempt from plans and never listed.
  list(input: { search: string; skip: number; limit: number }): Promise<{ organizations: OrganizationPlanRecord[]; total: number }>;
  find(organizationId: string): Promise<OrganizationPlanRecord | null>;
  /* Sets the plan only while the stored plan is still `expectedPlan`, and writes the audit event
     in the same transaction, so a plan never changes without its event. Null when the
     organization is gone or its plan changed in the meantime. */
  changePlan(input: { organizationId: string; expectedPlan: string | null; plan: PlanId; audit: PlanChangeAudit }): Promise<OrganizationPlanRecord | null>;
  history(organizationId: string, limit: number): Promise<PlanChangeRecord[]>;
  staffNames(adminIds: readonly string[]): Promise<Map<string, string>>;
}

type Dependencies = {
  directory: OrganizationPlanDirectory;
  isValidId(value: string): boolean;
  env?: NodeJS.ProcessEnv;
};

const PER_PAGE = 20;
const HISTORY_LIMIT = 20;
const NOTE_MAX = 500;

const notFound = () => new PlanManagementError("ORGANIZATION_NOT_FOUND", "Organization not found.", 404);

const pageOf = (value: unknown) => {
  const parsed = Number.parseInt(String(value ?? "1"), 10);
  return Number.isNaN(parsed) || parsed < 1 ? 1 : Math.min(parsed, 10_000);
};

const parseNote = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new PlanManagementError("INVALID_PLAN_NOTE", "The note must be text.", 400);
  const note = value.trim();
  if (note.length > NOTE_MAX) throw new PlanManagementError("INVALID_PLAN_NOTE", `The note can be at most ${NOTE_MAX} characters.`, 400);
  return note || null;
};

export const createOrganizationPlanManagement = (dependencies: Dependencies) => {
  const { directory } = dependencies;
  const env = () => dependencies.env ?? process.env;

  const assertStaff = (staff: PlanStaff) => {
    if (!isPlanStaff(staff)) throw new PlanManagementError("PLAN_MANAGEMENT_FORBIDDEN", "Only RFPilot staff can do that.", 403);
  };

  const view = (organization: OrganizationPlanRecord) => {
    const { plan, proposals, features } = entitlementsOf(organization, env());
    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organization.status,
      createdAt: organization.createdAt,
      plan,
      proposals,
      features,
    };
  };

  const plans = () => {
    const table = planTable(env());
    return PLAN_IDS.map((id) => ({ id, proposalLimit: table[id].proposalLimit, features: table[id].features }));
  };

  // A holding tenant reads as missing: plans don't apply to it, and staff place it (ORG-110) first.
  const load = async (organizationId: string) => {
    if (!dependencies.isValidId(organizationId)) throw notFound();
    const organization = await directory.find(organizationId);
    if (!organization || isPlanExempt(organization)) throw notFound();
    return organization;
  };

  const historyOf = async (organizationId: string) => {
    const events = await directory.history(organizationId, HISTORY_LIMIT);
    const names = await directory.staffNames([...new Set(events.flatMap((event) => (event.actorId ? [event.actorId] : [])))]);
    return events.map((event) => ({
      at: event.at,
      fromPlan: event.fromPlan,
      toPlan: event.toPlan,
      note: event.note,
      changedBy: event.actorId ? { id: event.actorId, name: names.get(event.actorId) ?? null } : null,
    }));
  };

  return {
    async list(staff: PlanStaff, query: { page?: unknown; search?: unknown }) {
      assertStaff(staff);
      const page = pageOf(query.page);
      const search = String(query.search ?? "").trim().slice(0, 100);
      const { organizations, total } = await directory.list({ search, skip: (page - 1) * PER_PAGE, limit: PER_PAGE });
      const totalPages = Math.ceil(total / PER_PAGE) || 1;
      return {
        organizations: organizations.map(view),
        plans: plans(),
        pagination: { page, perPage: PER_PAGE, total, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 },
        filters: { search },
      };
    },

    async get(staff: PlanStaff, organizationId: string) {
      assertStaff(staff);
      const organization = await load(organizationId);
      return { organization: view(organization), plans: plans(), history: await historyOf(organization.id) };
    },

    /* Raising and lowering are both allowed. The gates read the plan on every request, so the
       change applies at once: after a downgrade the locked features are refused and RFP creation
       stops once the count is at the limit, while existing RFPs and stored vendor responses stay.
       AI jobs queued before a downgrade finish (DECISIONS 2026-11-10, ORG-603). */
    async change(staff: PlanStaff, organizationId: string, input: { plan?: unknown; note?: unknown }) {
      assertStaff(staff);
      if (!PLAN_IDS.includes(input.plan as PlanId)) {
        throw new PlanManagementError("INVALID_PLAN", `Choose one of these plans: ${PLAN_IDS.join(", ")}.`, 400);
      }
      const plan = input.plan as PlanId;
      const note = parseNote(input.note);
      const organization = await load(organizationId);
      const fromPlan = planIdOf(organization);
      if (fromPlan === plan) {
        return { organization: view(organization), plans: plans(), history: await historyOf(organization.id), changed: false };
      }
      const updated = await directory.changePlan({
        organizationId: organization.id,
        expectedPlan: organization.plan,
        plan,
        audit: {
          actorUserId: staff.adminId,
          action: PLAN_AUDIT.changed,
          reason: "staff_plan_change",
          correlationId: staff.correlationId,
          metadata: {
            fromPlan,
            toPlan: plan,
            proposalsCreated: Math.max(0, Math.floor(organization.proposalsCreated ?? 0)),
            actorAccountType: "admin",
            actorOrganizationId: staff.organizationId,
            ...(note ? { note } : {}),
          },
        },
      });
      if (!updated) {
        throw new PlanManagementError("PLAN_CHANGE_CONFLICT", "This organization's plan was just changed by someone else. Reload and try again.", 409);
      }
      return { organization: view(updated), plans: plans(), history: await historyOf(updated.id), changed: true };
    },
  };
};

export type OrganizationPlanManagement = ReturnType<typeof createOrganizationPlanManagement>;
