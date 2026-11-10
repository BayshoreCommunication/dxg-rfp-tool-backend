require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSupportGrantManagement } = require("../src/modules/supportAccess/application/manageSupportGrants");
const { createSupportAccess } = require("../src/modules/supportAccess/application/supportAccess");
const { SupportAccessError, resolveGrantExpiry, coveringGrant, grantStatus } = require("../src/modules/supportAccess/domain");
const { createSupportAccessController } = require("../controller/supportAccessController");

// ORG-404: support access grants. In-memory ports; the real-database proof is
// tests-integration/support-access-grants.test.ts.

const hex = (c) => c.repeat(24);
const ORG = hex("a");
const OTHER_ORG = hex("b");
const STAFF_ORG = hex("d");
const OWNER = hex("1");
const ADMIN = hex("2");
const MANAGER = hex("3");
const PLANNER = hex("4");
const VIEWER = hex("5");
const OTHER_OWNER = hex("6");
const AGENT = hex("7");
const RFP_ONE = hex("c");
const RFP_TWO = hex("e");
const OTHER_RFP = hex("f");
const TICKET = "0123456789abcdef01234567";
const DAY = 24 * 60 * 60 * 1000;
const START = new Date("2026-11-10T06:00:00.000Z");

const ROLES = { [OWNER]: "owner", [ADMIN]: "organization_admin", [MANAGER]: "team_manager", [PLANNER]: "planner", [VIEWER]: "viewer", [OTHER_OWNER]: "owner" };
const member = (userId, organizationId = ORG, overrides = {}) => ({
  rfpActor: { organizationId, userId, roles: [ROLES[userId]], membershipStatus: "active", managedTeamIds: [], shares: new Map() },
  accountType: "planner",
  correlationId: "corr-member",
  ...overrides,
});
const agent = (overrides = {}) => ({ adminId: AGENT, organizationId: STAFF_ORG, role: "admin", accountType: "admin", correlationId: "corr-agent", ...overrides });

