// ORG-407: the organization audit log an Owner or Admin reads (PRD P0-10).
// The view is an allowlist: only the actions catalogued here are shown, so an event written for
// another purpose (token rotation, staff bookkeeping) never appears because someone forgot to hide it.

export class AuditLogError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "AuditLogError";
  }
}

export type AuditLogActor = { organizationId: string; userId: string; roles: readonly string[] };

export const AUDIT_CATEGORIES = [
  { key: "sign_in", label: "Sign-in" },
  { key: "two_factor", label: "Two-factor authentication" },
  { key: "invitations", label: "Invitations" },
  { key: "members", label: "Members and roles" },
  { key: "teams", label: "Teams" },
  { key: "sharing", label: "RFP sharing" },
  { key: "support_access", label: "RFPilot Support access" },
  { key: "settings", label: "Organization settings" },
  { key: "vendor_list", label: "Vendor list" },
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number]["key"];

type CatalogEntry = { category: AuditCategory; label: string; staffActor?: true };

// `staffActor` marks events whose actorUserId is an `admins` id (RFPilot Support), not a member.
export const AUDIT_CATALOG: Readonly<Record<string, CatalogEntry>> = {
  "auth.session.created": { category: "sign_in", label: "Signed in" },
  "auth.login.failed": { category: "sign_in", label: "Sign-in failed" },
  "auth.session.revoked": { category: "sign_in", label: "Session ended" },
  "auth.sessions.revoked_all": { category: "sign_in", label: "All sessions signed out" },
  "auth.sessions.revoked_others": { category: "sign_in", label: "Other sessions signed out" },
  "auth.refresh.reuse_detected": { category: "sign_in", label: "Session reuse detected" },

  "auth.two_factor.enrolled": { category: "two_factor", label: "Two-factor turned on" },
  "auth.two_factor.disabled": { category: "two_factor", label: "Two-factor turned off" },
  "auth.two_factor.reset": { category: "two_factor", label: "Two-factor reset by an admin" },
  "auth.two_factor.challenge_failed": { category: "two_factor", label: "Two-factor code rejected" },
  "auth.two_factor.recovery_code_used": { category: "two_factor", label: "Recovery code used" },
  "auth.two_factor.recovery_codes_regenerated": { category: "two_factor", label: "Recovery codes regenerated" },

  "organization.invitation.sent": { category: "invitations", label: "Invitation sent" },
  "organization.invitation.resent": { category: "invitations", label: "Invitation resent" },
  "organization.invitation.accepted": { category: "invitations", label: "Invitation accepted" },
  "organization.invitation.revoked": { category: "invitations", label: "Invitation revoked" },
  "organization.access_request.created": { category: "invitations", label: "Access requested" },
  "organization.access_request.approved": { category: "invitations", label: "Access request approved" },
  "organization.access_request.auto_approved": { category: "invitations", label: "Access request auto-approved" },
  "organization.access_request.denied": { category: "invitations", label: "Access request denied" },

  "organization.member.role_changed": { category: "members", label: "Role changed" },
  "organization.member.teams_changed": { category: "members", label: "Teams changed" },
  "organization.member.deactivated": { category: "members", label: "Member deactivated" },
  "organization.member.reactivated": { category: "members", label: "Member reactivated" },
  "organization.member.sso_joined": { category: "members", label: "Member joined through company sign-in" },
  "organization.ownership.transferred": { category: "members", label: "Ownership transferred" },
  "proposal.owner.reassigned": { category: "members", label: "RFP owner reassigned" },
  "organization.legacy_customer.placed": { category: "members", label: "Member placed by RFPilot Support", staffActor: true },
  "organization.legacy_customer.placement_rolled_back": { category: "members", label: "Member placement undone by RFPilot Support", staffActor: true },

  "team.created": { category: "teams", label: "Team created" },
  "team.renamed": { category: "teams", label: "Team renamed" },
  "team.archived": { category: "teams", label: "Team archived" },
  "team.manager_changed": { category: "teams", label: "Team manager changed" },
  "team.member_added": { category: "teams", label: "Team member added" },
  "team.member_removed": { category: "teams", label: "Team member removed" },

  "proposal.share_granted": { category: "sharing", label: "RFP shared" },
  "proposal.share_revoked": { category: "sharing", label: "RFP share removed" },

  "support_access.granted": { category: "support_access", label: "Support access granted" },
  "support_access.revoked": { category: "support_access", label: "Support access revoked" },
  "support_access.used": { category: "support_access", label: "Support access used", staffActor: true },
  "support_access.denied": { category: "support_access", label: "Support access refused", staffActor: true },

  "organization.settings.updated": { category: "settings", label: "Organization settings changed" },
  // ORG-603: RFPilot staff change an organization's plan in the admin app.
  "organization.plan_changed": { category: "settings", label: "Plan changed by RFPilot Support", staffActor: true },
  "organization.domain.added": { category: "settings", label: "Domain added" },
  "organization.domain.verified": { category: "settings", label: "Domain verified" },
  "organization.domain.unverified": { category: "settings", label: "Domain no longer verified" },
  "organization.domain.removed": { category: "settings", label: "Domain removed" },
  "organization.sso.updated": { category: "settings", label: "Company sign-in settings saved" },
  "organization.sso.tested": { category: "settings", label: "Company sign-in tested" },
  "organization.sso.enabled": { category: "settings", label: "Company sign-in turned on" },
  "organization.sso.disabled": { category: "settings", label: "Company sign-in turned off" },
  "organization.sso.deleted": { category: "settings", label: "Company sign-in removed" },

  "organization_vendor.created": { category: "vendor_list", label: "Vendor added" },
  "organization_vendor.updated": { category: "vendor_list", label: "Vendor updated" },
  "organization_vendor.archived": { category: "vendor_list", label: "Vendor archived" },
  "organization_vendor.restored": { category: "vendor_list", label: "Vendor restored" },
};

