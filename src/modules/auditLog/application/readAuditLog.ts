import { hasOrganizationAction } from "../../identity/domain/authorizationPolicy";
import {
  AUDIT_CATALOG,
  AUDIT_CATEGORIES,
  AuditLogError,
  MEMBER_ACTIONS,
  STAFF_ACTIONS,
  SUPPORT_ACTOR_LABEL,
  catalogEntry,
  VISIBLE_ACTIONS,
  auditCsv,
  visibleDetails,
  visibleReason,
  type AuditEventActor,
  type AuditEventFilter,
  type AuditEventReader,
  type AuditEventView,
  type AuditLogActor,
  type StoredAuditEvent,
} from "../domain";

export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 100;
export const AUDIT_EXPORT_MAX = 5000;

const invalid = (message: string) => new AuditLogError("AUDIT_FILTER_INVALID", message, 400);

// Query values must be plain strings: a repeated or bracketed parameter (?actor[$ne]=) is refused.
const text = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw invalid("Filters must be single text values.");
  return value.trim();
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// A full ISO instant with its zone, so a filter never depends on the server's own time zone.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const parseDate = (value: unknown, name: "from" | "to"): Date | undefined => {
  const raw = text(value);
  if (!raw) return undefined;
  if (!DATE_ONLY.test(raw) && !ISO_INSTANT.test(raw)) throw invalid(`"${name}" must be a date (YYYY-MM-DD) or an ISO timestamp with a time zone.`);
  const date = new Date(DATE_ONLY.test(raw) ? `${raw}T00:00:00.000Z` : raw);
  if (Number.isNaN(date.getTime())) throw invalid(`"${name}" must be a date.`);
  // A bare end date means the whole of that day (UTC); the filter's upper bound is exclusive.
  if (name === "to" && DATE_ONLY.test(raw)) date.setUTCDate(date.getUTCDate() + 1);
  return date;
};

const encodeCursor = (event: StoredAuditEvent) =>
  Buffer.from(`${event.createdAt.getTime()}:${event.id}`, "utf8").toString("base64url");
const decodeCursor = (value: unknown, isValidId: (id: string) => boolean): AuditEventFilter["before"] => {
  const raw = text(value);
  if (!raw) return undefined;
  const [time, id] = Buffer.from(raw, "base64url").toString("utf8").split(":");
  const createdAt = new Date(Number(time));
  if (!/^\d{1,16}$/.test(time ?? "") || Number.isNaN(createdAt.getTime()) || !id || !isValidId(id)) throw invalid("The page cursor is not valid.");
  return { createdAt, id };
};

