import type { SecurityAuditWriter } from "../../auth/domain/ports/sessionPorts";
import {
  SUPPORT_AUDIT,
  SupportAccessError,
  coveringGrant,
  isSupportAgent,
  type GrantedRfpReader,
  type SupportAccessDirectory,
  type SupportAgent,
  type SupportGrantRecord,
  type SupportGrantRepository,
  type SupportTicketLookup,
} from "../domain";

type Dependencies = {
  grants: SupportGrantRepository;
  directory: SupportAccessDirectory;
  reader: GrantedRfpReader;
  tickets: SupportTicketLookup;
  audit: SecurityAuditWriter;
  isValidId(value: string): boolean;
  clock?: () => Date;
};

const PER_PAGE = 20;

const grantRequired = () =>
  new SupportAccessError("SUPPORT_GRANT_REQUIRED", "This organization hasn't granted RFPilot Support access, or the access has ended.", 403);
const rfpNotFound = () => new SupportAccessError("PROPOSAL_NOT_FOUND", "RFP not found.", 404);

const pageOf = (value: unknown) => {
  const parsed = Number.parseInt(String(value ?? "1"), 10);
  return Number.isNaN(parsed) || parsed < 1 ? 1 : parsed;
};

// What the admin app shows in its banner: the permission the agent is working under.
const grantBanner = (grant: SupportGrantRecord, now: Date) => ({
  id: grant.id,
  scope: grant.proposalId ? ("rfp" as const) : ("organization" as const),
  proposalId: grant.proposalId,
  expiresAt: grant.expiresAt,
  secondsRemaining: Math.max(0, Math.floor((grant.expiresAt.getTime() - now.getTime()) / 1000)),
});