const setup = () => {
  let now = new Date(START);
  let sequence = 0;
  const rows = [];
  const audit = [];
  const rfps = {
    [RFP_ONE]: { id: RFP_ONE, organizationId: ORG, ownerUserId: PLANNER, teamId: null, title: "Spring summit" },
    [RFP_TWO]: { id: RFP_TWO, organizationId: ORG, ownerUserId: MANAGER, teamId: null, title: "Sales kickoff" },
    [OTHER_RFP]: { id: OTHER_RFP, organizationId: OTHER_ORG, ownerUserId: OTHER_OWNER, teamId: null, title: "Foreign gala" },
  };
  const tickets = { [TICKET]: { id: TICKET, organizationId: ORG, requesterUserId: PLANNER, visibleTo: STAFF_ORG } };
  const state = { failAudit: false };
  const grants = {
    async create(input) {
      const row = { id: String(++sequence).padStart(24, "0"), ...input, createdAt: new Date(now), revokedAt: null, revokedBy: null };
      rows.push(row);
      return { ...row };
    },
    async findInOrganization(organizationId, grantId) {
      const row = rows.find((r) => r.id === grantId && r.organizationId === organizationId);
      return row ? { ...row } : null;
    },
    async listForOrganization(organizationId, page) {
      const all = rows.filter((r) => r.organizationId === organizationId).reverse();
      return { grants: all.slice(page.skip, page.skip + page.limit).map((r) => ({ ...r })), total: all.length };
    },
    async revoke({ organizationId, grantId, revokedBy, now: at }) {
      const row = rows.find((r) => r.id === grantId && r.organizationId === organizationId);
      if (!row) return null;
      if (row.revokedAt) return { grant: { ...row }, changed: false };
      Object.assign(row, { revokedAt: at, revokedBy });
      return { grant: { ...row }, changed: true };
    },
    async activeForOrganization(organizationId, at) {
      return rows.filter((r) => r.organizationId === organizationId && !r.revokedAt && r.expiresAt > at).map((r) => ({ ...r }));
    },
    async activeEverywhere(at) {
      return rows.filter((r) => !r.revokedAt && r.expiresAt > at).map((r) => ({ ...r }));
    },
  };
  const directory = {
    async findRfp(organizationId, proposalId) { const rfp = rfps[proposalId]; return rfp && rfp.organizationId === organizationId ? rfp : null; },
    async rfpTitles(organizationId, ids) { return new Map(ids.filter((id) => rfps[id]?.organizationId === organizationId).map((id) => [id, rfps[id].title])); },
    async memberNames(_organizationId, ids) { return new Map(ids.map((id) => [id, `${ROLES[id]} person`])); },
    async organizationNames(ids) { return new Map(ids.filter((id) => [ORG, OTHER_ORG].includes(id)).map((id) => [id, id === ORG ? "Acme Events" : "Other Co"])); },
  };
  const activity = {
    async summarize(organizationId, ids) {
      const uses = audit.filter((e) => e.organizationId === organizationId && e.action === "support_access.used");
      return new Map(ids.map((id) => [id, { useCount: uses.filter((e) => e.metadata.grantId === id).length, lastUsedAt: uses.some((e) => e.metadata.grantId === id) ? now : null }])
        .filter(([, summary]) => summary.useCount > 0));
    },
    async listForGrant(organizationId, grantId) {
      return audit.filter((e) => e.organizationId === organizationId && e.action === "support_access.used" && e.metadata.grantId === grantId)
        .map((e) => ({ at: now, agentId: e.actorUserId, operation: e.metadata.operation, targetType: e.targetType, targetId: e.targetId }));
    },
  };
  const reader = {
    async list(organizationId, filter) {
      const all = Object.values(rfps).filter((r) => r.organizationId === organizationId
        && (!filter.proposalIds || filter.proposalIds.includes(r.id)) && (!filter.ownerUserId || r.ownerUserId === filter.ownerUserId));
      return { rfps: all.map((r) => ({ id: r.id, eventName: r.title })), total: all.length };
    },
    async find(organizationId, proposalId) { const rfp = rfps[proposalId]; return rfp && rfp.organizationId === organizationId ? { rfp: { id: rfp.id, event: { eventName: rfp.title } }, owner: null } : null; },
    async vendorResponses(organizationId, proposalId) { return rfps[proposalId]?.organizationId === organizationId ? [{ id: hex("9"), vendorName: "Stage Audio" }] : []; },
  };
  const auditWriter = { async append(event) { if (state.failAudit) throw new Error("audit store down"); audit.push(event); } };
  const isValidId = (value) => /^[0-9a-f]{24}$/.test(value);
  const clock = () => new Date(now);
  return {
    management: createSupportGrantManagement({ grants, directory, activity, audit: auditWriter, isValidId, clock }),
    access: createSupportAccess({
      grants, directory, reader, audit: auditWriter, isValidId, clock,
      tickets: { async find(agentOrganizationId, ticketId) { const t = tickets[ticketId]; return t && t.visibleTo === agentOrganizationId ? t : null; } },
    }),
    rows, audit, state,
    advance(ms) { now = new Date(now.getTime() + ms); },
  };
};

const rejects = (promise, code, status) =>
  assert.rejects(promise, (error) => error instanceof SupportAccessError && error.code === code && error.status === status);
const uses = (audit) => audit.filter((e) => e.action === "support_access.used");

test("expiry defaults to 7 days, takes 1 to 30 days or an instant, and never passes 30 days", () => {
  assert.equal(resolveGrantExpiry({}, START).getTime(), START.getTime() + 7 * DAY);
  assert.equal(resolveGrantExpiry({ expiresInDays: 30 }, START).getTime(), START.getTime() + 30 * DAY);
  assert.equal(resolveGrantExpiry({ expiresAt: "2026-11-12T00:00:00.000Z" }, START).toISOString(), "2026-11-12T00:00:00.000Z");
  const refused = [
    { expiresInDays: 31 }, { expiresInDays: 0 }, { expiresInDays: -1 }, { expiresInDays: 1.5 }, { expiresInDays: "soon" },
    { expiresAt: "not a date" }, { expiresAt: START.toISOString() }, { expiresAt: new Date(START.getTime() + 30 * DAY + 1000).toISOString() },
    { expiresInDays: 3, expiresAt: "2026-11-12T00:00:00.000Z" }, { expiresAt: 1_800_000_000_000 },
  ];
  for (const input of refused) {
    assert.throws(() => resolveGrantExpiry(input, START), (error) => error.code === "INVALID_GRANT_EXPIRY" && error.status === 400, JSON.stringify(input));
  }
});