export const createAuditLog = (deps: { events: AuditEventReader }) => {
  const assertReader = (actor: AuditLogActor) => {
    if (!actor.organizationId || !actor.userId) throw new AuditLogError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
    // The route already requires audit:read; the service repeats it so no other caller can skip it.
    if (!hasOrganizationAction(actor.roles, "audit:read")) {
      throw new AuditLogError("AUDIT_LOG_FORBIDDEN", "Only an Owner or Admin can read the audit log.", 403);
    }
  };

  // The same filter drives the list and the export, so an export never holds a row the list wouldn't.
  const filterFrom = (query: Record<string, unknown>): AuditEventFilter => {
    let actions: readonly string[] = VISIBLE_ACTIONS;
    const action = text(query.action);
    const category = text(query.category);
    if (action) {
      if (!catalogEntry(action)) throw invalid("That action isn't part of the audit log.");
      actions = [action];
    }
    if (category) {
      if (!AUDIT_CATEGORIES.some((entry) => entry.key === category)) throw invalid("That category isn't part of the audit log.");
      actions = actions.filter((name) => AUDIT_CATALOG[name].category === category);
    }
    // "support" selects RFPilot Support activity as a whole. A member id never matches a staff event:
    // those carry an `admins` id, which customers can't name.
    const actor = text(query.actor);
    let actorUserId: string | undefined;
    if (actor === "support") actions = actions.filter((name) => STAFF_ACTIONS.includes(name));
    else if (actor) {
      if (!deps.events.isValidId(actor)) throw invalid("That user isn't valid.");
      actorUserId = actor;
      actions = actions.filter((name) => MEMBER_ACTIONS.includes(name));
    }
    const from = parseDate(query.from, "from");
    const to = parseDate(query.to, "to");
    if (from && to && from >= to) throw invalid('"from" must be before "to".');
    return { actions, ...(actorUserId ? { actorUserId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) };
  };

  const present = async (organizationId: string, events: readonly StoredAuditEvent[]): Promise<AuditEventView[]> => {
    const memberTargets = (event: StoredAuditEvent) =>
      (event.targetType === "user" || event.targetType === "organization_membership") && event.targetId && deps.events.isValidId(event.targetId)
        ? event.targetId
        : null;
    const ids = new Set<string>();
    for (const event of events) {
      if (event.actorUserId && !catalogEntry(event.action)?.staffActor) ids.add(event.actorUserId);
      const target = memberTargets(event);
      if (target) ids.add(target);
    }
    const names = await deps.events.memberNames(organizationId, [...ids]);
    const actorOf = (event: StoredAuditEvent): AuditEventActor => {
      // Staff are shown as RFPilot Support with a stable reference, never by name (ORG-404).
      if (catalogEntry(event.action)?.staffActor) return { kind: "support", id: event.actorUserId, name: SUPPORT_ACTOR_LABEL };
      if (!event.actorUserId) return { kind: "system", id: null, name: "System" };
      const member = names.get(event.actorUserId);
      return member
        ? { kind: "member", id: event.actorUserId, name: member.name || member.email, email: member.email }
        : { kind: "unknown", id: event.actorUserId, name: "Unknown user" };
    };
    return events.map((event) => {
      const entry = AUDIT_CATALOG[event.action];
      const target = memberTargets(event);
      const targetMember = target ? names.get(target) : undefined;
      return {
        id: event.id,
        occurredAt: event.createdAt.toISOString(),
        action: event.action,
        label: entry.label,
        category: entry.category,
        decision: event.decision,
        reason: visibleReason(event.reason),
        actor: actorOf(event),
        target: { type: event.targetType, id: event.targetId, name: targetMember ? targetMember.name || targetMember.email : null },
        details: visibleDetails(event.metadata),
      };
    });
  };

  const read = async (organizationId: string, filter: AuditEventFilter, limit: number) => {
    if (filter.actions.length === 0) return { stored: [] as StoredAuditEvent[], more: false };
    const rows = await deps.events.list(organizationId, filter, limit + 1);
    // Belt and braces: a reader bug can't surface an uncatalogued action.
    const stored = rows.filter((row) => catalogEntry(row.action)).slice(0, limit);
    return { stored, more: rows.length > limit };
  };

  return {
    filters(actor: AuditLogActor) {
      assertReader(actor);
      return {
        categories: AUDIT_CATEGORIES.map((category) => ({
          ...category,
          actions: VISIBLE_ACTIONS.filter((action) => AUDIT_CATALOG[action].category === category.key)
            .map((action) => ({ value: action, label: AUDIT_CATALOG[action].label })),
        })),
        supportActor: { value: "support", label: SUPPORT_ACTOR_LABEL },
      };
    },

    async list(actor: AuditLogActor, query: Record<string, unknown>) {
      assertReader(actor);
      const requested = Number(text(query.limit) || AUDIT_PAGE_DEFAULT);
      if (!Number.isInteger(requested) || requested < 1) throw invalid('"limit" must be a positive whole number.');
      const limit = Math.min(requested, AUDIT_PAGE_MAX);
      const filter = { ...filterFrom(query), before: decodeCursor(query.cursor, deps.events.isValidId) };
      const { stored, more } = await read(actor.organizationId, filter, limit);
      return {
        events: await present(actor.organizationId, stored),
        nextCursor: more && stored.length > 0 ? encodeCursor(stored[stored.length - 1]) : null,
      };
    },

    // Newest first, capped; `truncated` tells the caller to narrow the dates.
    async exportCsv(actor: AuditLogActor, query: Record<string, unknown>) {
      assertReader(actor);
      const { stored, more } = await read(actor.organizationId, filterFrom(query), AUDIT_EXPORT_MAX);
      return { csv: auditCsv(await present(actor.organizationId, stored)), rows: stored.length, truncated: more };
    },
  };
};

export type AuditLog = ReturnType<typeof createAuditLog>;
