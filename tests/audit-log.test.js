require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createAuditLog, AUDIT_EXPORT_MAX, AUDIT_PAGE_MAX } = require("../src/modules/auditLog/application/readAuditLog");
const { AUDIT_CATALOG, AUDIT_CATEGORIES, AuditLogError, STAFF_ONLY_ACTIONS, VISIBLE_ACTIONS, catalogEntry, isStaffOnlyAction, auditCsv, csvCell, visibleDetails, visibleReason } = require("../src/modules/auditLog/domain");
const { hasOrganizationAction } = require("../src/modules/identity/domain/authorizationPolicy");

// ORG-407: the organization audit log view (PRD P0-10).

const ORG = "a".repeat(24);
const OTHER_ORG = "9".repeat(24);
const OWNER = "b".repeat(24);
const PLANNER = "c".repeat(24);
const STAFF = "d".repeat(24);
const actor = (role, organizationId = ORG) => ({ organizationId, userId: OWNER, roles: [role] });

// In-memory reader with the Mongo reader's contract: organization-scoped, newest first.
const fakeEvents = (rows, members = { [ORG]: { [OWNER]: { name: "Olive Owner", email: "olive@example.test" }, [PLANNER]: { name: "", email: "pat@example.test" } } }) => {
  const nameLookups = [];
  const calls = [];
  return {
    nameLookups, calls,
    isValidId: (value) => /^[0-9a-f]{24}$/i.test(value),
    async list(organizationId, filter, limit) {
      calls.push({ organizationId, filter, limit });
      return rows
        .filter((row) => row.organizationId === organizationId && filter.actions.includes(row.action))
        .filter((row) => !filter.actorUserId || row.actorUserId === filter.actorUserId)
        .filter((row) => (!filter.from || row.createdAt >= filter.from) && (!filter.to || row.createdAt < filter.to))
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
        .filter((row) => !filter.before || row.createdAt < filter.before.createdAt || (+row.createdAt === +filter.before.createdAt && row.id < filter.before.id))
        .slice(0, limit)
        .map(({ organizationId: _o, ...row }) => row);
    },
    async memberNames(organizationId, userIds) {
      nameLookups.push(...userIds);
      return new Map(userIds.filter((id) => members[organizationId]?.[id]).map((id) => [id, members[organizationId][id]]));
    },
  };
};

let seq = 0;
const event = (overrides = {}) => {
  seq += 1;
  return {
    id: seq.toString(16).padStart(24, "0"),
    organizationId: ORG,
    action: "organization.member.role_changed",
    actorUserId: OWNER,
    targetType: "organization_membership",
    targetId: PLANNER,
    decision: "allowed",
    reason: "role_changed",
    metadata: { previousRole: "planner", role: "viewer", version: 4 },
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, seq)),
    ...overrides,
  };
};

// ── PRD P0-10: every listed action is catalogued, and a writer for it exists ────────────────────

