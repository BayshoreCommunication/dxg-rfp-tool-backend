import { canAccessRfp } from "../../identity/domain/rfpAccessPolicy";
import type { SecurityAuditWriter } from "../../auth/domain/ports/sessionPorts";
import {
  SUPPORT_AUDIT,
  SupportAccessError,
  grantStatus,
  parseGrantReason,
  resolveGrantExpiry,
  type GrantManager,
  type SupportAccessDirectory,
  type SupportActivityLog,
  type SupportActivitySummary,
  type SupportGrantRecord,
  type SupportGrantRepository,
} from "../domain";

type Dependencies = {
  grants: SupportGrantRepository;
  directory: SupportAccessDirectory;
  activity: SupportActivityLog;
  audit: SecurityAuditWriter;
  isValidId(value: string): boolean;
  clock?: () => Date;
};

// Only an Owner or Admin decides who outside the organization reads its RFPs.
const GRANTING_ROLES = ["owner", "organization_admin"];
const PER_PAGE = 50;
const ACTIVITY_LIMIT = 200;
const NO_ACTIVITY: SupportActivitySummary = { useCount: 0, lastUsedAt: null };

const grantNotFound = () => new SupportAccessError("SUPPORT_GRANT_NOT_FOUND", "Support access grant not found.", 404);
const rfpNotFound = () => new SupportAccessError("PROPOSAL_NOT_FOUND", "RFP not found.", 404);

