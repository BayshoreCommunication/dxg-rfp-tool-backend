require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSupportGrantManagement } = require("../src/modules/supportAccess/application/manageSupportGrants");
const { createSupportAccess, STANDING_WINDOW_DAYS } = require("../src/modules/supportAccess/application/supportAccess");
const { createStaffOrganizationContent } = require("../src/modules/staffAccess/application/readOrganizationContent");
const { SupportAccessError, resolveGrantExpiry, coveringGrant, grantStatus } = require("../src/modules/supportAccess/domain");
const { createSupportAccessController } = require("../controller/supportAccessController");

// ORG-404: support access grants. In-memory ports; the real-database proof is
// tests-integration/support-access-grants.test.ts.
//
// Owner decision, 2026-11-17 (docs/DECISIONS.md): RFPilot staff read every organization's content
// with no grant, and what they do is recorded on the RFPilot side only. The customer grant
// endpoints still answer (the tests for them are unchanged); the staff-side tests below state the
// new rule: a grant gates nothing, and no read writes into the customer organization.

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
  const tickets = { [TICKET]: { id: TICKET, organizationId: ORG, requesterUserId: PLANNER } };
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
      clock,
      content: createStaffOrganizationContent({
        organizations: {
          async organization(id) { return ORGANIZATIONS[id] ? { id, name: ORGANIZATIONS[id], createdAt: START } : null; },
          async organizations() { return Object.entries(ORGANIZATIONS).map(([id, name]) => ({ id, name, createdAt: START })); },
        },
        proposals: reader, directory, audit: auditWriter, isValidId,
        tickets: { async find(ticketId) { return tickets[ticketId] ?? null; } },
      }),
    }),
    rows, audit, state,
    advance(ms) { now = new Date(now.getTime() + ms); },
  };
};

const ORGANIZATIONS = { [ORG]: "Acme Events", [OTHER_ORG]: "Other Co", [STAFF_ORG]: "RFPilot" };
const inCustomerOrganizations = (audit) => audit.filter((e) => e.organizationId !== STAFF_ORG);
const reads = (audit) => audit.filter((e) => e.action === "platform.organization_content.read");

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
  const { access, audit } = setup();
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
  assert.equal(audit.length, 0);
  for (const role of ["admin", "super_admin", "superadmin"]) {
    assert.equal((await access.getRfp(agent({ role }), ORG, RFP_ONE)).rfp.id, RFP_ONE);
  }
});

// Was: "without a grant every read of customer RFP data is refused and recorded as denied".
test("without a grant every read of customer proposal data succeeds, and nothing is written in the customer organization", async () => {
  const { access, audit, rows } = setup();
  assert.equal(rows.length, 0, "no grant exists");
  assert.deepEqual((await access.listRfps(agent(), ORG, {})).rfps.map((r) => r.id).sort(), [RFP_ONE, RFP_TWO].sort());
  assert.equal((await access.getRfp(agent(), ORG, RFP_ONE)).rfp.id, RFP_ONE);
  assert.equal((await access.listVendorResponses(agent(), ORG, RFP_ONE)).vendorResponses.length, 1);
  assert.deepEqual((await access.listRfps(agent(), OTHER_ORG, {})).rfps.map((r) => r.id), [OTHER_RFP]);
  assert.deepEqual(inCustomerOrganizations(audit), []);
  assert.equal(audit.some((e) => e.action.startsWith("support_access.")), false, "used / denied are no longer written");
  assert.equal(reads(audit).length, 4);

  // An organization that doesn't exist is a 404, a malformed id a 400; neither leaves a row.
  await rejects(access.getRfp(agent(), hex("0"), RFP_ONE), "ORGANIZATION_NOT_FOUND", 404);
  await rejects(access.listRfps(agent(), "not-an-id", {}), "INVALID_ORGANIZATION_ID", 400);
  assert.equal(audit.length, 4);
});

