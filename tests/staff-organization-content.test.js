require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createStaffOrganizationContent } = require("../src/modules/staffAccess/application/readOrganizationContent");
const { StaffAccessError, STAFF_CONTENT_AUDIT, STAFF_CONTENT_RESOURCES } = require("../src/modules/staffAccess/domain");
const { createAdminOrganizationContentController } = require("../controller/adminOrganizationContentController");
const { isPlanStaff } = require("../src/modules/entitlements/application/manageOrganizationPlans");

// Owner decision 2026-11-17 (docs/DECISIONS.md): RFPilot staff VIEW everything in every
// organization with no grant; each read is recorded in the staff organization only. In-memory
// ports; the real-database proof is tests-integration/staff-organization-content.test.ts.

const hex = (c) => c.repeat(24);
const ACME = hex("a");
const OTHER = hex("b");
const STAFF_ORG = hex("d");
const STAFF = hex("7");
const OWNER = hex("1");
const PLANNER = hex("2");
const PROPOSAL = hex("c");
const OTHER_PROPOSAL = hex("f");
const TEMPLATE = hex("3");
const OTHER_TEMPLATE = hex("4");
const TICKET = hex("5");
// Tickets in Acme with no usable requester: missing, empty, and what String() makes of a missing id.
const ORPHAN_TICKETS = Object.fromEntries([undefined, null, "", "undefined", "null", "not-an-id"].map((requesterUserId, index) => {
  const id = `${index}f`.repeat(12);
  return [id, { id, organizationId: "a".repeat(24), requesterUserId }];
}));
const at = (iso) => new Date(iso);
const DAY_ONE = at("2026-10-01T00:00:00.000Z");

const staff = (overrides = {}) => ({ adminId: STAFF, organizationId: STAFF_ORG, role: "admin", accountType: "admin", correlationId: "corr-staff", ...overrides });
// A customer Owner, and a `users` account that holds a staff role.
const customerOwner = () => staff({ adminId: OWNER, organizationId: ACME, role: "customer", accountType: "planner" });
const usersAccountWithStaffRole = () => staff({ adminId: PLANNER, accountType: "planner", role: "super_admin" });

// What a careless reader could hand back. None of it may reach a response.
const SECRETS = {
  password: "$2a$10$hashhashhash", passwordHash: "$2a$10$hashhashhash", twoFactorSecret: "JBSWY3DPEHPK3PXP", recoveryCodes: ["aaaa-bbbb"],
  tokenHash: "deadbeefcafe", previousTokenHashes: ["0ldt0ken"], refreshToken: "rt_live_abc", sessionToken: "st_live_abc",
  publicAccessToken: "pag_live_abc", accessGrant: "grant_live_abc", clientSecretSealed: "sealed-sso-secret", googleId: "google-oauth-subject",
  federatedIdentities: [{ provider: "microsoft", subject: "ms-subject" }], aiRawResponse: { provider: "openai", raw: "provider-payload" },
  proposalSettings: { internal: "bookkeeping" }, candidateApplicationIds: ["cand-1"], delivery: { state: "sent" }, __v: 3,
};
const SECRET_VALUES = ["$2a$10$", "JBSWY3DPEHPK3PXP", "aaaa-bbbb", "deadbeefcafe", "0ldt0ken", "rt_live_abc", "st_live_abc", "pag_live_abc", "grant_live_abc",
  "sealed-sso-secret", "google-oauth-subject", "ms-subject", "provider-payload", "bookkeeping", "cand-1"];
const SECRET_KEYS = Object.keys(SECRETS);

const noSecrets = (value, label) => {
  const json = JSON.stringify(value);
  for (const secret of SECRET_VALUES) assert.equal(json.includes(secret), false, `${label}: ${secret}`);
  for (const key of SECRET_KEYS) assert.equal(json.includes(`"${key}"`), false, `${label}: key ${key}`);
};