test("a grant for the RFP itself wins over an organization-wide one; other organizations never match", () => {
  const base = { grantedBy: OWNER, reason: null, createdAt: START, expiresAt: new Date(START.getTime() + DAY), revokedAt: null, revokedBy: null };
  const wide = { ...base, id: "wide", organizationId: ORG, proposalId: null };
  const narrow = { ...base, id: "narrow", organizationId: ORG, proposalId: RFP_ONE };
  const foreign = { ...base, id: "foreign", organizationId: OTHER_ORG, proposalId: null };
  assert.equal(coveringGrant([wide, narrow, foreign], ORG, RFP_ONE, START).id, "narrow");
  assert.equal(coveringGrant([wide, narrow, foreign], ORG, RFP_TWO, START).id, "wide");
  assert.equal(coveringGrant([narrow, foreign], ORG, RFP_TWO, START), null);
  assert.equal(coveringGrant([{ ...wide, revokedAt: START }], ORG, RFP_ONE, START), null);
  assert.equal(grantStatus({ expiresAt: START, revokedAt: null }, START), "expired");
});

test("Owner and Admin create grants for the organization or one RFP, with an audit event each", async () => {
  const { management, rows, audit } = setup();
  const wide = await management.create(member(OWNER), {});
  assert.equal(wide.scope, "organization");
  assert.equal(wide.rfp, null);
  assert.equal(wide.status, "active");
  assert.equal(new Date(wide.expiresAt).getTime(), START.getTime() + 7 * DAY);
  assert.deepEqual(wide.grantedBy, { id: OWNER, name: "owner person" });

  const narrow = await management.create(member(ADMIN), { proposalId: RFP_ONE, expiresInDays: 2, reason: "  Budget table won't save  " });
  assert.equal(narrow.scope, "rfp");
  assert.deepEqual(narrow.rfp, { id: RFP_ONE, title: "Spring summit" });
  assert.equal(narrow.reason, "Budget table won't save");
  assert.equal(rows.length, 2);

  assert.deepEqual(audit.map((e) => [e.action, e.decision, e.organizationId, e.actorUserId, e.targetType, e.targetId, e.metadata.grantId]), [
    ["support_access.granted", "created", ORG, OWNER, "organization", ORG, wide.id],
    ["support_access.granted", "created", ORG, ADMIN, "proposal", RFP_ONE, narrow.id],
  ]);
});

test("Team Managers, Planners, Viewers, deactivated members and staff accounts can't manage grants", async () => {
  const { management, rows } = setup();
  const existing = await management.create(member(OWNER), {});
  const refused = [
    member(MANAGER), member(PLANNER), member(VIEWER),
    member(OWNER, ORG, { rfpActor: { ...member(OWNER).rfpActor, membershipStatus: "suspended" } }),
    member(OWNER, ORG, { accountType: "admin" }),
  ];
  for (const actor of refused) {
    await rejects(management.create(actor, {}), "SUPPORT_GRANT_FORBIDDEN", 403);
    await rejects(management.list(actor, {}), "SUPPORT_GRANT_FORBIDDEN", 403);
    await rejects(management.get(actor, existing.id), "SUPPORT_GRANT_FORBIDDEN", 403);
    await rejects(management.revoke(actor, existing.id), "SUPPORT_GRANT_FORBIDDEN", 403);
  }
  assert.equal(rows.length, 1);
  assert.equal(rows[0].revokedAt, null);
});

test("another organization's RFP or grant is reported as missing", async () => {
  const { management, rows } = setup();
  await rejects(management.create(member(OWNER), { proposalId: OTHER_RFP }), "PROPOSAL_NOT_FOUND", 404);
  await rejects(management.create(member(OWNER), { proposalId: hex("0") }), "PROPOSAL_NOT_FOUND", 404);
  await rejects(management.create(member(OWNER), { proposalId: "nope" }), "PROPOSAL_NOT_FOUND", 404);
  assert.equal(rows.length, 0);

  const foreign = await management.create(member(OTHER_OWNER, OTHER_ORG), {});
  await rejects(management.get(member(OWNER), foreign.id), "SUPPORT_GRANT_NOT_FOUND", 404);
  await rejects(management.revoke(member(OWNER), foreign.id), "SUPPORT_GRANT_NOT_FOUND", 404);
  await rejects(management.get(member(OWNER), "not-an-id"), "SUPPORT_GRANT_NOT_FOUND", 404);
  assert.equal(rows[0].revokedAt, null);
  assert.deepEqual((await management.list(member(OWNER), {})).grants, []);
});