// The RFPilot Support side of support access (ORG-404). Every read of a customer
// organization's RFP data checks for an active grant at the moment of the request (so an
// expired or revoked grant stops working at once) and writes an audit event in that
// organization naming the agent, the grant and the object. If the event can't be written,
// nothing is returned.
export const createSupportAccess = (dependencies: Dependencies) => {
  const { grants, directory, reader, tickets, audit } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  const assertAgent = (agent: SupportAgent) => {
    if (!isSupportAgent(agent)) {
      throw new SupportAccessError("SUPPORT_ACCESS_FORBIDDEN", "Only RFPilot Support can do that.", 403);
    }
  };

  const used = (agent: SupportAgent, grant: SupportGrantRecord, operation: string, target: { type: "organization" | "proposal"; id: string }, extra: Record<string, unknown> = {}) =>
    audit.append({
      organizationId: grant.organizationId,
      actorUserId: agent.adminId,
      action: SUPPORT_AUDIT.used,
      targetType: target.type,
      targetId: target.id,
      decision: "allowed",
      reason: operation,
      correlationId: agent.correlationId,
      metadata: { grantId: grant.id, operation, agentAccountType: "admin", ...extra },
    });

  // A refused attempt is recorded in the organization it aimed at, when that organization exists.
  const denied = async (agent: SupportAgent, organizationId: string, operation: string, extra: Record<string, unknown> = {}) => {
    if (!(await directory.organizationNames([organizationId])).has(organizationId)) return;
    await audit.append({
      organizationId,
      actorUserId: agent.adminId,
      action: SUPPORT_AUDIT.denied,
      targetType: "organization",
      targetId: organizationId,
      decision: "denied",
      reason: "no_active_grant",
      correlationId: agent.correlationId,
      metadata: { operation, agentAccountType: "admin", ...extra },
    });
  };

  const activeGrants = async (agent: SupportAgent, organizationId: string, operation: string, extra: Record<string, unknown> = {}) => {
    if (!dependencies.isValidId(organizationId)) throw grantRequired();
    const now = clock();
    const active = await grants.activeForOrganization(organizationId, now);
    if (active.length === 0) {
      await denied(agent, organizationId, operation, extra);
      throw grantRequired();
    }
    return { active, now };
  };

  // The grant covering one RFP. With grants for other RFPs only, this one reads as missing.
  const authorizeRfp = async (agent: SupportAgent, organizationId: string, proposalId: string, operation: string) => {
    const { active, now } = await activeGrants(agent, organizationId, operation, { proposalId });
    const grant = dependencies.isValidId(proposalId) ? coveringGrant(active, organizationId, proposalId, now) : null;
    if (!grant) {
      await denied(agent, organizationId, operation, { proposalId });
      throw rfpNotFound();
    }
    return { grant, now };
  };

  const listRfpsUnderGrants = async (
    agent: SupportAgent,
    organizationId: string,
    query: { page?: unknown; search?: unknown },
    options: { operation: string; ownerUserId?: string; extra?: Record<string, unknown> },
  ) => {
    const { active, now } = await activeGrants(agent, organizationId, options.operation, options.extra);
    const organizationWide = active.find((grant) => grant.proposalId === null) ?? null;
    const scoped = active.filter((grant) => grant.proposalId !== null);
    const page = pageOf(query.page);
    const search = String(query.search ?? "").trim().slice(0, 200);
    const result = await reader.list(organizationId, {
      ...(organizationWide ? {} : { proposalIds: scoped.map((grant) => grant.proposalId as string) }),
      ...(options.ownerUserId ? { ownerUserId: options.ownerUserId } : {}),
      search,
      skip: (page - 1) * PER_PAGE,
      limit: PER_PAGE,
    });
    if (organizationWide) {
      await used(agent, organizationWide, options.operation, { type: "organization", id: organizationId }, options.extra);
    } else {
      for (const grant of scoped) {
        await used(agent, grant, options.operation, { type: "proposal", id: grant.proposalId as string }, options.extra);
      }
    }
    return {
      organizationId,
      grants: (organizationWide ? [organizationWide] : scoped).map((grant) => grantBanner(grant, now)),
      rfps: result.rfps,
      pagination: { page, perPage: PER_PAGE, total: result.total, totalPages: Math.max(1, Math.ceil(result.total / PER_PAGE)) },
    };
  };

  return {
    // "Granted to me": every organization's active grants. Grant metadata only, so no use is logged.
    async listGranted(agent: SupportAgent) {
      assertAgent(agent);
      const now = clock();
      const active = await grants.activeEverywhere(now);
      const organizationIds = [...new Set(active.map((grant) => grant.organizationId))];
      const names = await directory.organizationNames(organizationIds);
      const titles = new Map<string, string>();
      for (const organizationId of organizationIds) {
        const ids = active.flatMap((grant) => (grant.organizationId === organizationId && grant.proposalId ? [grant.proposalId] : []));
        if (ids.length) for (const [id, title] of await directory.rfpTitles(organizationId, ids)) titles.set(id, title);
      }
      return {
        grants: active.map((grant) => ({
          ...grantBanner(grant, now),
          organization: { id: grant.organizationId, name: names.get(grant.organizationId) ?? null },
          rfp: grant.proposalId ? { id: grant.proposalId, title: titles.get(grant.proposalId) ?? null } : null,
          reason: grant.reason,
          createdAt: grant.createdAt,
        })),
      };
    },

    async listRfps(agent: SupportAgent, organizationId: string, query: { page?: unknown; search?: unknown }) {
      assertAgent(agent);
      return listRfpsUnderGrants(agent, organizationId, query, { operation: "rfp.list" });
    },

    async getRfp(agent: SupportAgent, organizationId: string, proposalId: string) {
      assertAgent(agent);
      const { grant, now } = await authorizeRfp(agent, organizationId, proposalId, "rfp.read");
      const detail = await reader.find(organizationId, proposalId);
      if (!detail) throw rfpNotFound();
      await used(agent, grant, "rfp.read", { type: "proposal", id: proposalId });
      return { organizationId, grant: grantBanner(grant, now), rfp: detail.rfp, owner: detail.owner };
    },

    async listVendorResponses(agent: SupportAgent, organizationId: string, proposalId: string) {
      assertAgent(agent);
      const { grant, now } = await authorizeRfp(agent, organizationId, proposalId, "vendor_responses.list");
      if (!(await directory.findRfp(organizationId, proposalId))) throw rfpNotFound();
      const responses = await reader.vendorResponses(organizationId, proposalId);
      await used(agent, grant, "vendor_responses.list", { type: "proposal", id: proposalId });
      return { organizationId, grant: grantBanner(grant, now), proposalId, vendorResponses: responses };
    },

    // The RFPs behind a helpdesk ticket: the requester's RFPs in the ticket's organization. The
    // ticket itself needs no grant (the support desk decides who reads it); these do.
    async listTicketRfps(agent: SupportAgent, ticketId: string, query: { page?: unknown; search?: unknown }) {
      assertAgent(agent);
      const ticket = dependencies.isValidId(ticketId) ? await tickets.find(agent.organizationId, ticketId) : null;
      if (!ticket) throw new SupportAccessError("SUPPORT_TICKET_NOT_FOUND", "The support ticket was not found.", 404);
      return listRfpsUnderGrants(agent, ticket.organizationId, query, {
        operation: "ticket.rfp.list",
        ownerUserId: ticket.requesterUserId,
        extra: { ticketId: ticket.id },
      });
    },
  };
};

export type SupportAccess = ReturnType<typeof createSupportAccess>;