const setup = () => {
  const audit = [];
  const state = { failAudit: false };
  const calls = [];
  const names = { [ACME]: "Acme Events", [OTHER]: "Other Co", [STAFF_ORG]: "RFPilot" };
  const proposalsBy = {
    [ACME]: [{ id: PROPOSAL, eventName: "Spring summit", status: "submitted", stage: "sent", isDraft: false, isArchived: false, startDate: null, endDate: null, createdAt: null, updatedAt: null, owner: { id: PLANNER, name: "Pat", email: "pat@acme.example" } }],
    [OTHER]: [{ id: OTHER_PROPOSAL, eventName: "Foreign gala", status: "unsubmitted", stage: null, isDraft: true, isArchived: false, startDate: null, endDate: null, createdAt: null, updatedAt: null, owner: null }],
  };
  const person = (id, name) => ({ id, name, email: `${name.toLowerCase()}@acme.example`, ...SECRETS });
  const templatesBy = {
    [ACME]: [
      { id: TEMPLATE, scope: "organization", title: "Annual meeting", description: "House style", eventName: "Annual", presentationLayout: "template-one", publishedAt: DAY_ONE, archived: false, archivedAt: null, createdAt: DAY_ONE, updatedAt: DAY_ONE, owner: person(OWNER, "Olive"), content: { event: { eventName: "Annual" }, production: { notes: "Line array" } }, ...SECRETS },
      { id: hex("6"), scope: "personal", title: "Pat's draft", description: "", eventName: "", presentationLayout: null, publishedAt: null, archived: false, archivedAt: null, createdAt: DAY_ONE, updatedAt: DAY_ONE, owner: person(PLANNER, "Pat"), content: { event: {} }, ...SECRETS },
    ],
    [OTHER]: [{ id: OTHER_TEMPLATE, scope: "organization", title: "Foreign template", description: "", eventName: "", presentationLayout: null, publishedAt: null, archived: false, archivedAt: null, createdAt: DAY_ONE, updatedAt: DAY_ONE, owner: null, content: { event: { eventName: "Foreign" } } }],
  };
  const organizations = {
    async organization(id) { calls.push(["organization", id]); return names[id] ? { id, name: names[id], createdAt: DAY_ONE, ...SECRETS } : null; },
    async organizations(limit) { calls.push(["organizations", limit]); return Object.entries(names).map(([id, name]) => ({ id, name, createdAt: DAY_ONE })); },
    async members(id, page) {
      calls.push(["members", id, page]);
      if (id !== ACME) return { members: [], total: 0 };
      return {
        total: 2,
        members: [
          { userId: OWNER, name: "Olive Owner", email: "olive@acme.example", roles: ["owner"], status: "active", teams: [], joinedAt: DAY_ONE, lastSignedInAt: at("2026-11-16T10:00:00.000Z"), ...SECRETS },
          { userId: PLANNER, name: "Pat Planner", email: "pat@acme.example", roles: ["team_manager", "planner"], status: "suspended", teams: [{ id: hex("8"), name: "West", archived: false, isManager: true, ...SECRETS }], joinedAt: DAY_ONE, lastSignedInAt: null, ...SECRETS },
        ],
      };
    },
    async pendingInvitations(id, limit) {
      calls.push(["pendingInvitations", id, limit]);
      return id === ACME
        ? { total: 1, invitations: [{ id: hex("9"), email: "new@acme.example", role: "planner", status: "pending", expiresAt: at("2026-11-24T00:00:00.000Z"), createdAt: DAY_ONE, ...SECRETS }] }
        : { total: 0, invitations: [] };
    },
    async teams(id) {
      calls.push(["teams", id]);
      return id === ACME ? [{ id: hex("8"), name: "West", archived: false, archivedAt: null, createdAt: DAY_ONE, memberCount: 3, managers: [person(PLANNER, "Pat")], ...SECRETS }] : [];
    },
    async templates(id, filter) {
      calls.push(["templates", id, filter]);
      const all = templatesBy[id] ?? [];
      return { templates: all, total: all.length };
    },
    async template(id, templateId) {
      calls.push(["template", id, templateId]);
      return (templatesBy[id] ?? []).find((template) => template.id === templateId) ?? null;
    },
    async vendors(id, filter) {
      calls.push(["vendors", id, filter]);
      return id === ACME
        ? { total: 1, vendors: [{ id: hex("e"), company: "Stage Audio", category: "AV", contacts: [{ name: "Vera", email: "vera@stage.example", ...SECRETS }], addedBy: OWNER, archived: false, archivedAt: null, createdAt: DAY_ONE, updatedAt: DAY_ONE, ...SECRETS }] }
        : { total: 0, vendors: [] };
    },
  };
  const proposals = {
    async list(id, filter) {
      calls.push(["proposals.list", id, filter]);
      const all = (proposalsBy[id] ?? []).filter((row) => !filter.ownerUserId || row.owner?.id === filter.ownerUserId);
      return { rfps: all, total: all.length };
    },
    async find(id, proposalId) {
      calls.push(["proposals.find", id, proposalId]);
      const row = (proposalsBy[id] ?? []).find((proposal) => proposal.id === proposalId);
      return row ? { rfp: { id: row.id, event: { eventName: row.eventName } }, owner: row.owner } : null;
    },
    async vendorResponses(id, proposalId) {
      calls.push(["proposals.vendorResponses", id, proposalId]);
      return (proposalsBy[id] ?? []).some((proposal) => proposal.id === proposalId) ? [{ id: hex("9"), vendorName: "Stage Audio", submittedBy: "Vera", email: "vera@stage.example", message: null, documentCount: 2, currentVersionNumber: 1, createdAt: null, updatedAt: null }] : [];
    },
  };
  const content = createStaffOrganizationContent({
    organizations, proposals,
    directory: { async findRfp(id, proposalId) { return (proposalsBy[id] ?? []).some((proposal) => proposal.id === proposalId) ? { id: proposalId } : null; } },
    tickets: { async find(ticketId) { return ticketId === TICKET ? { id: TICKET, organizationId: ACME, requesterUserId: PLANNER } : ORPHAN_TICKETS[ticketId] ?? null; } },
    audit: { async append(event) { if (state.failAudit) throw new Error("audit store down"); audit.push(event); } },
    isValidId: (value) => typeof value === "string" && /^[0-9a-f]{24}$/.test(value),
  });
  return { content, audit, state, calls };
};

// Every read the service offers, as (name, call, the resource it records, the record it opened).
const READS = [
  ["proposals", (c, who, org = ACME) => c.proposals(who, org, {}), "proposals", null],
  ["proposal", (c, who, org = ACME) => c.proposal(who, org, PROPOSAL), "proposal", PROPOSAL],
  ["vendorResponses", (c, who, org = ACME) => c.vendorResponses(who, org, PROPOSAL), "vendor_responses", PROPOSAL],
  ["members", (c, who, org = ACME) => c.members(who, org, {}), "members", null],
  ["teams", (c, who, org = ACME) => c.teams(who, org), "teams", null],
  ["templates", (c, who, org = ACME) => c.templates(who, org, {}), "templates", null],
  ["template", (c, who, org = ACME) => c.template(who, org, TEMPLATE), "template", TEMPLATE],
  ["vendors", (c, who, org = ACME) => c.vendors(who, org, {}), "vendors", null],
];

const DENIED = "platform.organization_content.denied";
// A denied event as [organization written to, actor, action, decision, reason, target, metadata].
const deniedShape = (event) => [event.organizationId, event.actorUserId, event.action, event.decision, event.reason, event.targetType, event.targetId ?? null, event.metadata];

const rejects = (promise, code, status) =>
  assert.rejects(promise, (error) => error instanceof StaffAccessError && error.code === code && error.status === status, `${code} ${status}`);

// ── Guard ────────────────────────────────────────────────────────────────────────────────────