// Was: "every use writes an audit event naming the agent, the grant and the object" (in the
// customer organization). The event is now written in the staff organization only.
test("every read writes one event in the staff organization naming the staff member, the organization and the object", async () => {
  const { management, access, audit } = setup();
  const grant = await management.create(member(OWNER), {});
  audit.length = 0;

  const list = await access.listRfps(agent(), ORG, {});
  assert.deepEqual(list.rfps.map((r) => r.id).sort(), [RFP_ONE, RFP_TWO].sort());
  const detail = await access.getRfp(agent(), ORG, RFP_ONE);
  assert.equal(detail.rfp.id, RFP_ONE);
  const responses = await access.listVendorResponses(agent(), ORG, RFP_ONE);
  assert.equal(responses.vendorResponses.length, 1);

  assert.deepEqual(audit.map((e) => [e.action, e.decision, e.organizationId, e.actorUserId, e.targetType, e.targetId, e.reason, e.metadata.resource, e.metadata.recordId ?? null, e.correlationId]), [
    ["platform.organization_content.read", "allowed", STAFF_ORG, AGENT, "organization", ORG, "proposals", "proposals", null, "corr-agent"],
    ["platform.organization_content.read", "allowed", STAFF_ORG, AGENT, "organization", ORG, "proposal", "proposal", RFP_ONE, "corr-agent"],
    ["platform.organization_content.read", "allowed", STAFF_ORG, AGENT, "organization", ORG, "vendor_responses", "vendor_responses", RFP_ONE, "corr-agent"],
  ]);
  assert.equal(audit.some((e) => "grantId" in e.metadata), false);

  // The customer's own view of the grant shows no staff activity: nothing was written there.
  const view = await management.get(member(ADMIN), grant.id);
  assert.equal(view.activity.useCount, 0);
  assert.deepEqual(view.events, []);
});

// The answers keep the shape the deployed admin app parses: where they carried the grant, they
// carry one standing organization-wide entry whose id is the organization's.
test("the staff answers keep their shape, with a standing organization-wide entry in place of the grant", async () => {
  const { management, access } = setup();
  await management.create(member(OWNER), { proposalId: RFP_ONE, expiresInDays: 1 });
  const standing = { id: ORG, scope: "organization", proposalId: null, expiresAt: new Date(START.getTime() + STANDING_WINDOW_DAYS * DAY), secondsRemaining: STANDING_WINDOW_DAYS * 24 * 60 * 60 };
  const list = await access.listRfps(agent(), ORG, { page: "1" });
  assert.deepEqual(Object.keys(list).sort(), ["grants", "organizationId", "pagination", "rfps"]);
  assert.deepEqual(list.grants, [standing]);
  assert.deepEqual(list.pagination, { page: 1, perPage: 20, total: 2, totalPages: 1 });
  const detail = await access.getRfp(agent(), ORG, RFP_TWO);
  assert.deepEqual(Object.keys(detail).sort(), ["grant", "organizationId", "owner", "rfp"]);
  assert.deepEqual(detail.grant, standing);
  const responses = await access.listVendorResponses(agent(), ORG, RFP_TWO);
  assert.deepEqual(Object.keys(responses).sort(), ["grant", "organizationId", "proposalId", "vendorResponses"]);
  assert.deepEqual(responses.grant, standing);
  const behind = await access.listTicketRfps(agent(), TICKET, {});
  assert.deepEqual(Object.keys(behind).sort(), ["grants", "organizationId", "pagination", "rfps"]);
  assert.deepEqual(behind.grants, [standing]);
});

test("nothing is returned when the audit event can't be written", async () => {
  const { access, state } = setup();
  state.failAudit = true;
  await assert.rejects(access.getRfp(agent(), ORG, RFP_ONE), /audit store down/);
  await assert.rejects(access.listRfps(agent(), ORG, {}), /audit store down/);
  await assert.rejects(access.listVendorResponses(agent(), ORG, RFP_ONE), /audit store down/);
  await assert.rejects(access.listTicketRfps(agent(), TICKET, {}), /audit store down/);
});