// Own entries only: "constructor" or "__proto__" as an action name is not in the catalog.
export const catalogEntry = (action: string): CatalogEntry | undefined =>
  Object.prototype.hasOwnProperty.call(AUDIT_CATALOG, action) ? AUDIT_CATALOG[action] : undefined;

export const VISIBLE_ACTIONS: readonly string[] = Object.keys(AUDIT_CATALOG);
export const STAFF_ACTIONS: readonly string[] = VISIBLE_ACTIONS.filter((action) => AUDIT_CATALOG[action].staffActor);
export const MEMBER_ACTIONS: readonly string[] = VISIBLE_ACTIONS.filter((action) => !AUDIT_CATALOG[action].staffActor);
export const SUPPORT_ACTOR_LABEL = "RFPilot Support";

// Metadata keys a customer may read. Everything else a writer stored stays internal.
const DETAIL_KEYS = new Set([
  "role", "previousRole", "newOwnerPreviousRole", "previousOwnerNewRole", "previousStatus",
  "setting", "from", "to", "value", "scope", "operation", "domain", "expiresAt", "method",
  "reauthentication", "recoveryCodesRemaining", "revokedSessions", "signedOutMembers", "placedInTeam",
  "teamId", "grantId", "ticketId", "proposalId", "contactCount",
  "fromPlan", "toPlan",
]);
const MACHINE_CODE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;

export type AuditDetailValue = string | number | boolean;

// Scalars only, and never an email address: audit rows carry ids, not contact details.
export const visibleDetails = (metadata: unknown): Record<string, AuditDetailValue> => {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return {};
  const details: Record<string, AuditDetailValue> = {};
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (!DETAIL_KEYS.has(key)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) details[key] = value;
    else if (typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("@")) details[key] = value;
  }
  return details;
};

// Writers store a machine code in `reason`; staff-entered free text is not shown to customers.
export const visibleReason = (reason: unknown): string | null =>
  typeof reason === "string" && MACHINE_CODE.test(reason) ? reason : null;

export type StoredAuditEvent = {
  id: string;
  action: string;
  actorUserId: string | null;
  targetType: string;
  targetId: string | null;
  decision: string;
  reason: string;
  metadata: unknown;
  createdAt: Date;
};

export type AuditEventFilter = {
  actions: readonly string[];
  actorUserId?: string;
  from?: Date;
  // Exclusive.
  to?: Date;
  before?: { createdAt: Date; id: string };
};

// Every method names the organization; there is no read that spans organizations.
export interface AuditEventReader {
  list(organizationId: string, filter: AuditEventFilter, limit: number): Promise<StoredAuditEvent[]>;
  // Members of this organization only (any status), keyed by user id. Never consults `admins`.
  memberNames(organizationId: string, userIds: readonly string[]): Promise<Map<string, { name: string; email: string }>>;
  isValidId(value: string): boolean;
}

export type AuditEventActor =
  | { kind: "member"; id: string; name: string; email: string }
  | { kind: "support"; id: string | null; name: typeof SUPPORT_ACTOR_LABEL }
  | { kind: "unknown"; id: string; name: "Unknown user" }
  | { kind: "system"; id: null; name: "System" };

export type AuditEventView = {
  id: string;
  occurredAt: string;
  action: string;
  label: string;
  category: AuditCategory;
  decision: string;
  reason: string | null;
  actor: AuditEventActor;
  target: { type: string; id: string | null; name: string | null };
  details: Record<string, AuditDetailValue>;
};

// ── CSV ──────────────────────────────────────────────────────────────────────────────────────
// A cell that a spreadsheet would run as a formula is prefixed with an apostrophe (OWASP CSV
// injection): leading = + - @, a tab or a carriage return, also behind leading spaces.
const FORMULA_LEAD = /^\s*[=+\-@]|^[\t\r]/;
export const csvCell = (value: unknown): string => {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = FORMULA_LEAD.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
};

export const AUDIT_CSV_HEADER = [
  "Time (UTC)", "Action", "Category", "Result", "Actor", "Actor email", "Actor type",
  "Target type", "Target", "Reason", "Details", "Event ID",
] as const;

const categoryLabel = (key: AuditCategory) => AUDIT_CATEGORIES.find((category) => category.key === key)?.label ?? key;

export const auditCsv = (events: readonly AuditEventView[]): string => {
  const rows = events.map((event) => [
    event.occurredAt,
    event.label,
    categoryLabel(event.category),
    event.decision,
    event.actor.name,
    event.actor.kind === "member" ? event.actor.email : "",
    event.actor.kind,
    event.target.type,
    event.target.name ?? event.target.id ?? "",
    event.reason ?? "",
    Object.entries(event.details).map(([key, value]) => `${key}: ${value}`).join("; "),
    event.id,
  ]);
  return [AUDIT_CSV_HEADER, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
};
