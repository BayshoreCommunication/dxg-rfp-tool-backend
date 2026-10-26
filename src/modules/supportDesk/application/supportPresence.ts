import {
  SupportDeskError,
  assertAgent,
  parseSupportObjectId,
  type SupportActor,
} from "../domain";
import type {
  SupportDeskClock,
  SupportDeskRepository,
  SupportPresenceState,
  SupportPresenceStore,
} from "../domain/ports/supportDeskPorts";

/** A heartbeat older than this means the agent has left the ticket. */
export const PRESENCE_FRESH_MS = 30_000;

/**
 * "Who else has this ticket open": each agent's open ticket sends a heartbeat
 * every few seconds saying whether they are just viewing or writing a reply,
 * and gets back everyone else's. This is what stops two agents from answering
 * the same customer at once.
 */
export const createSupportPresence = (dependencies: {
  store: SupportPresenceStore;
  repository: SupportDeskRepository;
  clock?: SupportDeskClock;
}) => {
  const { store, repository } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  const requireTicketId = async (actor: SupportActor, ticketId: unknown) => {
    const id = parseSupportObjectId(ticketId, "ticket id");
    if (!(await repository.findTicket(actor.organizationId, id))) {
      throw new SupportDeskError("SUPPORT_TICKET_NOT_FOUND", "The support ticket was not found.", 404);
    }
    return id;
  };

  return {
    async heartbeat(actor: SupportActor, ticketId: unknown, input: { state?: unknown }) {
      assertAgent(actor);
      const id = await requireTicketId(actor, ticketId);
      const state: SupportPresenceState = input.state === "replying" ? "replying" : "viewing";
      const now = clock();
      await store.touch(actor.organizationId, id, { userId: actor.userId, state, at: now.toISOString() });
      const others = (await store.list(actor.organizationId, id)).filter(
        (entry) => entry.userId !== actor.userId && now.getTime() - Date.parse(entry.at) <= PRESENCE_FRESH_MS,
      );
      const people = await repository.findUserSummaries(
        actor.organizationId,
        others.map((entry) => entry.userId),
      );
      return {
        others: others
          .map((entry) => ({
            userId: entry.userId,
            name: people.get(entry.userId)?.name ?? "Another agent",
            state: entry.state,
          }))
          // Whoever is replying matters most, so they come first.
          .sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name) : a.state === "replying" ? -1 : 1)),
      };
    },

    async leave(actor: SupportActor, ticketId: unknown) {
      assertAgent(actor);
      const id = parseSupportObjectId(ticketId, "ticket id");
      await store.remove(actor.organizationId, id, actor.userId);
    },
  };
};
export type SupportPresence = ReturnType<typeof createSupportPresence>;