// The customer side of support access (ORG-404): an Owner or Admin grants RFPilot Support
// read access to one RFP or the whole organization, sees every grant with what Support did
// under it, and revokes at any time. Everything is bounded to the caller's organization.
export const createSupportGrantManagement = (dependencies: Dependencies) => {
  const { grants, directory, activity, audit } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  const organizationOf = (actor: GrantManager) => String(actor.rfpActor.organizationId);

  const assertManager = (actor: GrantManager) => {
    const allowed =
      actor.accountType !== "admin" &&
      actor.rfpActor.membershipStatus === "active" &&
      actor.rfpActor.roles.some((role) => GRANTING_ROLES.includes(role));
    if (!allowed) {
      throw new SupportAccessError("SUPPORT_GRANT_FORBIDDEN", "Only an Owner or Admin can manage RFPilot Support access.", 403);
    }
  };

  const present = async (actor: GrantManager, records: readonly SupportGrantRecord[]) => {
    const organizationId = organizationOf(actor);
    const now = clock();
    const [titles, names, uses] = await Promise.all([
      directory.rfpTitles(organizationId, records.flatMap((grant) => (grant.proposalId ? [grant.proposalId] : []))),
      directory.memberNames(organizationId, records.flatMap((grant) => [grant.grantedBy, ...(grant.revokedBy ? [grant.revokedBy] : [])])),
      activity.summarize(organizationId, records.map((grant) => grant.id)),
    ]);
    const person = (userId: string | null) => (userId ? { id: userId, name: names.get(userId) ?? null } : null);
    return records.map((grant) => ({
      id: grant.id,
      scope: grant.proposalId ? ("rfp" as const) : ("organization" as const),
      // A deleted RFP keeps its grant on the record; the title is then unknown.
      rfp: grant.proposalId ? { id: grant.proposalId, title: titles.get(grant.proposalId) ?? null } : null,
      reason: grant.reason,
      status: grantStatus(grant, now),
      grantedBy: person(grant.grantedBy),
      createdAt: grant.createdAt,
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
      revokedBy: person(grant.revokedBy),
      activity: uses.get(grant.id) ?? NO_ACTIVITY,
    }));
  };

  const load = async (actor: GrantManager, grantId: string) => {
    const grant = dependencies.isValidId(grantId) ? await grants.findInOrganization(organizationOf(actor), grantId) : null;
    if (!grant) throw grantNotFound();
    return grant;
  };

  return {
    async list(actor: GrantManager, query: { page?: unknown }) {
      assertManager(actor);
      const parsed = Number.parseInt(String(query.page ?? "1"), 10);
      const page = Number.isNaN(parsed) || parsed < 1 ? 1 : parsed;
      const result = await grants.listForOrganization(organizationOf(actor), { skip: (page - 1) * PER_PAGE, limit: PER_PAGE });
      return {
        grants: await present(actor, result.grants),
        pagination: { page, perPage: PER_PAGE, total: result.total, totalPages: Math.max(1, Math.ceil(result.total / PER_PAGE)) },
      };
    },

    async create(actor: GrantManager, input: { proposalId?: unknown; expiresInDays?: unknown; expiresAt?: unknown; reason?: unknown }) {
      assertManager(actor);
      const organizationId = organizationOf(actor);
      const now = clock();
      let proposalId: string | null = null;
      if (input.proposalId !== undefined && input.proposalId !== null && input.proposalId !== "") {
        const requested = String(input.proposalId);
        const rfp = dependencies.isValidId(requested) ? await directory.findRfp(organizationId, requested) : null;
        // Another organization's RFP and a missing one read the same.
        if (!rfp || !canAccessRfp(actor.rfpActor, rfp, "grantSupport").allowed) throw rfpNotFound();
        proposalId = rfp.id;
      }
      const expiresAt = resolveGrantExpiry(input, now);
      const reason = parseGrantReason(input.reason);
      const grant = await grants.create({ organizationId, proposalId, grantedBy: String(actor.rfpActor.userId), reason, expiresAt });
      await audit.append({
        organizationId,
        actorUserId: String(actor.rfpActor.userId),
        action: SUPPORT_AUDIT.granted,
        targetType: proposalId ? "proposal" : "organization",
        targetId: proposalId ?? organizationId,
        decision: "created",
        reason: SUPPORT_AUDIT.granted,
        correlationId: actor.correlationId,
        metadata: { grantId: grant.id, scope: proposalId ? "rfp" : "organization", expiresAt: expiresAt.toISOString() },
      });
      return (await present(actor, [grant]))[0];
    },

    async get(actor: GrantManager, grantId: string) {
      assertManager(actor);
      const grant = await load(actor, grantId);
      const [view] = await present(actor, [grant]);
      const events = await activity.listForGrant(organizationOf(actor), grant.id, ACTIVITY_LIMIT);
      const titles = await directory.rfpTitles(
        organizationOf(actor),
        [...new Set(events.flatMap((event) => (event.targetType === "proposal" && event.targetId ? [event.targetId] : [])))],
      );
      return {
        ...view,
        // Staff are shown as "RFPilot Support" with a stable reference, never by name, like the helpdesk.
        events: events.map((event) => ({
          at: event.at,
          agent: { id: event.agentId, label: "RFPilot Support" },
          operation: event.operation,
          rfp: event.targetType === "proposal" && event.targetId ? { id: event.targetId, title: titles.get(event.targetId) ?? null } : null,
        })),
      };
    },

    async revoke(actor: GrantManager, grantId: string) {
      assertManager(actor);
      const existing = await load(actor, grantId);
      const now = clock();
      // An expired grant already gives nothing; revoking it would only rewrite its history.
      if (grantStatus(existing, now) === "expired") {
        throw new SupportAccessError("SUPPORT_GRANT_EXPIRED", "This support access has already expired.", 409);
      }
      const organizationId = organizationOf(actor);
      const result = await grants.revoke({ organizationId, grantId: existing.id, revokedBy: String(actor.rfpActor.userId), now });
      if (!result) throw grantNotFound();
      if (result.changed) {
        await audit.append({
          organizationId,
          actorUserId: String(actor.rfpActor.userId),
          action: SUPPORT_AUDIT.revoked,
          targetType: result.grant.proposalId ? "proposal" : "organization",
          targetId: result.grant.proposalId ?? organizationId,
          decision: "revoked",
          reason: SUPPORT_AUDIT.revoked,
          correlationId: actor.correlationId,
          metadata: { grantId: result.grant.id, scope: result.grant.proposalId ? "rfp" : "organization" },
        });
      }
      return (await present(actor, [result.grant]))[0];
    },
  };
};

export type SupportGrantManagement = ReturnType<typeof createSupportGrantManagement>;
