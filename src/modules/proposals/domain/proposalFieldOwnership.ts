/**
 * Who may write each top-level field of a Proposal document.
 *
 * Trust boundary (DECISIONS, 2026-11-24): a server-owned proposal field is never taken from a
 * client payload. Client payloads pass through `clientProposalFields`, an allow-list: a key is
 * kept only when its root is listed here as client-writable, so a field nobody classified is
 * dropped, not written. `tests/proposal-field-ownership.test.js` fails when the model gains a
 * top-level field that is missing from this table.
 *
 *  - "content": the planner's RFP content. The whole subtree is theirs; a dotted key below the
 *    root (`event.eventName`) is accepted.
 *  - "client_flag": a single value the planner may set through the edit route. Only the exact
 *    key is accepted, never a dotted child. `teamId` is validated separately (ORG-202).
 *  - "server": written only by server code (tenancy, archive state, lifecycle, counters,
 *    concurrency, timestamps). Never read from a client payload.
 *
 * The table and its parity test cover TOP-LEVEL fields only. Content sections are free-form:
 * everything inside one is client-writable. Never add a server-owned field INSIDE a content
 * section (for example a server-computed value under `budget` or `proposalSettings`); give it
 * its own top-level field and classify it "server" here.
 */
export type ProposalFieldOwner = "content" | "client_flag" | "server";

export const PROPOSAL_FIELD_OWNERSHIP: ReadonlyMap<string, ProposalFieldOwner> = new Map<string, ProposalFieldOwner>([
  // Identity, tenancy and ownership.
  ["_id", "server"],
  ["__v", "server"],
  ["createdAt", "server"],
  ["updatedAt", "server"],
  ["organizationId", "server"],
  ["userId", "server"],
  // Archive state: set by archive and restore, read by the 30-day purge.
  ["isArchived", "server"],
  ["archivedAt", "server"],
  // Derived or counted by the server.
  ["lifecycle", "server"],
  ["isCopy", "server"],
  ["viewsCount", "server"],
  ["version", "server"],
  ["candidateApplicationIds", "server"],
  // Values the planner sets through the edit route.
  ["teamId", "client_flag"],
  ["status", "client_flag"],
  ["isDraft", "client_flag"],
  ["isActive", "client_flag"],
  ["isFavorite", "client_flag"],
  ["isAccepted", "client_flag"],
  ["isOpen", "client_flag"],
  // RFP content.
  ["proposalSettings", "content"],
  ["event", "content"],
  ["venueSchedule", "content"],
  ["roomByRoom", "content"],
  ["production", "content"],
  ["hybridVirtual", "content"],
  ["contentCreative", "content"],
  ["videoRecordingStep", "content"],
  ["venue", "content"],
  ["uploads", "content"],
  ["budget", "content"],
  ["contact", "content"],
]);

const TENANCY_FIELDS = ["organizationId", "userId"] as const;

// Server-owned fields that the proposals module itself sets through updateOwnedById: publishing
// clears `isCopy`, and PATCH /:id/meta takes a validated non-negative `viewsCount`.
const SERVER_FIELDS_SET_BY_EDIT_USE_CASES = new Set(["isCopy", "viewsCount"]);

const isOperatorKey = (key: string): boolean => key.startsWith("$");

// Keys that reach an object's prototype chain. Never accepted as a key or a path segment.
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isUnsafeKey = (key: string): boolean => isOperatorKey(key) || PROTOTYPE_KEYS.has(key);

// Always an own data property: plain assignment of a `__proto__` key would set the prototype.
const setOwn = (target: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
};

/**
 * Deepest nesting accepted inside a content section. Real sections are under 10 levels deep
 * (the deepest today is uploads.coVendors.<role>.<field> and roomByRoom[n].<group>.<field>);
 * 64 leaves ample room and keeps the recursive walk far from the stack limit.
 */
export const MAX_PROPOSAL_CONTENT_DEPTH = 64;

export class ProposalPayloadTooDeepError extends Error {
  readonly status = 400;
  readonly code = "PROPOSAL_PAYLOAD_TOO_DEEP";
  constructor() {
    super(`Proposal content is nested more than ${MAX_PROPOSAL_CONTENT_DEPTH} levels deep`);
    this.name = "ProposalPayloadTooDeepError";
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// A value under a content root is stored as data, but no key in it may look like an operator
// or reach a prototype. Nesting beyond MAX_PROPOSAL_CONTENT_DEPTH refuses the whole payload.
const withoutOperatorKeys = (value: unknown, depth = 0): unknown => {
  const nested = Array.isArray(value) || (typeof value === "object" && value !== null);
  if (nested && depth >= MAX_PROPOSAL_CONTENT_DEPTH) throw new ProposalPayloadTooDeepError();
  if (Array.isArray(value)) return value.map((item) => withoutOperatorKeys(item, depth + 1));
  if (!isPlainObject(value)) return value;
  const clean: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isUnsafeKey(key)) continue;
    setOwn(clean, key, withoutOperatorKeys(child, depth + 1));
  }
  return clean;
};