test("an invalid expiry or reason creates nothing", async () => {
  const { management, rows, audit } = setup();
  await rejects(management.create(member(OWNER), { expiresInDays: 31 }), "INVALID_GRANT_EXPIRY", 400);
  await rejects(management.create(member(OWNER), { reason: "x".repeat(501) }), "INVALID_GRANT_REASON", 400);
  await rejects(management.create(member(OWNER), { reason: 7 }), "INVALID_GRANT_REASON", 400);
  assert.equal(rows.length, 0);
  assert.equal(audit.length, 0);
});

test("only admin-app accounts with a staff role are RFPilot Support", async () => {
  const { management, access } = setup();
  await management.create(member(OWNER), {});
  const impostors = [
    agent({ accountType: "planner" }),              // a member who somehow holds a staff role
    agent({ accountType: undefined }),
    agent({ role: "customer" }),
  ];
  for (const who of impostors) {
    await rejects(access.listGranted(who), "SUPPORT_ACCESS_FORBIDDEN", 403);
    await rejects(access.listRfps(who, ORG, {}), "SUPPORT_ACCESS_FORBIDDEN", 403);
    await rejects(access.getRfp(who, ORG, RFP_ONE), "SUPPORT_ACCESS_FORBIDDEN", 403);
    await rejects(access.listVendorResponses(who, ORG, RFP_ONE), "SUPPORT_ACCESS_FORBIDDEN", 403);
    await rejects(access.listTicketRfps(who, TICKET, {}), "SUPPORT_ACCESS_FORBIDDEN", 403);
  }
  assert.equal((await access.listGranted(agent({ role: "super_admin" }))).grants.length, 1);
});

test("without a grant every read of customer RFP data is refused and recorded as denied", async () => {
  const { access, audit } = setup();
  await rejects(access.listRfps(agent(), ORG, {}), "SUPPORT_GRANT_REQUIRED", 403);
  await rejects(access.getRfp(agent(), ORG, RFP_ONE), "SUPPORT_GRANT_REQUIRED", 403);
  await rejects(access.listVendorResponses(agent(), ORG, RFP_ONE), "SUPPORT_GRANT_REQUIRED", 403);
  assert.equal(uses(audit).length, 0);
  assert.deepEqual(audit.map((e) => [e.action, e.decision, e.organizationId, e.actorUserId, e.metadata.operation]), [
    ["support_access.denied", "denied", ORG, AGENT, "rfp.list"],
    ["support_access.denied", "denied", ORG, AGENT, "rfp.read"],
    ["support_access.denied", "denied", ORG, AGENT, "vendor_responses.list"],
  ]);
  // An organization that doesn't exist answers the same and leaves no audit row behind.
  await rejects(access.getRfp(agent(), hex("0"), RFP_ONE), "SUPPORT_GRANT_REQUIRED", 403);
  await rejects(access.listRfps(agent(), "not-an-id", {}), "SUPPORT_GRANT_REQUIRED", 403);
  assert.equal(audit.length, 3);
  assert.deepEqual((await access.listGranted(agent())).grants, []);
});