const P0_10 = {
  "login (success)": [["auth.session.created", "src/modules/auth/application/manageSessions.ts"]],
  "login (fail)": [["auth.login.failed", "src/modules/auth/application/credentialAuthentication.ts"]],
  "2FA changes": [
    ["auth.two_factor.enrolled", "src/modules/twoFactor/application/manageTwoFactor.ts"],
    ["auth.two_factor.disabled", "src/modules/twoFactor/application/manageTwoFactor.ts"],
    ["auth.two_factor.reset", "src/modules/twoFactor/application/manageTwoFactor.ts"],
    ["auth.two_factor.recovery_codes_regenerated", "src/modules/twoFactor/application/manageTwoFactor.ts"],
  ],
  "invite sent/accepted/revoked": [
    ["organization.invitation.sent", "src/modules/invitations/application/manageInvitations.ts"],
    ["organization.invitation.accepted", "src/modules/invitations/application/manageInvitations.ts"],
    ["organization.invitation.revoked", "src/modules/invitations/application/manageInvitations.ts"],
  ],
  "role/team change": [
    ["organization.member.role_changed", "src/modules/organizationMembers/application/manageMembers.ts"],
    ["organization.member.teams_changed", "src/modules/organizationMembers/application/manageMembers.ts"],
    ["team.member_added", "src/modules/teams/application/manageTeams.ts"],
    ["team.member_removed", "src/modules/teams/application/manageTeams.ts"],
    ["team.manager_changed", "src/modules/teams/application/manageTeams.ts"],
  ],
  deactivation: [["organization.member.deactivated", "src/modules/organizationMembers/application/manageMembers.ts"]],
  "ownership transfer": [["organization.ownership.transferred", "src/modules/organizationMembers/application/manageMembers.ts"]],
  "share granted/revoked": [
    ["proposal.share_granted", "src/modules/rfpSharing/application/manageRfpShares.ts"],
    ["proposal.share_revoked", "src/modules/rfpSharing/application/manageRfpShares.ts"],
  ],
  // "support grant/use/revoke" was listed here until 2026-11-17. The owner then decided that staff
  // activity and support access are not shown to customers (docs/DECISIONS.md), so those actions
  // left the catalog: see "staff activity and support access are never shown to a customer" below.
  "org settings change": [["organization.settings.updated", "src/modules/organizationProfile/application/manageOrganizationProfile.ts"]],
};

test("every action in PRD P0-10 is in the audit view's catalog and still has its writer", () => {
  for (const [requirement, actions] of Object.entries(P0_10)) {
    for (const [action, file] of actions) {
      assert.ok(AUDIT_CATALOG[action], `${requirement}: ${action} is not shown in the audit log`);
      assert.ok(fs.readFileSync(path.join(__dirname, "..", file), "utf8").includes(`"${action}"`), `${requirement}: ${file} no longer writes ${action}`);
    }
  }
  const categories = new Set(AUDIT_CATEGORIES.map((category) => category.key));
  for (const [action, entry] of Object.entries(AUDIT_CATALOG)) assert.ok(categories.has(entry.category), action);
});

test("token rotation and staff-side bookkeeping are not part of the customer's view", () => {
  for (const hidden of ["auth.refresh.rotated", "admin.organization.legacy_customer.placed", "job.create", "platform.organization_account.read", "platform.organization_content.read"]) {
    assert.equal(AUDIT_CATALOG[hidden], undefined);
    assert.equal(catalogEntry(hidden), undefined);
  }
});

// Owner decision, 2026-11-17: what RFPilot staff do is recorded on the RFPilot side only.
test("no staff-attributed or support-access action is in the customer catalog (decision 2026-11-17)", () => {
  assert.deepEqual([...STAFF_ONLY_ACTIONS].sort(), [
    "organization.legacy_customer.placed", "organization.legacy_customer.placement_rolled_back", "organization.plan_changed",
    "support_access.denied", "support_access.granted", "support_access.revoked", "support_access.used",
  ]);
  for (const action of STAFF_ONLY_ACTIONS) {
    assert.equal(AUDIT_CATALOG[action], undefined, action);
    assert.equal(catalogEntry(action), undefined, action);
    assert.equal(VISIBLE_ACTIONS.includes(action), false, action);
  }
  assert.deepEqual(Object.keys(AUDIT_CATALOG).filter(isStaffOnlyAction), []);
  assert.equal(AUDIT_CATEGORIES.some((category) => category.key === "support_access"), false);
  // No label a customer reads names RFPilot staff, and no entry carries a staff-actor marker.
  for (const [action, entry] of Object.entries(AUDIT_CATALOG)) {
    assert.doesNotMatch(entry.label, /RFPilot|Support access/i, action);
    assert.deepEqual(Object.keys(entry).sort(), ["category", "label"], action);
  }
  for (const category of AUDIT_CATEGORIES) assert.doesNotMatch(category.label, /RFPilot|Support access/i);
});

// ── Who may read ────────────────────────────────────────────────────────────────────────────