// Was: "AC: a revoked grant is refused on the very next request".
test("revoking a grant still works for the customer and changes nothing for staff reads", async () => {
  const { management, access, audit } = setup();
  const grant = await management.create(member(OWNER), {});
  assert.equal((await access.getRfp(agent(), ORG, RFP_ONE)).rfp.id, RFP_ONE);

  const revoked = await management.revoke(member(ADMIN), grant.id);
  assert.equal(revoked.status, "revoked");
  assert.deepEqual(revoked.revokedBy, { id: ADMIN, name: "organization_admin person" });
  assert.equal((await access.getRfp(agent(), ORG, RFP_ONE)).rfp.id, RFP_ONE);
  assert.equal((await access.listRfps(agent(), ORG, {})).rfps.length, 2);
  assert.equal((await access.listVendorResponses(agent(), ORG, RFP_ONE)).vendorResponses.length, 1);
  assert.equal((await access.listTicketRfps(agent(), TICKET, {})).rfps.length, 1);
  assert.equal(audit.filter((e) => e.action === "support_access.revoked" && e.actorUserId === ADMIN && e.metadata.grantId === grant.id).length, 1);
  // The customer organization holds the customer's own two events and nothing from staff.
  assert.deepEqual(inCustomerOrganizations(audit).map((e) => e.action), ["support_access.granted", "support_access.revoked"]);

  // Revoking again changes nothing and writes no second event.
  assert.equal((await management.revoke(member(OWNER), grant.id)).status, "revoked");
  assert.equal(audit.filter((e) => e.action === "support_access.revoked").length, 1);
});

// Was: "AC: an expired grant is refused the moment it expires".
test("an expired grant reads as expired for the customer and changes nothing for staff reads", async () => {
  const { management, access, advance } = setup();
  const grant = await management.create(member(OWNER), { expiresInDays: 1 });
  advance(DAY);
  assert.equal((await access.getRfp(agent(), ORG, RFP_ONE)).rfp.id, RFP_ONE);
  assert.equal((await access.listRfps(agent(), ORG, {})).rfps.length, 2);
  assert.equal((await access.listVendorResponses(agent(), ORG, RFP_ONE)).vendorResponses.length, 1);
  assert.equal((await management.get(member(OWNER), grant.id)).status, "expired");
  await rejects(management.revoke(member(OWNER), grant.id), "SUPPORT_GRANT_EXPIRED", 409);
});

// Was: "a grant for one RFP reaches that RFP only; a grant never reaches another organization".
test("a grant for one proposal does not narrow what staff read; a proposal is never served through another organization", async () => {
  const { management, access, audit } = setup();
  await management.create(member(OWNER), { proposalId: RFP_ONE });
  audit.length = 0;

  assert.deepEqual((await access.listRfps(agent(), ORG, {})).rfps.map((r) => r.id).sort(), [RFP_ONE, RFP_TWO].sort());
  assert.equal((await access.getRfp(agent(), ORG, RFP_TWO)).rfp.id, RFP_TWO);
  // Another organization's proposal asked for through this organization's path: not found, both ways.
  await rejects(access.getRfp(agent(), ORG, OTHER_RFP), "PROPOSAL_NOT_FOUND", 404);
  await rejects(access.listVendorResponses(agent(), ORG, OTHER_RFP), "PROPOSAL_NOT_FOUND", 404);
  await rejects(access.getRfp(agent(), OTHER_ORG, RFP_ONE), "PROPOSAL_NOT_FOUND", 404);
  await rejects(access.listVendorResponses(agent(), OTHER_ORG, RFP_ONE), "PROPOSAL_NOT_FOUND", 404);
  // Through its own organization it is found.
  assert.equal((await access.getRfp(agent(), OTHER_ORG, OTHER_RFP)).rfp.id, OTHER_RFP);

  // A refused lookup records nothing; nothing at all is written in a customer organization.
  assert.deepEqual(audit.map((e) => [e.organizationId, e.targetId, e.metadata.resource, e.metadata.recordId ?? null]), [
    [STAFF_ORG, ORG, "proposals", null],
    [STAFF_ORG, ORG, "proposal", RFP_TWO],
    [STAFF_ORG, OTHER_ORG, "proposal", OTHER_RFP],
  ]);
});

test("a proposal that isn't in the organization is not found, and a malformed proposal id is refused", async () => {
  const { access, audit } = setup();
  await rejects(access.getRfp(agent(), ORG, OTHER_RFP), "PROPOSAL_NOT_FOUND", 404);
  await rejects(access.listVendorResponses(agent(), ORG, OTHER_RFP), "PROPOSAL_NOT_FOUND", 404);
  await rejects(access.getRfp(agent(), ORG, hex("0")), "PROPOSAL_NOT_FOUND", 404);
  await rejects(access.getRfp(agent(), ORG, "not-an-id"), "INVALID_PROPOSAL_ID", 400);
  await rejects(access.listVendorResponses(agent(), ORG, "not-an-id"), "INVALID_PROPOSAL_ID", 400);
  assert.equal(audit.length, 0);
});