test("every use writes an audit event naming the agent, the grant and the object", async () => {
  const { management, access, audit } = setup();
  const grant = await management.create(member(OWNER), {});
  audit.length = 0;

  const list = await access.listRfps(agent(), ORG, {});
  assert.deepEqual(list.rfps.map((r) => r.id).sort(), [RFP_ONE, RFP_TWO].sort());
  assert.equal(list.grants[0].id, grant.id);
  const detail = await access.getRfp(agent(), ORG, RFP_ONE);
  assert.equal(detail.rfp.id, RFP_ONE);
  assert.equal(detail.grant.scope, "organization");
  assert.equal(detail.grant.secondsRemaining, 7 * 24 * 60 * 60);
  const responses = await access.listVendorResponses(agent(), ORG, RFP_ONE);
  assert.equal(responses.vendorResponses.length, 1);

  assert.deepEqual(audit.map((e) => [e.action, e.decision, e.organizationId, e.actorUserId, e.metadata.grantId, e.targetType, e.targetId, e.metadata.operation]), [
    ["support_access.used", "allowed", ORG, AGENT, grant.id, "organization", ORG, "rfp.list"],
    ["support_access.used", "allowed", ORG, AGENT, grant.id, "proposal", RFP_ONE, "rfp.read"],
    ["support_access.used", "allowed", ORG, AGENT, grant.id, "proposal", RFP_ONE, "vendor_responses.list"],
  ]);

  // The organization's Admin sees the activity under the grant; staff appear as RFPilot Support.
  const view = await management.get(member(ADMIN), grant.id);
  assert.equal(view.activity.useCount, 3);
  assert.deepEqual(view.events.map((e) => [e.operation, e.agent.label, e.agent.id, e.rfp?.title ?? null]), [
    ["rfp.list", "RFPilot Support", AGENT, null],
    ["rfp.read", "RFPilot Support", AGENT, "Spring summit"],
    ["vendor_responses.list", "RFPilot Support", AGENT, "Spring summit"],
  ]);
  assert.equal((await management.list(member(OWNER), {})).grants[0].activity.useCount, 3);
});

test("nothing is returned when the audit event can't be written", async () => {
  const { management, access, state } = setup();
  await management.create(member(OWNER), {});
  state.failAudit = true;
  await assert.rejects(access.getRfp(agent(), ORG, RFP_ONE), /audit store down/);
  await assert.rejects(access.listRfps(agent(), ORG, {}), /audit store down/);
  await assert.rejects(access.listVendorResponses(agent(), ORG, RFP_ONE), /audit store down/);
});

test("AC: a revoked grant is refused on the very next request", async () => {
  const { management, access, audit } = setup();
  const grant = await management.create(member(OWNER), {});
  assert.equal((await access.getRfp(agent(), ORG, RFP_ONE)).rfp.id, RFP_ONE);

  const revoked = await management.revoke(member(ADMIN), grant.id);
  assert.equal(revoked.status, "revoked");
  assert.deepEqual(revoked.revokedBy, { id: ADMIN, name: "organization_admin person" });
  await rejects(access.getRfp(agent(), ORG, RFP_ONE), "SUPPORT_GRANT_REQUIRED", 403);
  await rejects(access.listRfps(agent(), ORG, {}), "SUPPORT_GRANT_REQUIRED", 403);
  await rejects(access.listVendorResponses(agent(), ORG, RFP_ONE), "SUPPORT_GRANT_REQUIRED", 403);
  await rejects(access.listTicketRfps(agent(), TICKET, {}), "SUPPORT_GRANT_REQUIRED", 403);
  assert.deepEqual((await access.listGranted(agent())).grants, []);
  assert.equal(uses(audit).length, 1);
  assert.equal(audit.filter((e) => e.action === "support_access.revoked" && e.actorUserId === ADMIN && e.metadata.grantId === grant.id).length, 1);

  // Revoking again changes nothing and writes no second event.
  assert.equal((await management.revoke(member(OWNER), grant.id)).status, "revoked");
  assert.equal(audit.filter((e) => e.action === "support_access.revoked").length, 1);
});

test("AC: an expired grant is refused the moment it expires", async () => {
  const { management, access, advance } = setup();
  const grant = await management.create(member(OWNER), { expiresInDays: 1 });
  advance(DAY - 1);
  assert.equal((await access.getRfp(agent(), ORG, RFP_ONE)).grant.secondsRemaining, 0);
  advance(1);
  await rejects(access.getRfp(agent(), ORG, RFP_ONE), "SUPPORT_GRANT_REQUIRED", 403);
  await rejects(access.listRfps(agent(), ORG, {}), "SUPPORT_GRANT_REQUIRED", 403);
  await rejects(access.listVendorResponses(agent(), ORG, RFP_ONE), "SUPPORT_GRANT_REQUIRED", 403);
  assert.deepEqual((await access.listGranted(agent())).grants, []);
  assert.equal((await management.get(member(OWNER), grant.id)).status, "expired");
  await rejects(management.revoke(member(OWNER), grant.id), "SUPPORT_GRANT_EXPIRED", 409);
});