test("staff only: a customer Owner and a `users` account holding a staff role are refused before anything is read", async () => {
  const { content, audit, calls } = setup();
  for (const who of [customerOwner(), usersAccountWithStaffRole(), staff({ accountType: undefined }), staff({ role: "customer" }), staff({ role: undefined })]) {
    for (const [name, read] of READS) await rejects(read(content, who), "STAFF_ACCESS_FORBIDDEN", 403).catch((error) => { throw new Error(`${name}: ${error.message}`); });
    await rejects(content.ticketProposals(who, TICKET, {}), "STAFF_ACCESS_FORBIDDEN", 403);
    await rejects(content.organizations(who), "STAFF_ACCESS_FORBIDDEN", 403);
  }
  assert.deepEqual(calls, [], "nothing was read");
  assert.deepEqual(audit, []);
});

test("every `admins` account with an admin role passes: the accounts isPlanStaff accepts", async () => {
  for (const role of ["admin", "super_admin", "superadmin", "Super Admin"]) {
    const { content } = setup();
    assert.equal(isPlanStaff(staff({ role })), true, role);
    for (const [name, read] of READS) assert.equal((await read(content, staff({ role }))).organizationId, ACME, `${role} ${name}`);
  }
  // The service uses the existing helper, not a variant of its own.
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/staffAccess/application/readOrganizationContent.ts"), "utf8");
  assert.match(source, /import \{ isPlanStaff, type PlanStaff \} from "\.\.\/\.\.\/entitlements\/application\/manageOrganizationPlans";/);
  assert.match(source, /if \(!isPlanStaff\(staff\)\) throw new StaffAccessError\("STAFF_ACCESS_FORBIDDEN"/);
  assert.doesNotMatch(source, /STAFF_ROLES|accountType ===/);
});

// ── Ids and organizations ────────────────────────────────────────────────────────────────────

// Was: "...; neither is recorded". A 400 still leaves nothing; a 404 now leaves a staff-side trace.
test("a malformed organization id is a 400 and records nothing; an unknown organization is a 404 recorded as denied in the staff organization", async () => {
  const { content, audit, calls } = setup();
  for (const [name, read, resource] of READS) {
    for (const bad of ["nope", "", hex("A"), `${ACME}0`, "../members"]) await rejects(read(content, staff(), bad), "INVALID_ORGANIZATION_ID", 400).catch((error) => { throw new Error(`${name}: ${error.message}`); });
    assert.deepEqual(audit, [], `${name}: a malformed id is not recorded`);
    await rejects(read(content, staff(), hex("e")), "ORGANIZATION_NOT_FOUND", 404).catch((error) => { throw new Error(`${name}: ${error.message}`); });
    assert.deepEqual(audit.map(deniedShape), [
      [STAFF_ORG, STAFF, DENIED, "denied", "organization_not_found", "organization", hex("e"), { agentAccountType: "admin", resource, organizationId: hex("e") }],
    ], name);
    assert.equal(audit[0].correlationId, "corr-staff");
    audit.length = 0;
  }
  assert.deepEqual(calls.filter(([method]) => method !== "organization"), [], "no content was read");
});

test("a malformed record id is a 400; a record that belongs to another organization is a 404, never served", async () => {
  const { content, audit } = setup();
  await rejects(content.proposal(staff(), ACME, "nope"), "INVALID_PROPOSAL_ID", 400);
  await rejects(content.vendorResponses(staff(), ACME, "nope"), "INVALID_PROPOSAL_ID", 400);
  await rejects(content.template(staff(), ACME, "nope"), "INVALID_TEMPLATE_ID", 400);
  // The other organization's records asked for through Acme's path.
  await rejects(content.proposal(staff(), ACME, OTHER_PROPOSAL), "PROPOSAL_NOT_FOUND", 404);
  await rejects(content.vendorResponses(staff(), ACME, OTHER_PROPOSAL), "PROPOSAL_NOT_FOUND", 404);
  await rejects(content.template(staff(), ACME, OTHER_TEMPLATE), "TEMPLATE_NOT_FOUND", 404);
  // And Acme's through the other organization's path.
  await rejects(content.proposal(staff(), OTHER, PROPOSAL), "PROPOSAL_NOT_FOUND", 404);
  await rejects(content.vendorResponses(staff(), OTHER, PROPOSAL), "PROPOSAL_NOT_FOUND", 404);
  await rejects(content.template(staff(), OTHER, TEMPLATE), "TEMPLATE_NOT_FOUND", 404);
  await rejects(content.proposal(staff(), ACME, hex("0")), "PROPOSAL_NOT_FOUND", 404);
  await rejects(content.templates(staff(), ACME, { scope: "everyone" }), "INVALID_FILTER", 400);
  await rejects(content.vendors(staff(), ACME, { status: { $ne: "x" } }), "INVALID_FILTER", 400);
  // 400s record nothing. Each 404 is one denied event in the staff organization, naming the
  // organization the path asked for, the kind of resource and the record id; none anywhere else.
  assert.deepEqual(audit.map(deniedShape), [
    [ACME, "proposal", OTHER_PROPOSAL], [ACME, "vendor_responses", OTHER_PROPOSAL], [ACME, "template", OTHER_TEMPLATE],
    [OTHER, "proposal", PROPOSAL], [OTHER, "vendor_responses", PROPOSAL], [OTHER, "template", TEMPLATE],
    [ACME, "proposal", hex("0")],
  ].map(([organizationId, resource, recordId]) => [
    STAFF_ORG, STAFF, DENIED, "denied", resource === "template" ? "template_not_found" : "proposal_not_found", "organization", organizationId,
    { agentAccountType: "admin", resource, organizationId, recordId },
  ]));
  assert.equal(audit.some((event) => event.organizationId !== STAFF_ORG), false, "never in the customer organization");
  audit.length = 0;
  // Each is found through its own organization.
  assert.equal((await content.proposal(staff(), OTHER, OTHER_PROPOSAL)).rfp.id, OTHER_PROPOSAL);
  assert.equal((await content.template(staff(), OTHER, OTHER_TEMPLATE)).template.id, OTHER_TEMPLATE);
});

test("every reader call is given the organization from the path, never the staff member's own", async () => {
  const { content, calls } = setup();
  for (const [, read] of READS) await read(content, staff());
  const organizationsRead = new Set(calls.map((call) => call[1]));
  assert.deepEqual([...organizationsRead], [ACME]);
  assert.equal(calls.some((call) => call.includes(STAFF_ORG)), false);
});

test("the proposals behind a ticket are the requester's only; a ticket with no requester lists nothing, never the whole organization", async () => {
  const { content, audit, calls } = setup();
  const behind = await content.ticketProposals(staff(), TICKET, {});
  assert.deepEqual(behind.rfps.map((row) => row.id), [PROPOSAL]);
  assert.equal(calls.find(([method]) => method === "proposals.list")[2].ownerUserId, PLANNER);
  calls.length = 0;
  audit.length = 0;

  for (const ticketId of Object.keys(ORPHAN_TICKETS)) {
    const empty = await content.ticketProposals(staff(), ticketId, { search: "summit" });
    assert.deepEqual(empty, { organizationId: ACME, rfps: [], pagination: { page: 1, perPage: 20, total: 0, totalPages: 1 } }, JSON.stringify(ORPHAN_TICKETS[ticketId].requesterUserId));
  }
  // The organization's proposals were never listed, with or without an owner filter.
  assert.deepEqual(calls.filter(([method]) => method.startsWith("proposals.")), []);
  // Each is still one read on the staff side, naming the ticket.
  assert.deepEqual(audit.map((event) => [event.organizationId, event.action, event.targetId, event.metadata.resource, event.metadata.ticketId]),
    Object.keys(ORPHAN_TICKETS).map((ticketId) => [STAFF_ORG, "platform.organization_content.read", ACME, "ticket_proposals", ticketId]));
  // The organization-wide list is unchanged: it passes no owner at all.
  await content.proposals(staff(), ACME, {});
  assert.equal("ownerUserId" in calls.find(([method]) => method === "proposals.list")[2], false);
});

// ── Shapes and allowlists ────────────────────────────────────────────────────────────────────

test("proposals: the list, detail and vendor responses keep the support-access shapes", async () => {
  const { content, calls } = setup();
  const list = await content.proposals(staff(), ACME, { page: "2", search: "  summit  " });
  assert.deepEqual(Object.keys(list), ["organizationId", "rfps", "pagination"]);
  assert.deepEqual(list.pagination, { page: 2, perPage: 20, total: 1, totalPages: 1 });
  assert.deepEqual(calls.find(([method]) => method === "proposals.list")[2], { search: "summit", skip: 20, limit: 20 });
  assert.deepEqual(Object.keys(list.rfps[0]), ["id", "eventName", "status", "stage", "isDraft", "isArchived", "startDate", "endDate", "createdAt", "updatedAt", "owner"]);
  const detail = await content.proposal(staff(), ACME, PROPOSAL);
  assert.deepEqual(Object.keys(detail), ["organizationId", "rfp", "owner"]);
  assert.deepEqual(detail.owner, { id: PLANNER, name: "Pat", email: "pat@acme.example" });
  const responses = await content.vendorResponses(staff(), ACME, PROPOSAL);
  assert.deepEqual(Object.keys(responses), ["organizationId", "proposalId", "vendorResponses"]);
  assert.deepEqual(Object.keys(responses.vendorResponses[0]), ["id", "vendorName", "submittedBy", "email", "message", "documentCount", "currentVersionNumber", "createdAt", "updatedAt"]);
  for (const answer of [list, detail, responses]) assert.equal("grant" in answer || "grants" in answer, false, "no grant is involved");
});

test("members: name, email, roles, status, teams and dates; pending invitations as their own list; nothing else", async () => {
  const { content, calls } = setup();
  const data = await content.members(staff(), ACME, {});
  assert.deepEqual(Object.keys(data), ["organizationId", "members", "pagination", "pendingInvitations", "pendingInvitationsTotal"]);
  for (const member of data.members) assert.deepEqual(Object.keys(member), ["userId", "name", "email", "roles", "status", "teams", "joinedAt", "lastSignedInAt"]);
  assert.deepEqual(data.members[1], {
    userId: PLANNER, name: "Pat Planner", email: "pat@acme.example", roles: ["team_manager", "planner"], status: "suspended",
    teams: [{ id: hex("8"), name: "West", archived: false, isManager: true }], joinedAt: DAY_ONE, lastSignedInAt: null,
  });
  assert.deepEqual(data.pagination, { page: 1, perPage: 50, total: 2, totalPages: 1 });
  assert.deepEqual(data.pendingInvitations, [{ id: hex("9"), email: "new@acme.example", role: "planner", status: "pending", expiresAt: at("2026-11-24T00:00:00.000Z"), createdAt: DAY_ONE }]);
  assert.equal(data.pendingInvitationsTotal, 1);
  assert.deepEqual(calls.find(([method]) => method === "members")[2], { skip: 0, limit: 50 });
  noSecrets(data, "members");
});

test("teams: name, archived, member count and managers; nothing else", async () => {
  const { content } = setup();
  const data = await content.teams(staff(), ACME);
  assert.deepEqual(Object.keys(data), ["organizationId", "teams"]);
  assert.deepEqual(data.teams, [{ id: hex("8"), name: "West", archived: false, archivedAt: null, createdAt: DAY_ONE, memberCount: 3, managers: [{ id: PLANNER, name: "Pat", email: "pat@acme.example" }] }]);
  noSecrets(data, "teams");
});

test("templates: organization and personal templates with their owner; content only on the detail", async () => {
  const { content, calls } = setup();
  const list = await content.templates(staff(), ACME, { scope: "personal", status: "active", search: "draft", page: "1" });
  assert.deepEqual(Object.keys(list), ["organizationId", "templates", "pagination"]);
  assert.deepEqual(calls.find(([method]) => method === "templates")[2], { search: "draft", scope: "personal", status: "active", skip: 0, limit: 20 });
  for (const template of list.templates) {
    assert.deepEqual(Object.keys(template), ["id", "scope", "title", "description", "eventName", "presentationLayout", "publishedAt", "archived", "archivedAt", "createdAt", "updatedAt", "owner"]);
    assert.deepEqual(Object.keys(template.owner), ["id", "name", "email"]);
  }
  assert.deepEqual(list.templates.map((template) => [template.scope, template.owner.id]), [["organization", OWNER], ["personal", PLANNER]]);
  const detail = await content.template(staff(), ACME, TEMPLATE);
  assert.deepEqual(Object.keys(detail), ["organizationId", "template"]);
  assert.deepEqual(detail.template.content, { event: { eventName: "Annual" }, production: { notes: "Line array" } });
  assert.deepEqual(Object.keys(detail.template), [...Object.keys(list.templates[0]), "content"]);
  noSecrets(list, "templates");
  noSecrets(detail, "template");
});

test("vendors: the organization vendor list as members read it; nothing else", async () => {
  const { content, calls } = setup();
  const data = await content.vendors(staff(), ACME, { status: "archived", category: "AV", search: "stage" });
  assert.deepEqual(Object.keys(data), ["organizationId", "vendors", "pagination"]);
  assert.deepEqual(calls.find(([method]) => method === "vendors")[2], { search: "stage", category: "AV", status: "archived", skip: 0, limit: 20 });
  assert.deepEqual(data.vendors, [{
    id: hex("e"), company: "Stage Audio", category: "AV", contacts: [{ name: "Vera", email: "vera@stage.example" }], addedBy: OWNER,
    archived: false, archivedAt: null, createdAt: DAY_ONE, updatedAt: DAY_ONE,
  }]);
  noSecrets(data, "vendors");
});

// ── Audit ────────────────────────────────────────────────────────────────────────────────────

test("audit: each read writes exactly one event in the staff organization, and none in the customer's", async () => {
  for (const [name, read, resource, recordId] of READS) {
    const { content, audit } = setup();
    await read(content, staff());
    assert.equal(audit.length, 1, name);
    const [event] = audit;
    assert.deepEqual(
      [event.organizationId, event.actorUserId, event.action, event.targetType, event.targetId, event.decision, event.reason, event.correlationId],
      [STAFF_ORG, STAFF, "platform.organization_content.read", "organization", ACME, "allowed", resource, "corr-staff"], name,
    );
    assert.deepEqual(event.metadata, { agentAccountType: "admin", resource, ...(recordId ? { recordId } : {}) }, name);
    assert.ok(STAFF_CONTENT_RESOURCES.includes(resource));
  }
  const { content, audit } = setup();
  await content.ticketProposals(staff(), TICKET, {});
  assert.deepEqual(audit.map((event) => [event.organizationId, event.targetId, event.metadata]), [[STAFF_ORG, ACME, { agentAccountType: "admin", resource: "ticket_proposals", ticketId: TICKET }]]);
  assert.equal(STAFF_CONTENT_AUDIT.read, "platform.organization_content.read");
});

test("audit: a ticket that isn't there, or a malformed ticket id, is a 404 recorded as denied in the staff organization", async () => {
  const { content, audit } = setup();
  await rejects(content.ticketProposals(staff(), hex("9"), {}), "SUPPORT_TICKET_NOT_FOUND", 404);
  await rejects(content.ticketProposals(staff(), "not-an-id", {}), "SUPPORT_TICKET_NOT_FOUND", 404);
  await rejects(content.ticketProposals(staff(), "x".repeat(500), {}), "SUPPORT_TICKET_NOT_FOUND", 404);
  // No organization is known for a missing ticket: no target, and the id asked for (cut to 64).
  assert.deepEqual(audit.map(deniedShape), [hex("9"), "not-an-id", "x".repeat(64)].map((ticketId) => [
    STAFF_ORG, STAFF, DENIED, "denied", "support_ticket_not_found", "organization", null, { agentAccountType: "admin", resource: "ticket_proposals", ticketId },
  ]));
  assert.equal(STAFF_CONTENT_AUDIT.denied, DENIED);
});

test("audit: a 404 stays a 404 when its denied event cannot be written, and the failure is logged", async () => {
  const NOT_FOUND = [
    ["organization", (c) => c.members(staff(), hex("e"), {}), "ORGANIZATION_NOT_FOUND"],
    ["proposal", (c) => c.proposal(staff(), ACME, OTHER_PROPOSAL), "PROPOSAL_NOT_FOUND"],
    ["vendor responses", (c) => c.vendorResponses(staff(), ACME, OTHER_PROPOSAL), "PROPOSAL_NOT_FOUND"],
    ["template", (c) => c.template(staff(), ACME, OTHER_TEMPLATE), "TEMPLATE_NOT_FOUND"],
    ["ticket", (c) => c.ticketProposals(staff(), hex("9"), {}), "SUPPORT_TICKET_NOT_FOUND"],
  ];
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args.join(" ")); };
  try {
    for (const [name, read, code] of NOT_FOUND) {
      const { content, audit, state } = setup();
      state.failAudit = true;
      await rejects(read(content), code, 404).catch((error) => { throw new Error(`${name}: ${error.message}`); });
      assert.deepEqual(audit, [], name);
    }
  } finally { console.error = originalError; }
  assert.equal(logged.length, NOT_FOUND.length, "each failure is logged, not swallowed");
  for (const line of logged) assert.match(line, /^Staff access error: a refused read could not be recorded: audit store down$/);
});