test("only Owner and Admin hold audit:read", async () => {
  const log = createAuditLog({ events: fakeEvents([event()]) });
  for (const role of ["owner", "organization_admin"]) {
    assert.equal(hasOrganizationAction([role], "audit:read"), true, role);
    assert.equal((await log.list(actor(role), {})).events.length, 1, role);
    assert.ok(log.filters(actor(role)).categories.length > 0);
    assert.equal((await log.exportCsv(actor(role), {})).rows, 1);
  }
  for (const role of ["team_manager", "planner", "viewer", "dxg_producer", "knowledge_editor", "knowledge_approver", "customer", ""]) {
    assert.equal(hasOrganizationAction([role], "audit:read"), false, role);
    for (const run of [() => log.list(actor(role), {}), () => log.exportCsv(actor(role), {}), async () => log.filters(actor(role))]) {
      await assert.rejects(run, (error) => error instanceof AuditLogError && error.status === 403 && error.code === "AUDIT_LOG_FORBIDDEN", role);
    }
  }
});

test("the routes authenticate, then require audit:read, and are open on every plan", () => {
  const { authenticate } = require("../middleware/auth");
  const routes = require("../routes/auditLogRoute").default.stack.filter((layer) => layer.route).map((layer) => layer.route);
  assert.deepEqual(routes.map((route) => `${Object.keys(route.methods)[0].toUpperCase()} ${route.path}`), [
    "GET /organization/audit-events", "GET /organization/audit-events/filters", "GET /organization/audit-events/export",
  ]);
  for (const route of routes) {
    const handlers = route.stack.map((layer) => layer.handle);
    assert.equal(handlers[0], authenticate, route.path);
    assert.ok(handlers.length >= 3, `${route.path} has no authorization step`);
    assert.equal(handlers.some((handle) => handle.planFeatures), false, route.path);
  }
  const source = fs.readFileSync(path.join(__dirname, "../routes/auditLogRoute.ts"), "utf8");
  assert.match(source, /const read = \[authenticate, authorizeAction\("audit:read"\)\]/);
  assert.doesNotMatch(source, /router\.(post|put|patch|delete)\(/);
});

// ── Tenant scope ────────────────────────────────────────────────────────────────────────────

test("a reader sees only their own organization's events, whatever the query says", async () => {
  const mine = event();
  const theirs = event({ organizationId: OTHER_ORG, metadata: { role: "FOREIGN" } });
  const events = fakeEvents([mine, theirs]);
  const log = createAuditLog({ events });
  for (const query of [{}, { organizationId: OTHER_ORG }, { actor: OWNER, organizationId: OTHER_ORG }]) {
    const page = await log.list(actor("owner"), query);
    assert.deepEqual(page.events.map((e) => e.id), [mine.id]);
    assert.equal((await log.exportCsv(actor("owner"), query)).csv.includes("FOREIGN"), false);
  }
  assert.ok(events.calls.every((call) => call.organizationId === ORG));
  assert.deepEqual((await log.list(actor("owner", OTHER_ORG), {})).events.map((e) => e.id), [theirs.id]);
});

test("a name is shown only for a member of the reader's organization", async () => {
  const outsider = "e".repeat(24);
  const log = createAuditLog({ events: fakeEvents([event({ actorUserId: outsider, targetId: outsider }), event({ actorUserId: null })]) });
  const [system, unknown] = (await log.list(actor("owner"), {})).events;
  assert.deepEqual(unknown.actor, { kind: "unknown", id: outsider, name: "Unknown user" });
  assert.equal(unknown.target.name, null);
  assert.deepEqual(system.actor, { kind: "system", id: null, name: "System" });
});

// ── RFPilot staff activity is not shown (owner decision, 2026-11-17) ────────────────────────────

const staffRows = () => [
  event({ action: "support_access.used", actorUserId: STAFF, targetType: "proposal", targetId: "f".repeat(24), decision: "allowed", reason: "rfp.read", metadata: { grantId: "g1", operation: "rfp.read", agentAccountType: "admin", ticketId: "t1" } }),
  event({ action: "support_access.denied", actorUserId: STAFF, targetType: "organization", targetId: ORG, decision: "denied", reason: "no_active_grant", metadata: { operation: "rfp.list", agentAccountType: "admin" } }),
  event({ action: "support_access.granted", targetType: "support_access_grant", targetId: "g1", decision: "created", reason: "customer_granted", metadata: { grantId: "g1", scope: "rfp" } }),
  event({ action: "support_access.revoked", targetType: "support_access_grant", targetId: "g1", decision: "revoked", reason: "customer_revoked", metadata: { grantId: "g1" } }),
  event({ action: "organization.plan_changed", actorUserId: STAFF, targetType: "organization", targetId: ORG, decision: "allowed", reason: "staff_plan_change", metadata: { fromPlan: "free_trial", toPlan: "full_access", note: "Agreed with Jane on the phone" } }),
  event({ action: "organization.legacy_customer.placed", actorUserId: STAFF, targetType: "user", targetId: PLANNER, decision: "allowed", reason: "legacy_customer_placed", metadata: { role: "planner" } }),
  event({ action: "organization.legacy_customer.placement_rolled_back", actorUserId: STAFF, targetType: "user", targetId: PLANNER, decision: "allowed", reason: "placement_rolled_back", metadata: {} }),
  event({ action: "platform.organization_content.read", actorUserId: STAFF, targetType: "organization", targetId: ORG, decision: "allowed", reason: "proposals", metadata: { resource: "proposals" } }),
  event({ action: "platform.organization_content.denied", actorUserId: STAFF, targetType: "organization", targetId: ORG, decision: "denied", reason: "proposal_not_found", metadata: { resource: "proposal", organizationId: ORG } }),
  event({ action: "platform.organization_account.read", actorUserId: STAFF, targetType: "organization", targetId: ORG, decision: "allowed", reason: "organization_account_detail", metadata: {} }),
];

test("staff activity and support access are never shown to a customer: list, filters and CSV", async () => {
  const visible = event();
  const rows = [...staffRows(), visible];
  // Even a reader that ignores the action filter (a bug) cannot surface a hidden row.
  const leaky = { ...fakeEvents(rows), async list(organizationId) { return rows.filter((row) => row.organizationId === organizationId).map(({ organizationId: _o, ...row }) => row); } };
  for (const events of [fakeEvents(rows, { [ORG]: { [OWNER]: { name: "Olive Owner", email: "olive@example.test" }, [STAFF]: { name: "Staff Name", email: "staff@example.test" } } }), leaky]) {
    const log = createAuditLog({ events });
    for (const role of ["owner", "organization_admin"]) {
      const page = await log.list(actor(role), {});
      assert.deepEqual(page.events.map((e) => e.id), [visible.id]);
      assert.equal(page.events.some((e) => e.actor.kind === "support"), false);
      const exported = await log.exportCsv(actor(role), {});
      assert.equal(exported.rows, 1);
      for (const hidden of ["Support", "support_access", "plan_changed", "legacy_customer", "platform.", "Staff Name", "Jane", STAFF]) {
        assert.equal(JSON.stringify(page).includes(hidden), false, hidden);
        assert.equal(exported.csv.includes(hidden), false, hidden);
      }
    }
    // The reader never looks up a staff id's name, even when that id happens to be a member's
    // and even when the store hands hidden rows back. (Restores the pin the removed
    // "the staff id is never looked up" tests held.)
    assert.equal(events.nameLookups.includes(STAFF), false);
    assert.ok(events.nameLookups.includes(OWNER), "the visible row's member is looked up, so the pin is not vacuous");
  }
});

test("a hidden event cannot be asked for by action, category or actor filter", async () => {
  const events = fakeEvents(staffRows());
  const log = createAuditLog({ events });
  const refused = (query) => assert.rejects(() => log.list(actor("owner"), query), (error) => error instanceof AuditLogError && error.status === 400 && error.code === "AUDIT_FILTER_INVALID");
  for (const action of [...STAFF_ONLY_ACTIONS, "platform.organization_content.read", "platform.organization_account.read", "admin.organization.legacy_customer.placed"]) {
    await refused({ action });
    await assert.rejects(() => log.exportCsv(actor("owner"), { action }), (error) => error.status === 400);
  }
  await refused({ category: "support_access" });
  // "support" was the staff actor option. It is still accepted (the dashboard released before the
  // decision sends it) and selects nothing; the staff member's id selects nothing either.
  for (const query of [{ actor: "support" }, { actor: STAFF }, { actor: "support", category: "settings" }, { actor: "support", category: "members" }]) {
    assert.deepEqual((await log.list(actor("owner"), query)).events, [], JSON.stringify(query));
    assert.equal((await log.exportCsv(actor("owner"), query)).rows, 0, JSON.stringify(query));
  }
  // The reader is never asked for a hidden action.
  for (const call of events.calls) for (const action of call.filter.actions) assert.equal(isStaffOnlyAction(action), false, action);
});

test("the filter options offer no support-access category, no staff action and no staff actor", () => {
  const filters = createAuditLog({ events: fakeEvents([]) }).filters(actor("owner"));
  assert.deepEqual(Object.keys(filters), ["categories"]);
  assert.equal(filters.categories.some((category) => category.key === "support_access"), false);
  const offered = filters.categories.flatMap((category) => category.actions.map((action) => action.value));
  assert.deepEqual(offered.filter(isStaffOnlyAction), []);
  assert.deepEqual([...offered].sort(), [...VISIBLE_ACTIONS].sort());
  assert.doesNotMatch(JSON.stringify(filters), /RFPilot|support/i);
});

// ── Filters and paging ──────────────────────────────────────────────────────────────────────

test("filters by user, action, category and date, and pages by cursor without gaps", async () => {
  const day = (d, h = 12) => new Date(Date.UTC(2026, 10, d, h));
  const rows = [
    event({ action: "auth.session.created", actorUserId: PLANNER, targetType: "refresh_session", targetId: "s1", decision: "created", reason: "authentication_succeeded", metadata: {}, createdAt: day(1) }),
    event({ action: "auth.login.failed", actorUserId: PLANNER, targetType: "user", targetId: PLANNER, decision: "denied", reason: "wrong_password", metadata: { method: "password" }, createdAt: day(2) }),
    event({ action: "organization.invitation.sent", targetType: "invitation", targetId: "i1", decision: "created", reason: "invited", metadata: { role: "planner" }, createdAt: day(3) }),
    event({ createdAt: day(4) }),
    event({ action: "auth.refresh.rotated", createdAt: day(4, 13) }),
    event({ createdAt: day(5) }),
  ];
  const log = createAuditLog({ events: fakeEvents(rows) });
  const ids = async (query) => (await log.list(actor("owner"), query)).events.map((e) => e.action);

  assert.equal((await ids({})).includes("auth.refresh.rotated"), false);
  assert.deepEqual(await ids({ actor: PLANNER }), ["auth.login.failed", "auth.session.created"]);
  assert.deepEqual(await ids({ action: "auth.login.failed" }), ["auth.login.failed"]);
  assert.deepEqual(await ids({ category: "sign_in" }), ["auth.login.failed", "auth.session.created"]);
  assert.deepEqual(await ids({ category: "sign_in", action: "organization.invitation.sent" }), []);
  assert.deepEqual(await ids({ from: "2026-11-03", to: "2026-11-04" }), ["organization.member.role_changed", "organization.invitation.sent"]);
  assert.deepEqual(await ids({ from: "2026-11-04T12:00:00.000Z", to: "2026-11-04T12:00:00.001Z" }), ["organization.member.role_changed"]);
  assert.deepEqual(await ids({ to: "2026-11-01" }), ["auth.session.created"]);

  const seen = [];
  let cursor;
  do {
    const page = await log.list(actor("owner"), { limit: "2", ...(cursor ? { cursor } : {}) });
    assert.ok(page.events.length <= 2);
    seen.push(...page.events.map((e) => e.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, rows.filter((r) => r.action !== "auth.refresh.rotated").reverse().map((r) => r.id));

  const signedIn = (await log.list(actor("owner"), { action: "auth.session.created" })).events[0];
  assert.deepEqual(signedIn.target, { type: "refresh_session", id: null, name: null });
  const member = (await log.list(actor("owner"), { action: "auth.login.failed" })).events[0];
  assert.deepEqual(member.actor, { kind: "member", id: PLANNER, name: "pat@example.test", email: "pat@example.test" });
  assert.equal(member.target.name, "pat@example.test");
  assert.equal(member.label, "Sign-in failed");
  assert.equal(member.category, "sign_in");
});

test("events sharing a timestamp page in a stable order", async () => {
  const at = new Date(Date.UTC(2026, 10, 2));
  const rows = [event({ createdAt: at }), event({ createdAt: at }), event({ createdAt: at })];
  const log = createAuditLog({ events: fakeEvents(rows) });
  const first = await log.list(actor("owner"), { limit: "2" });
  const second = await log.list(actor("owner"), { limit: "2", cursor: first.nextCursor });
  assert.deepEqual([...first.events, ...second.events].map((e) => e.id), rows.map((r) => r.id).reverse());
  assert.equal(second.nextCursor, null);
});

test("bad filters are refused with 400 and the page size is capped", async () => {
  const events = fakeEvents([event()]);
  const log = createAuditLog({ events });
  for (const query of [
    { action: "auth.refresh.rotated" }, { action: "nope" }, { action: "constructor" }, { action: "__proto__" }, { action: "toString" },
    { from: "1" }, { from: "2026-11-01T00:00:00" }, { to: "2026" }, { category: "nope" }, { actor: "not-an-id" }, { actor: { $ne: null } },
    { from: "yesterday" }, { to: "13/13/2026" }, { from: "2026-11-05", to: "2026-11-01T00:00:00Z" }, { cursor: "!!!" }, { cursor: Buffer.from("1:xyz").toString("base64url") },
    { limit: "0" }, { limit: "abc" },
  ]) {
    await assert.rejects(() => log.list(actor("owner"), query), (error) => error instanceof AuditLogError && error.status === 400 && error.code === "AUDIT_FILTER_INVALID", JSON.stringify(query));
  }
  await log.list(actor("owner"), { limit: "100000" });
  assert.equal(events.calls.at(-1).limit, AUDIT_PAGE_MAX + 1);
});

// ── What a row exposes ──────────────────────────────────────────────────────────────────────

test("details are an allowlist of scalars and never carry contact details or secrets", () => {
  assert.deepEqual(visibleDetails({
    role: "planner", previousRole: "viewer", signedOutMembers: 3, placedInTeam: false,
    email: "someone@example.test", domain: "x@y.test", token: "t", secretChanged: true, passwordHash: "h", version: 9, domains: ["a.test"], from: { nested: true }, to: "", runId: "r1",
    targetOrganizationId: OTHER_ORG, holdingOrganizationId: OTHER_ORG, agentAccountType: "admin", value: "x".repeat(201),
  }), { role: "planner", previousRole: "viewer", signedOutMembers: 3, placedInTeam: false });
  for (const metadata of [null, undefined, "text", ["a"], 4]) assert.deepEqual(visibleDetails(metadata), {});
  assert.equal(visibleReason("no_active_grant"), "no_active_grant");
  assert.equal(visibleReason("Customer asked on the phone, see jane@example.test"), null);
  assert.equal(visibleReason(""), null);
});

// ── CSV export ──────────────────────────────────────────────────────────────────────────────

test("CSV cells that a spreadsheet would run as a formula are neutralized", () => {
  for (const cell of ["=1+1", "+1", "-1", "@SUM(A1)", "  =HYPERLINK(\"http://x\")", "\t=1", "\r=1", "=cmd|' /C calc'!A0"]) {
    assert.ok(csvCell(cell).startsWith(`"'`), cell);
  }
  assert.equal(csvCell('a "quoted", value'), '"a ""quoted"", value"');
  assert.equal(csvCell("plain"), '"plain"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(12), '"12"');
});

test("the export applies the list's filters and tenant, and escapes member-controlled text", async () => {
  const evil = { [ORG]: { [OWNER]: { name: '=HYPERLINK("http://evil.test","x")', email: "+olive@example.test" }, [PLANNER]: { name: "@pat", email: "pat@example.test" } } };
  const rows = [
    event({ metadata: { role: "=1+1", previousRole: "planner" } }),
    event({ action: "auth.login.failed", actorUserId: PLANNER, targetType: "user", decision: "denied", reason: "wrong_password", metadata: {} }),
    event({ organizationId: OTHER_ORG, reason: "foreign_reason" }),
  ];
  const events = fakeEvents(rows, evil);
  const log = createAuditLog({ events });
  const all = await log.exportCsv(actor("owner"), {});
  assert.equal(all.rows, 2);
  assert.equal(all.truncated, false);
  assert.equal(all.csv.includes("foreign_reason"), false);
  const lines = all.csv.trimEnd().split("\r\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '"Time (UTC)","Action","Category","Result","Actor","Actor email","Actor type","Target type","Target","Reason","Details","Event ID"');
  // No cell starts with a formula character.
  for (const line of lines.slice(1)) {
    for (const cell of line.slice(1, -1).split('","')) assert.doesNotMatch(cell, /^\s*[=+\-@]/, cell);
  }
  assert.ok(all.csv.includes(`"'=HYPERLINK(""http://evil.test"",""x"")"`));
  assert.ok(all.csv.includes(`"'+olive@example.test"`));
  assert.ok(all.csv.includes(`"'@pat"`));

  const filtered = await log.exportCsv(actor("owner"), { actor: PLANNER, category: "sign_in" });
  assert.equal(filtered.rows, 1);
  assert.ok(filtered.csv.includes("Sign-in failed"));
  assert.equal(filtered.csv.includes("Role changed"), false);
  assert.deepEqual(events.calls.at(-1).filter.actorUserId, PLANNER);
  assert.equal(events.calls.at(-1).limit, AUDIT_EXPORT_MAX + 1);
  // An export ignores paging: it is the whole filtered set up to the cap.
  assert.equal(events.calls.at(-1).filter.before, undefined);
  await assert.rejects(() => log.exportCsv(actor("owner"), { from: "nope" }), (error) => error.status === 400);
  assert.equal(auditCsv([]).trimEnd().split("\r\n").length, 1);

  // Customer-facing wording is "Proposal" (2026-11-12): the label says so, and the file no longer
  // rewords internal names to "rfp". Target type, detail keys and values are exported as stored,
  // so a stored code that contains "rfp" (support access `scope: rfp`, `operation: rfp.read`) stays.
  const shared = createAuditLog({ events: fakeEvents([event({ action: "proposal.share_granted", targetType: "proposal", targetId: "f".repeat(24), decision: "created", reason: "shared", metadata: { proposalId: "f".repeat(24), domain: "proposals.example.test" } })]) });
  const sharedCsv = (await shared.exportCsv(actor("owner"), {})).csv.split("\r\n")[1];
  assert.ok(sharedCsv.includes('"Proposal shared"'));
  assert.ok(sharedCsv.includes('"Proposal sharing"'));
  assert.ok(sharedCsv.includes('"proposal"'));
  assert.ok(sharedCsv.includes("proposalId: " + "f".repeat(24)));
  assert.ok(sharedCsv.includes("domain: proposals.example.test"));
  assert.equal(/rfp/i.test(sharedCsv), false, "nothing in a sharing row is stored with rfp");
});