test("a grant for one RFP reaches that RFP only; a grant never reaches another organization", async () => {
  const { management, access, audit } = setup();
  const grant = await management.create(member(OWNER), { proposalId: RFP_ONE });
  audit.length = 0;

  assert.equal((await access.getRfp(agent(), ORG, RFP_ONE)).grant.scope, "rfp");
  const list = await access.listRfps(agent(), ORG, {});
  assert.deepEqual(list.rfps.map((r) => r.id), [RFP_ONE]);
  await rejects(access.getRfp(agent(), ORG, RFP_TWO), "PROPOSAL_NOT_FOUND", 404);
  await rejects(access.listVendorResponses(agent(), ORG, RFP_TWO), "PROPOSAL_NOT_FOUND", 404);
  // The other organization's RFP through this organization's grant, and that organization itself.
  await rejects(access.getRfp(agent(), ORG, OTHER_RFP), "PROPOSAL_NOT_FOUND", 404);
  await rejects(access.getRfp(agent(), OTHER_ORG, OTHER_RFP), "SUPPORT_GRANT_REQUIRED", 403);
  await rejects(access.listRfps(agent(), OTHER_ORG, {}), "SUPPORT_GRANT_REQUIRED", 403);

  assert.deepEqual(uses(audit).map((e) => [e.metadata.grantId, e.targetType, e.targetId, e.metadata.operation]), [
    [grant.id, "proposal", RFP_ONE, "rfp.read"],
    [grant.id, "proposal", RFP_ONE, "rfp.list"],
  ]);
  assert.equal(audit.filter((e) => e.action === "support_access.denied" && e.organizationId === ORG).length, 3);
  assert.equal(audit.filter((e) => e.action === "support_access.denied" && e.organizationId === OTHER_ORG).length, 2);
});

test("an organization-wide grant doesn't reach an RFP that isn't in the organization", async () => {
  const { management, access } = setup();
  await management.create(member(OWNER), {});
  await rejects(access.getRfp(agent(), ORG, OTHER_RFP), "PROPOSAL_NOT_FOUND", 404);
  await rejects(access.listVendorResponses(agent(), ORG, OTHER_RFP), "PROPOSAL_NOT_FOUND", 404);
  await rejects(access.getRfp(agent(), ORG, "not-an-id"), "PROPOSAL_NOT_FOUND", 404);
});

test("AC: the RFPs behind a ticket need a grant from the ticket's organization", async () => {
  const { management, access, audit } = setup();
  await rejects(access.listTicketRfps(agent(), TICKET, {}), "SUPPORT_GRANT_REQUIRED", 403);
  // A ticket the agent's support desk can't see is missing, grant or not.
  await rejects(access.listTicketRfps(agent({ organizationId: hex("8") }), TICKET, {}), "SUPPORT_TICKET_NOT_FOUND", 404);
  await rejects(access.listTicketRfps(agent(), "not-an-id", {}), "SUPPORT_TICKET_NOT_FOUND", 404);

  const grant = await management.create(member(OWNER), {});
  audit.length = 0;
  const behind = await access.listTicketRfps(agent(), TICKET, {});
  // Only the requester's RFPs, not the whole organization's.
  assert.deepEqual(behind.rfps.map((r) => r.id), [RFP_ONE]);
  assert.deepEqual(audit.map((e) => [e.action, e.metadata.grantId, e.metadata.operation, e.metadata.ticketId, e.actorUserId]), [
    ["support_access.used", grant.id, "ticket.rfp.list", TICKET, AGENT],
  ]);
});

test("\"granted to me\" lists active grants across organizations with scope and time left", async () => {
  const { management, access, advance } = setup();
  await management.create(member(OWNER), { proposalId: RFP_ONE, expiresInDays: 2 });
  await management.create(member(OTHER_OWNER, OTHER_ORG), { expiresInDays: 10 });
  const expiring = await management.create(member(ADMIN), { expiresInDays: 1 });
  advance(DAY);
  const { grants } = await access.listGranted(agent());
  assert.ok(!JSON.stringify(grants).includes("Spring summit"), "no RFP content in an unaudited list");
  assert.deepEqual(grants.map((g) => [g.organization.name, g.scope, g.rfp?.id ?? null, g.secondsRemaining]).sort(), [
    ["Acme Events", "rfp", RFP_ONE, 24 * 60 * 60],
    ["Other Co", "organization", null, 9 * 24 * 60 * 60],
  ]);
  assert.ok(!grants.some((g) => g.id === expiring.id));
});