test("audit: the read fails, and returns nothing, when the event cannot be written", async () => {
  for (const [name, read] of READS) {
    const { content, audit, state } = setup();
    state.failAudit = true;
    await assert.rejects(read(content, staff()), /audit store down/, name);
    assert.deepEqual(audit, [], name);
  }
});

test("audit: no code path of the staff content service writes into the organization it reads", () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const service = read("src/modules/staffAccess/application/readOrganizationContent.ts");
  // One append in the whole service, and its organization is the staff member's.
  assert.equal((service.match(/audit\.append\(/g) ?? []).length, 1);
  assert.match(service, /audit\.append\(\{\s*organizationId: staff\.organizationId,/);
  // The older staff service no longer writes anything, and no longer knows the old actions.
  const older = read("src/modules/supportAccess/application/supportAccess.ts");
  assert.doesNotMatch(older.replace(/\/\*[\s\S]*?\*\//g, ""), /audit|SUPPORT_AUDIT|grants\./);
  // The Mongo reader performs no write and never touches the audit collection.
  const reader = read("src/modules/staffAccess/infrastructure/mongoStaffOrganizationReader.ts");
  assert.doesNotMatch(reader, /\.(create|insertMany|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|deleteOne|deleteMany|findOneAndDelete|replaceOne|bulkWrite|save)\(/);
  assert.doesNotMatch(reader, /securityAuditEventModel|SecurityAuditEvent/);
});

test("the read is not in the customer audit catalog, so it can never appear in an organization's audit log", () => {
  const { AUDIT_CATALOG, catalogEntry, isStaffOnlyAction } = require("../src/modules/auditLog/domain");
  assert.ok(!JSON.stringify(AUDIT_CATALOG).includes(STAFF_CONTENT_AUDIT.read));
  assert.equal(catalogEntry(STAFF_CONTENT_AUDIT.read), undefined);
  assert.equal(isStaffOnlyAction(STAFF_CONTENT_AUDIT.read), true);
});

// ── Mongo reader ─────────────────────────────────────────────────────────────────────────────

const argumentsOf = (source, openIndex) => {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return source.slice(openIndex + 1, i);
  }
  return source.slice(openIndex + 1);
};
const queryCalls = (source) =>
  [...source.matchAll(/\b([A-Z]\w+)\.(find|findOne|countDocuments|exists|aggregate|distinct)(?:<[^(]*>)?\(/g)]
    .map((match) => ({ model: match[1], method: match[2], args: argumentsOf(source, match.index + match[0].length - 1) }));

test("the Mongo reader names the path's organization in every query on customer data, and selects allowlists only", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/staffAccess/infrastructure/mongoStaffOrganizationReader.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const calls = queryCalls(code);
  assert.equal(calls.length, 16);
  const scoped = ({ model, args }) =>
    model === "Organization" ? /^\{ _id: oid\(organizationId\) \}$/.test(args) || args === "{}"
      : model === "User" ? /^\{ _id: \{ \$in: ids\.map\(oid\) \} \}$/.test(args)
        : /organizationId: (organization\b|oid\(organizationId\))/.test(args) || args === "filter";
  assert.deepEqual(calls.filter((call) => !scoped(call)).map((call) => `${call.model}.${call.method}(${call.args})`), []);
  // `filter` is the invitation filter, which is built from the path's organization.
  assert.match(code, /const filter = \{ organizationId: oid\(organizationId\), status: "pending" \};/);
  // The one query with no organization is the staff directory of organization names.
  assert.deepEqual(calls.filter((call) => call.args === "{}").map((call) => `${call.model}.${call.method}`), ["Organization.find"]);
  // The check reads each call's own arguments, so a scoped neighbour can't vouch for an unscoped query.
  const tampered = code.replace("Team.find({ organizationId: organization })", "Team.find({})");
  assert.notEqual(tampered, code);
  assert.deepEqual(queryCalls(tampered).filter((call) => !scoped(call)).map((call) => `${call.model}.${call.method}`), ["Team.find"]);

  // Every find selects an explicit field list, and no stored document is spread into a view.
  const finds = calls.filter((call) => call.method === "find" || call.method === "findOne");
  const selects = [...code.matchAll(/\.select\(("[^"]+"|[A-Z_]+)\)/g)].map((match) => match[1]);
  assert.equal(selects.length, finds.length);
  assert.doesNotMatch(code, /\.\.\.(doc|row|team|membership|contact|user|rest)\b/);
  assert.match(code, /const TEMPLATE_SUMMARY_FIELDS = "ownerUserId scope title description presentationLayout publishedAt archived archivedAt createdAt updatedAt content\.event\.eventName";/);
  for (const forbidden of ["password", "tokenHash", "previousTokenHashes", "tokenIssuedAt", "googleId", "federatedIdentities", "delivery", "twoFactor", "recovery", "refresh", "session", "clientSecret", "sso", "phone", "avatar", "invitedBy", "publishedBy"]) {
    assert.ok(!new RegExp(forbidden, "i").test(code), forbidden);
  }
  // Models it may read. No session, two-factor, SSO, public-grant or proposal model.
  assert.deepEqual([...new Set(calls.map((call) => call.model))].sort(), ["Invitation", "Organization", "OrganizationMembership", "OrganizationVendor", "ProposalTemplate", "Team", "TeamMembership", "User"]);
});

test("the proposal detail is an allowlist of proposal fields, and vendor responses select summary fields only", () => {
  const { STAFF_PROPOSAL_FIELDS } = require("../src/modules/supportAccess/infrastructure/mongoSupportAccessRepository");
  for (const hidden of ["organizationId", "__v", "candidateApplicationIds", "proposalSettings", "password", "token", "accessGrant"]) assert.equal(STAFF_PROPOSAL_FIELDS.includes(hidden), false, hidden);
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/supportAccess/infrastructure/mongoSupportAccessRepository.ts"), "utf8");
  assert.match(source, /\.select\(STAFF_PROPOSAL_FIELDS\.join\(" "\)\)/);
  assert.match(source, /for \(const field of STAFF_PROPOSAL_FIELDS\) if \(doc\[field\] !== undefined\) rfp\[field\] = doc\[field\];/);
  assert.doesNotMatch(source, /\.\.\.rest\b|HIDDEN_FIELDS/);
  assert.match(source, /\.select\("vendorName submittedBy email message documents currentVersionNumber createdAt updatedAt"\)/);
  // The public-access grants behind vendor links are never read on the staff side.
  assert.doesNotMatch(source, /publicAccessGrant|PublicAccessGrant/);
});

test("the proposal detail gives staff the filename of each private upload, never its stored URL or object key", () => {
  const { staffProposalFields } = require("../src/modules/supportAccess/infrastructure/mongoSupportAccessRepository");
  const stored = {
    brandGuideFiles: ["https://dxg-files.s3.amazonaws.com/DXG/proposal-files-private/user-1/1731800000000-0-brand_guide.pdf"],
    eventLogoFiles: ["https://nyc3.digitaloceanspaces.com/rfp/proposal-files-private/user-1/1731800000001-0-logo.png", "https://cdn.example.test/DXG/proposal-files-private/user-1/1731800000002-1-logo%20dark.png"],
    referenceFiles: ["s3://dxg-files/DXG/proposal-files-private/user-1/1731800000003-0-run_of_show.xlsx", "legacy-reference.pdf"],
    venueDocs: ["DXG/proposal-files-private/user-1/1731800000004-0-floor_plan.pdf"],
    ndaDocumentFiles: ["https://dxg-files.s3.us-east-1.amazonaws.com/DXG/proposal-files-private/user-1/1731800000005-0-nda.docx"],
    scenicInspirationFiles: ["http://files.example.test/proposal-files-private/user-1/1731800000006-0-mood_board.pdf"],
    venueCoiFiles: ["/uploads/proposal-files-private/user-1/1731800000007-0-venue_coi.pdf"],
    ndaRequired: "YES",
    notes: "See the brand guide",
  };
  const doc = { _id: PROPOSAL, organizationId: ACME, __v: 2, proposalSettings: { internal: true }, event: { eventName: "Spring summit" }, uploads: stored };
  const view = staffProposalFields(doc);
  const PRIVATE = ["brandGuideFiles", "eventLogoFiles", "referenceFiles", "venueDocs", "ndaDocumentFiles", "scenicInspirationFiles", "venueCoiFiles"];
  assert.deepEqual(PRIVATE.map((field) => view.uploads[field]), [
    ["brand_guide.pdf"], ["logo.png", "logo dark.png"], ["run_of_show.xlsx", "legacy-reference.pdf"], ["floor_plan.pdf"],
    ["nda.docx"], ["mood_board.pdf"], ["venue_coi.pdf"],
  ]);
  for (const field of PRIVATE) {
    for (const value of view.uploads[field]) {
      assert.equal(typeof value, "string", field);
      for (const forbidden of ["http", "s3", "/"]) assert.equal(value.includes(forbidden), false, `${field}: ${value} contains ${forbidden}`);
    }
  }
  const json = JSON.stringify(view);
  for (const forbidden of ["proposal-files-private", "amazonaws", "digitaloceanspaces", "user-1", "://"]) assert.equal(json.includes(forbidden), false, forbidden);
  // The rest of the section, and of the proposal, is as stored; the stored document is not changed.
  assert.equal(view.uploads.ndaRequired, "YES");
  assert.equal(view.uploads.notes, "See the brand guide");
  assert.deepEqual(view.event, { eventName: "Spring summit" });
  assert.deepEqual(Object.keys(view).sort(), ["event", "uploads"]);
  assert.equal(stored.brandGuideFiles[0].startsWith("https://"), true);
  // A proposal with no uploads section, or an odd one, does not break the read.
  assert.deepEqual(staffProposalFields({ event: {} }), { event: {} });
  assert.deepEqual(staffProposalFields({ uploads: null }), { uploads: null });

  // The Mongo reader builds the detail through this function and nothing else.
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/supportAccess/infrastructure/mongoSupportAccessRepository.ts"), "utf8");
  assert.match(source, /const rfp = staffProposalFields\(doc\);/);
  assert.match(source, /if \(rfp\.uploads !== undefined\) rfp\.uploads = redactPrivateUploadUrls\(rfp\.uploads\);/);
});

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────

const fakeResponse = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};
const request = (overrides = {}) => ({
  user: { userId: STAFF, organizationId: STAFF_ORG, role: "admin", accountType: "admin", roles: ["dxg_admin"] },
  correlationId: "corr-http", params: { organizationId: ACME, proposalId: PROPOSAL, templateId: TEMPLATE }, query: {}, body: {}, ...overrides,
});
const HANDLERS = ["proposals", "proposal", "vendorResponses", "members", "teams", "templates", "template", "vendors"];

test("controller: customer → 403, `users` account with a staff role → 403, staff → 200, on every handler", async () => {
  const { content, audit } = setup();
  const controller = createAdminOrganizationContentController(content);
  assert.deepEqual(Object.keys(controller).sort(), [...HANDLERS].sort());
  for (const handler of HANDLERS) {
    const owner = fakeResponse();
    await controller[handler](request({ user: { userId: OWNER, organizationId: ACME, role: "customer", accountType: "planner", roles: ["owner"] } }), owner);
    assert.deepEqual([owner.statusCode, owner.body.code, owner.body.data], [403, "STAFF_ACCESS_FORBIDDEN", undefined], handler);

    const impostor = fakeResponse();
    await controller[handler](request({ user: { userId: PLANNER, organizationId: STAFF_ORG, role: "admin", accountType: "planner", roles: ["dxg_admin"] } }), impostor);
    assert.deepEqual([impostor.statusCode, impostor.body.code, impostor.body.data], [403, "STAFF_ACCESS_FORBIDDEN", undefined], handler);

    const anonymous = fakeResponse();
    await controller[handler](request({ user: undefined }), anonymous);
    assert.equal(anonymous.statusCode, 401, handler);
    assert.equal(audit.length, 0, handler);

    // The organization comes from the path: one in the query or the body is ignored.
    const ok = fakeResponse();
    await controller[handler](request({ query: { organizationId: OTHER }, body: { organizationId: OTHER } }), ok);
    assert.deepEqual([ok.statusCode, ok.body.success, ok.body.data.organizationId], [200, true, ACME], handler);
    assert.deepEqual([audit[0].organizationId, audit[0].actorUserId, audit[0].targetId, audit[0].correlationId], [STAFF_ORG, STAFF, ACME, "corr-http"], handler);
    audit.length = 0;

    const invalid = fakeResponse();
    await controller[handler](request({ params: { organizationId: "nope", proposalId: PROPOSAL, templateId: TEMPLATE } }), invalid);
    assert.deepEqual([invalid.statusCode, invalid.body], [400, { success: false, code: "INVALID_ORGANIZATION_ID", message: "That is not an organization id." }], handler);

    const missing = fakeResponse();
    await controller[handler](request({ params: { organizationId: hex("e"), proposalId: PROPOSAL, templateId: TEMPLATE } }), missing);
    assert.deepEqual([missing.statusCode, missing.body], [404, { success: false, code: "ORGANIZATION_NOT_FOUND", message: "Organization not found." }], handler);
    // The malformed id left nothing; the 404 left one denied event, in the staff organization.
    assert.deepEqual(audit.map((event) => [event.organizationId, event.actorUserId, event.action, event.decision, event.targetId, event.correlationId]), [[STAFF_ORG, STAFF, DENIED, "denied", hex("e"), "corr-http"]], handler);
    audit.length = 0;
  }

  const broken = createAdminOrganizationContentController({ members: async () => { throw new Error("mongo exploded: secret detail"); } });
  const failed = fakeResponse();
  const originalError = console.error;
  console.error = () => {};
  try { await broken.members(request(), failed); } finally { console.error = originalError; }
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.body.code, "STAFF_ACCESS_INTERNAL_ERROR");
  assert.ok(!JSON.stringify(failed.body).includes("secret detail"));
});

const guardRefusesCustomers = (guard, label) => {
  for (const roles of [["owner"], ["organization_admin"], ["team_manager"], ["planner"], ["viewer"], ["knowledge_approver"], []]) {
    const res = fakeResponse();
    let passed = false;
    guard({ user: { roles } }, res, () => { passed = true; });
    assert.equal(passed, false, `${label} as ${roles}`);
    assert.equal(res.statusCode, 403);
  }
  for (const roles of [["dxg_admin"], ["super_admin"]]) {
    let passed = false;
    guard({ user: { roles } }, fakeResponse(), () => { passed = true; });
    assert.equal(passed, true, `${label} as ${roles}`);
  }
};

test("routes: read-only, each behind authenticate, the staff role guard and the per-staff rate limit", () => {
  const router = require("../routes/adminOrganizationContentRoute").default;
  const { staffContentReads } = require("../routes/adminOrganizationContentRoute");
  const { authenticate } = require("../middleware/auth");
  const routes = router.stack.filter((layer) => layer.route).map((layer) => layer.route);
  assert.deepEqual(routes.map((route) => `${Object.keys(route.methods).join(",").toUpperCase()} ${route.path}`), [
    "GET /admin/organizations/:organizationId/proposals",
    "GET /admin/organizations/:organizationId/proposals/:proposalId",
    "GET /admin/organizations/:organizationId/proposals/:proposalId/vendor-responses",
    "GET /admin/organizations/:organizationId/members",
    "GET /admin/organizations/:organizationId/teams",
    "GET /admin/organizations/:organizationId/templates",
    "GET /admin/organizations/:organizationId/templates/:templateId",
    "GET /admin/organizations/:organizationId/vendors",
  ]);
  assert.equal(router.stack.every((layer) => layer.route), true, "no router-level middleware that could skip the guard");
  for (const route of routes) {
    assert.equal(route.stack.length, 4, route.path);
    assert.equal(route.stack[0].handle, authenticate, route.path);
    guardRefusesCustomers(route.stack[1].handle, route.path);
    assert.equal(route.stack[2].handle, staffContentReads, route.path);
  }
  const source = fs.readFileSync(path.join(__dirname, "../routes/adminOrganizationContentRoute.ts"), "utf8");
  assert.doesNotMatch(source, /router\.(post|put|patch|delete|all|use)\(/);
  assert.match(source, /name: "organization-content-read",\s+limit: 300,\s+windowMs: 15 \* 60_000,\s+identity: \(req: Request\) => \(req as AuthRequest\)\.user\?\.userId/);
  assert.match(fs.readFileSync(path.join(__dirname, "../server.ts"), "utf8"), /app\.use\("\/api\/v1", adminOrganizationContentRoutes\);/);
});

test("routes: the older staff routes have the same guard, and the customer grant routes still need organization:manage", () => {
  const router = require("../routes/supportAccessRoute").default;
  const { staffContentReads } = require("../routes/adminOrganizationContentRoute");
  const { authenticate } = require("../middleware/auth");
  const routes = router.stack.filter((layer) => layer.route).map((layer) => layer.route);
  const staffRoutes = routes.filter((route) => route.path.startsWith("/admin/"));
  assert.deepEqual(staffRoutes.map((route) => `${Object.keys(route.methods).join(",").toUpperCase()} ${route.path}`), [
    "GET /admin/support-access/grants",
    "GET /admin/support-access/organizations/:organizationId/rfps",
    "GET /admin/support-access/organizations/:organizationId/rfps/:proposalId",
    "GET /admin/support-access/organizations/:organizationId/rfps/:proposalId/vendor-responses",
    "GET /admin/support/tickets/:ticketId/rfps",
  ]);
  for (const route of staffRoutes) {
    assert.equal(route.stack[0].handle, authenticate, route.path);
    guardRefusesCustomers(route.stack[1].handle, route.path);
    // Every staff route, the organization list included: it names every organization.
    assert.equal(route.stack.length, 4, route.path);
    assert.equal(route.stack[2].handle, staffContentReads, route.path);
  }
  const customerRoutes = routes.filter((route) => route.path.startsWith("/organization/support-grants"));
  assert.equal(customerRoutes.length, 4, "the customer grant endpoints still answer");
  for (const route of customerRoutes) {
    assert.equal(route.stack[0].handle, authenticate, route.path);
    for (const roles of [["team_manager"], ["planner"], ["viewer"], []]) {
      let passed = false;
      route.stack[1].handle({ user: { roles } }, fakeResponse(), () => { passed = true; });
      assert.equal(passed, false, `${route.path} as ${roles}`);
    }
  }
});