// Was: "AC: the RFPs behind a ticket need a grant from the ticket's organization".
test("the proposals behind a ticket are the requester's, in the ticket's organization, with no grant", async () => {
  const { access, audit, rows } = setup();
  await rejects(access.listTicketRfps(agent(), "not-an-id", {}), "SUPPORT_TICKET_NOT_FOUND", 404);
  await rejects(access.listTicketRfps(agent(), hex("9"), {}), "SUPPORT_TICKET_NOT_FOUND", 404);
  // A member holding a staff role is not RFPilot Support.
  await rejects(access.listTicketRfps(agent({ accountType: "planner" }), TICKET, {}), "SUPPORT_ACCESS_FORBIDDEN", 403);
  assert.equal(audit.length, 0);

  assert.equal(rows.length, 0, "no grant exists");
  // The staff member's own organization decides nothing: the ticket's organization is read.
  const behind = await access.listTicketRfps(agent({ organizationId: hex("8") }), TICKET, {});
  assert.equal(behind.organizationId, ORG);
  // Only the requester's proposals, not the whole organization's.
  assert.deepEqual(behind.rfps.map((r) => r.id), [RFP_ONE]);
  assert.deepEqual(audit.map((e) => [e.action, e.organizationId, e.targetId, e.metadata.resource, e.metadata.ticketId, e.actorUserId]), [
    ["platform.organization_content.read", hex("8"), ORG, "ticket_proposals", TICKET, AGENT],
  ]);
});

// Was: "\"granted to me\" lists active grants across organizations with scope and time left".
test("\"granted to me\" lists every organization as one standing organization-wide entry, whatever grants exist", async () => {
  const { management, access, advance, audit } = setup();
  const before = (await access.listGranted(agent())).grants;
  await management.create(member(OWNER), { proposalId: RFP_ONE, expiresInDays: 2 });
  await management.create(member(OTHER_OWNER, OTHER_ORG), { expiresInDays: 10 });
  advance(3 * DAY);
  audit.length = 0;
  const { grants } = await access.listGranted(agent());
  assert.ok(!JSON.stringify(grants).includes("Spring summit"), "no proposal content in an unrecorded list");
  assert.deepEqual(grants.map((g) => [g.id, g.organization.id, g.organization.name, g.scope, g.proposalId, g.rfp, g.reason, g.secondsRemaining]), [
    [ORG, ORG, "Acme Events", "organization", null, null, null, STANDING_WINDOW_DAYS * 24 * 60 * 60],
    [OTHER_ORG, OTHER_ORG, "Other Co", "organization", null, null, null, STANDING_WINDOW_DAYS * 24 * 60 * 60],
    [STAFF_ORG, STAFF_ORG, "RFPilot", "organization", null, null, null, STANDING_WINDOW_DAYS * 24 * 60 * 60],
  ]);
  assert.deepEqual(before.map((g) => g.id), grants.map((g) => g.id), "the list does not depend on grants");
  for (const grant of grants) assert.equal(new Date(grant.expiresAt).getTime(), START.getTime() + (3 + STANDING_WINDOW_DAYS) * DAY);
  assert.equal(audit.length, 0, "organization names only: nothing is recorded");
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
  const { management, rows, state } = setup();
  state.failAudit = true;
  await assert.rejects(management.create(member(OWNER), {}), /audit store down/);
  state.failAudit = false;
  assert.equal(rows.length, 1);
  assert.ok(rows[0].revokedAt, "the unaudited grant is revoked");
});

// Was: "a list under RFP grants logs a use only for the grants whose RFP was returned". Grants no
// longer scope a list, and one read is one staff-side event whatever it returned.
test("each list is one staff-side event, including an empty one", async () => {
  const { access, audit } = setup();
  assert.deepEqual((await access.listRfps(agent(), STAFF_ORG, {})).rfps, []);
  assert.deepEqual((await access.listRfps(agent(), ORG, {})).rfps.length, 2);
  assert.deepEqual(audit.map((e) => [e.organizationId, e.targetId, e.metadata.resource]), [[STAFF_ORG, STAFF_ORG, "proposals"], [STAFF_ORG, ORG, "proposals"]]);
});