class MockResponse {
  constructor() { this.statusCode = 200; this.jsonBody = undefined; }
  status(code) { this.statusCode = code; return this; }
  json(body) { this.jsonBody = body; return this; }
}

test("the controller builds the actor from the stored account and maps errors to problems", async () => {
  const seen = [];
  const controller = createSupportAccessController({
    grants: {
      async create(actor, input) { seen.push({ actor, input }); return { id: "g" }; },
      async revoke() { throw new SupportAccessError("SUPPORT_GRANT_NOT_FOUND", "Support access grant not found.", 404); },
    },
    access: {
      async getRfp(who, organizationId, proposalId) { seen.push({ who, organizationId, proposalId }); return { rfp: { id: proposalId } }; },
      async listGranted() { throw new Error("boom with internal detail"); },
    },
  });
  const rfpActor = member(OWNER).rfpActor;
  const memberRequest = { user: { userId: OWNER, organizationId: ORG, role: "customer", accountType: "planner" }, rfpActor, correlationId: "c-1", params: { grantId: "x" }, query: {}, body: { proposalId: RFP_ONE, expiresInDays: 3, reason: "r", organizationId: OTHER_ORG } };
  const created = new MockResponse();
  await controller.createGrant(memberRequest, created);
  assert.equal(created.statusCode, 201);
  assert.deepEqual(seen[0], { actor: { rfpActor, accountType: "planner", correlationId: "c-1" }, input: { proposalId: RFP_ONE, expiresInDays: 3, expiresAt: undefined, reason: "r" } });

  const missing = new MockResponse();
  await controller.revokeGrant(memberRequest, missing);
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.jsonBody, { success: false, code: "SUPPORT_GRANT_NOT_FOUND", message: "Support access grant not found." });

  const agentRequest = { user: { userId: AGENT, organizationId: STAFF_ORG, role: "admin", accountType: "admin" }, correlationId: "c-2", params: { organizationId: ORG, proposalId: RFP_ONE }, query: {}, body: {} };
  const read = new MockResponse();
  await controller.getGrantedRfp(agentRequest, read);
  assert.equal(read.statusCode, 200);
  assert.deepEqual(seen[1], { who: { adminId: AGENT, organizationId: STAFF_ORG, role: "admin", accountType: "admin", correlationId: "c-2" }, organizationId: ORG, proposalId: RFP_ONE });

  const broken = new MockResponse();
  const originalError = console.error;
  console.error = () => {};
  try { await controller.listGranted(agentRequest, broken); } finally { console.error = originalError; }
  assert.equal(broken.statusCode, 500);
  assert.equal(broken.jsonBody.code, "SUPPORT_ACCESS_INTERNAL_ERROR");
  assert.ok(!JSON.stringify(broken.jsonBody).includes("internal detail"));

  const anonymous = new MockResponse();
  await controller.listGrants({ params: {}, query: {}, body: {} }, anonymous);
  assert.equal(anonymous.statusCode, 401);
});

test("a grant whose audit event can't be written is closed again", async () => {
  const { management, access, rows, state } = setup();
  state.failAudit = true;
  await assert.rejects(management.create(member(OWNER), {}), /audit store down/);
  state.failAudit = false;
  assert.equal(rows.length, 1);
  assert.ok(rows[0].revokedAt, "the unaudited grant is revoked");
  await rejects(access.getRfp(agent(), ORG, RFP_ONE), "SUPPORT_GRANT_REQUIRED", 403);
});

test("a list under RFP grants logs a use only for the grants whose RFP was returned", async () => {
  const { management, access, audit } = setup();
  const two = await management.create(member(OWNER), { proposalId: RFP_TWO });
  audit.length = 0;
  // The ticket's requester owns RFP_ONE, which isn't granted: nothing is returned, nothing is logged as used.
  assert.deepEqual((await access.listTicketRfps(agent(), TICKET, {})).rfps, []);
  assert.equal(uses(audit).length, 0);
  assert.deepEqual((await access.listRfps(agent(), ORG, {})).rfps.map((r) => r.id), [RFP_TWO]);
  assert.deepEqual(uses(audit).map((e) => [e.metadata.grantId, e.targetId]), [[two.id, RFP_TWO]]);
});
