import type { RfpActor, RfpRef } from "../identity/domain/rfpAccessPolicy";

// ORG-404 (PRD P0-9). RFPilot Support is DXG staff signed in to the admin app with an `admins`
// account. They sit outside every customer organization and read its RFP data only under an
// active grant issued by that organization's Owner or Admin.

export class SupportAccessError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "SupportAccessError";
  }
}

export const SUPPORT_GRANT_DEFAULT_DAYS = 7;
export const SUPPORT_GRANT_MAX_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const SUPPORT_AUDIT = {
  granted: "support_access.granted",
  revoked: "support_access.revoked",
  used: "support_access.used",
  denied: "support_access.denied",
} as const;

export type SupportGrantRecord = {
  id: string;
  organizationId: string;
  /** null: the whole organization. */
  proposalId: string | null;
  grantedBy: string;
  reason: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
};

export type SupportGrantStatus = "active" | "expired" | "revoked";

export const grantStatus = (grant: Pick<SupportGrantRecord, "expiresAt" | "revokedAt">, now: Date): SupportGrantStatus =>
  grant.revokedAt ? "revoked" : grant.expiresAt.getTime() <= now.getTime() ? "expired" : "active";

export const isGrantActive = (grant: Pick<SupportGrantRecord, "expiresAt" | "revokedAt">, now: Date) =>
  grantStatus(grant, now) === "active";

// The grant that lets Support read one RFP: a grant for exactly that RFP wins over an
// organization-wide one, so the audit trail names the narrowest permission that applied.
export const coveringGrant = (
  grants: readonly SupportGrantRecord[],
  organizationId: string,
  proposalId: string,
  now: Date,
): SupportGrantRecord | null => {
  const active = grants.filter((grant) => grant.organizationId === organizationId && isGrantActive(grant, now));
  return active.find((grant) => grant.proposalId === proposalId) ?? active.find((grant) => grant.proposalId === null) ?? null;
};

const invalidExpiry = (message: string) => new SupportAccessError("INVALID_GRANT_EXPIRY", message, 400);

// Expiry is `expiresInDays` (whole days, 1 to 30) or an `expiresAt` instant; seven days when
// neither is given. Nothing past thirty days from now is accepted.
export const resolveGrantExpiry = (input: { expiresInDays?: unknown; expiresAt?: unknown }, now: Date): Date => {
  const hasDays = input.expiresInDays !== undefined && input.expiresInDays !== null && input.expiresInDays !== "";
  const hasInstant = input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== "";
  if (hasDays && hasInstant) throw invalidExpiry("Give expiresInDays or expiresAt, not both.");
  if (hasInstant) {
    const at = typeof input.expiresAt === "string" || input.expiresAt instanceof Date ? new Date(input.expiresAt) : new Date(Number.NaN);
    if (Number.isNaN(at.getTime())) throw invalidExpiry("expiresAt must be a date and time.");
    if (at.getTime() <= now.getTime()) throw invalidExpiry("The expiry must be in the future.");
    if (at.getTime() > now.getTime() + SUPPORT_GRANT_MAX_DAYS * DAY_MS) {
      throw invalidExpiry(`Support access can last at most ${SUPPORT_GRANT_MAX_DAYS} days.`);
    }
    return at;
  }
  const days = hasDays ? Number(input.expiresInDays) : SUPPORT_GRANT_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > SUPPORT_GRANT_MAX_DAYS) {
    throw invalidExpiry(`Support access lasts between 1 and ${SUPPORT_GRANT_MAX_DAYS} days.`);
  }
  return new Date(now.getTime() + days * DAY_MS);
};

export const parseGrantReason = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new SupportAccessError("INVALID_GRANT_REASON", "The reason must be text.", 400);
  const reason = value.trim();
  if (reason.length > 500) throw new SupportAccessError("INVALID_GRANT_REASON", "The reason can be at most 500 characters.", 400);
  return reason || null;
};

