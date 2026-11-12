import {
  assertAgent,
  isPlatformSupportStaff,
  type SupportActor,
  type SupportDeskMetrics,
  type SupportInboxFilters,
  type SupportTicketPeopleRef,
  type SupportTicketRecord,
  type SupportUserSummary,
} from "../domain";
import type { SupportDeskRepository } from "../domain/ports/supportDeskPorts";

/**
 * Which tickets an agent may work on. This is the one place the agent side of the
 * helpdesk decides its scope; every agent operation reads tickets through it.
 *
 * - RFPilot staff (an `admins` account with a staff role) work every organization's
 *   tickets: customers each have their own organization, and staff sit outside all of them.
 * - Anyone else who passes the agent check (a `users` account whose account role is
 *   administrative) keeps exactly what they had: their own organization's tickets.
 *
 * Writes never take the scope: they name the organization of the ticket that was read
 * through it (`ticket.organizationId`), so a message always lands in the customer's thread.
 */
export type AgentScope = {
  /** True when the scope is every organization. */
  platform: boolean;
  findTicket(ticketId: string): Promise<SupportTicketRecord | null>;
  listTickets(filters: SupportInboxFilters): Promise<{ tickets: SupportTicketRecord[]; total: number }>;
  metrics(now: Date): Promise<SupportDeskMetrics>;
  /** Who a ticket can be assigned to. */
  listAgents(): Promise<SupportUserSummary[]>;
  /** Requesters, assignees and message authors of the given tickets. */
  people(refs: readonly SupportTicketPeopleRef[]): Promise<Map<string, SupportUserSummary>>;
};

export const agentScopeFor = (repository: SupportDeskRepository, actor: SupportActor): AgentScope => {
  assertAgent(actor);
  if (isPlatformSupportStaff(actor)) {
    return {
      platform: true,
      findTicket: (ticketId) => repository.findTicketInAnyOrganization(ticketId),
      listTickets: (filters) => repository.listTicketsInAnyOrganization(filters),
      metrics: (now) => repository.metricsForAllOrganizations(now),
      listAgents: () => repository.listStaffAgents(),
      people: (refs) => repository.findTicketPeople(refs),
    };
  }
  const organizationId = actor.organizationId;
  return {
    platform: false,
    findTicket: (ticketId) => repository.findTicket(organizationId, ticketId),
    // The organization filter is a staff-inbox feature; here the scope already is one organization.
    listTickets: ({ organizationId: _ignored, ...filters }) => repository.listTickets(organizationId, filters),
    metrics: (now) => repository.metrics(organizationId, now),
    listAgents: () => repository.listAgents(organizationId),
    people: (refs) =>
      repository.findUserSummaries(organizationId, [
        ...new Set(refs.flatMap((ref) => ref.userIds).filter((id): id is string => Boolean(id))),
      ]),
  };
};