const clientMayWrite = (key: string): boolean => {
  if (isUnsafeKey(key)) return false;
  const segments = key.split(".");
  const owner = PROPOSAL_FIELD_OWNERSHIP.get(segments[0]);
  if (owner === "client_flag") return segments.length === 1;
  if (owner !== "content") return false;
  // `event.eventName` is a content path; an empty, `$` or prototype segment (`event.$[]`,
  // `event..x`, `venue.__proto__.x`, `venue.constructor.prototype.x`) is not.
  return segments.every((segment) => segment.length > 0 && !isUnsafeKey(segment));
};

/**
 * The part of a client payload that may reach a proposal write. Everything else is dropped:
 * server-owned fields, unknown fields, dotted paths into them (`lifecycle.stage`) and any
 * `$`-prefixed or prototype key (`__proto__`, `constructor`, `prototype`) at any depth. Throws
 * ProposalPayloadTooDeepError (400) when content is nested beyond MAX_PROPOSAL_CONTENT_DEPTH.
 */
export const clientProposalFields = (input: Record<string, unknown>): Record<string, unknown> => {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!clientMayWrite(key)) continue;
    setOwn(fields, key, withoutOperatorKeys(value));
  }
  return fields;
};

export class ProposalTenancyChangeRefusedError extends Error {
  readonly status = 400;
  readonly code = "PROPOSAL_TENANCY_FIELD_NOT_WRITABLE";
  constructor(readonly field: (typeof TENANCY_FIELDS)[number]) {
    super("A proposal's organization can't be changed through this request");
    this.name = "ProposalTenancyChangeRefusedError";
  }
}

/**
 * A payload that names a different organization than the caller's is refused, not quietly
 * cleaned: nothing legitimate sends one. The caller's own organization echoed back is ignored
 * like any other server-owned field.
 */
export const assertNoOrganizationChange = (input: Record<string, unknown>, actorOrganizationId: string | undefined): void => {
  if (!actorOrganizationId || !Object.prototype.hasOwnProperty.call(input, "organizationId")) return;
  const requested = input.organizationId;
  const same = (typeof requested === "string" || typeof requested === "number") && String(requested) === String(actorOrganizationId);
  if (!same) throw new ProposalTenancyChangeRefusedError("organizationId");
};

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;
const idOrMalformed = (value: unknown): string => (typeof value === "string" && OBJECT_ID_HEX.test(value) ? value : "malformed");

/**
 * Metadata for the audit event of a refused tenancy write. Only fixed strings and strict 24-hex
 * ids are recorded, never the client's own text. The proposal id is the one the request CLAIMED:
 * the refusal fires before any lookup, so it may not exist or may belong to another organization.
 */
export const refusedTenancyWriteAuditMetadata = (input: { field: string; attempted: unknown; claimedProposalId?: unknown; route: string }): Record<string, unknown> => ({
  field: input.field,
  route: input.route,
  attemptedOrganizationId: idOrMalformed(input.attempted),
  ...(input.claimedProposalId === undefined ? {} : { claimedProposalId: idOrMalformed(input.claimedProposalId) }),
});

const rootOf = (key: string): string => key.split(".")[0];

/**
 * Repository backstop for updateOwnedById: whatever a caller built, the update document can't
 * carry an operator or a prototype path segment, or touch a server-owned field other than the
 * two the edit use cases set.
 * A violation is a programming error in this module, so it throws instead of writing.
 */
export const assertEditUpdateIsSafe = (updates: Record<string, unknown>): void => {
  for (const key of Object.keys(updates)) {
    const root = rootOf(key);
    const owner = PROPOSAL_FIELD_OWNERSHIP.get(root);
    const allowed =
      !key.split(".").some(isUnsafeKey) &&
      owner !== undefined &&
      (owner !== "server" || (SERVER_FIELDS_SET_BY_EDIT_USE_CASES.has(root) && key === root));
    if (!allowed) throw new Error(`Refusing a proposal edit that writes "${root}": the field is server-owned`);
  }
};

/** Repository backstop for createOwned: the row's tenancy comes from the request context only. */
export const withoutTenancyFields = (proposal: Record<string, unknown>): Record<string, unknown> => {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(proposal)) {
    if (isOperatorKey(key) || (TENANCY_FIELDS as readonly string[]).includes(rootOf(key))) continue;
    clean[key] = value;
  }
  return clean;
};