/** An organization member managing grants. accountType comes from the stored account. */
export type GrantManager = { rfpActor: RfpActor; accountType?: string; correlationId: string };

/** A signed-in admin-app account. */
export type SupportAgent = { adminId: string; organizationId: string; role?: string; accountType?: string; correlationId: string };

const STAFF_ROLES = ["admin", "super_admin", "superadmin"];
export const isSupportAgent = (agent: Pick<SupportAgent, "role" | "accountType">) =>
  agent.accountType === "admin" && STAFF_ROLES.includes(String(agent.role ?? "").toLowerCase().trim().replace(/[\s-]/g, "_"));

export type GrantedRfp = RfpRef & { id: string; title: string };

export type SupportActivityEvent = {
  at: Date;
  agentId: string | null;
  operation: string;
  targetType: string;
  targetId: string | null;
};

export type SupportActivitySummary = { useCount: number; lastUsedAt: Date | null };

export interface SupportGrantRepository {
  create(input: { organizationId: string; proposalId: string | null; grantedBy: string; reason: string | null; expiresAt: Date }): Promise<SupportGrantRecord>;
  findInOrganization(organizationId: string, grantId: string): Promise<SupportGrantRecord | null>;
  listForOrganization(organizationId: string, page: { skip: number; limit: number }): Promise<{ grants: SupportGrantRecord[]; total: number }>;
  // Sets revokedAt once. Returns the grant as it now is, or null when it isn't in the organization.
  revoke(input: { organizationId: string; grantId: string; revokedBy: string; now: Date }): Promise<{ grant: SupportGrantRecord; changed: boolean } | null>;
  activeForOrganization(organizationId: string, now: Date): Promise<SupportGrantRecord[]>;
  // Every organization's active grants: what RFPilot Support may currently reach.
  activeEverywhere(now: Date): Promise<SupportGrantRecord[]>;
}

export interface SupportAccessDirectory {
  findRfp(organizationId: string, proposalId: string): Promise<GrantedRfp | null>;
  rfpTitles(organizationId: string, proposalIds: readonly string[]): Promise<Map<string, string>>;
  memberNames(organizationId: string, userIds: readonly string[]): Promise<Map<string, string>>;
  organizationNames(organizationIds: readonly string[]): Promise<Map<string, string>>;
}

export interface SupportActivityLog {
  summarize(organizationId: string, grantIds: readonly string[]): Promise<Map<string, SupportActivitySummary>>;
  listForGrant(organizationId: string, grantId: string, limit: number): Promise<SupportActivityEvent[]>;
}

export type GrantedRfpListItem = {
  id: string;
  eventName: string;
  status: string;
  stage: string | null;
  isDraft: boolean;
  isArchived: boolean;
  startDate: string | null;
  endDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  owner: { id: string; name: string | null; email: string | null } | null;
};

export type GrantedVendorResponse = {
  id: string;
  vendorName: string | null;
  submittedBy: string | null;
  email: string | null;
  message: string | null;
  documentCount: number;
  currentVersionNumber: number;
  createdAt: string | null;
  updatedAt: string | null;
};

// Reads of a customer organization's RFP data. Every method names the organization the grant
// was issued by; none of them reads the caller's tenant context.
export interface GrantedRfpReader {
  list(organizationId: string, filter: { proposalIds?: readonly string[]; ownerUserId?: string; search: string; skip: number; limit: number }): Promise<{ rfps: GrantedRfpListItem[]; total: number }>;
  find(organizationId: string, proposalId: string): Promise<{ rfp: Record<string, unknown> & { id: string }; owner: GrantedRfpListItem["owner"] } | null>;
  vendorResponses(organizationId: string, proposalId: string): Promise<GrantedVendorResponse[]>;
}

export interface SupportTicketLookup {
  // A helpdesk ticket the agent can already read (the support desk's own scope), or null.
  find(agentOrganizationId: string, ticketId: string): Promise<{ id: string; organizationId: string; requesterUserId: string } | null>;
}
