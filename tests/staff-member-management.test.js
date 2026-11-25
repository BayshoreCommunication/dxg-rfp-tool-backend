require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createStaffMemberManagement } = require("../src/modules/staffAccess/application/manageOrganizationMembers");
const { StaffAccessError, StaffMemberError, STAFF_MEMBER_AUDIT } = require("../src/modules/staffAccess/domain");
const { createAdminOrganizationMembersController } = require("../controller/adminOrganizationMembersController");
const { createAuditLog } = require("../src/modules/auditLog/application/readAuditLog");
const { AUDIT_CATALOG, AUDIT_CATEGORIES, AuditLogError, VISIBLE_ACTIONS, catalogEntry, isStaffOnlyAction } = require("../src/modules/auditLog/domain");

// Owner decision 2026-11-24 (docs/DECISIONS.md): RFPilot staff VIEW a customer organization's
// members and change none of them. What is left of staff member management is the read of one
// member, recorded in the STAFF organization only. The write tests that were here went with the
// routes; tests/staff-organization-routes-guard.test.js proves no staff member write exists.
// In-memory ports; the real-database proof is tests-integration/staff-member-management.test.ts.

const hex = (c) => c.repeat(24);
const ACME = hex("a");
const OTHER = hex("b");
const STAFF_ORG = hex("d");
const SECOND_STAFF_ORG = hex("e");
const HOLDING = hex("c");
const STAFF = hex("7");
const ids = { owner: hex("1"), admin: hex("2"), manager: hex("3"), planner: hex("4"), viewer: hex("5"), suspended: hex("6"), invited: hex("8"), removed: hex("9") };
const FOREIGN = hex("f"); // a member of OTHER
const REASON = "Customer asked us on the phone, ticket 4471"; // only as text that must never show in a customer audit log
const ACTIONS = Object.values(STAFF_MEMBER_AUDIT);

const staff = (overrides = {}) => ({ adminId: STAFF, organizationId: STAFF_ORG, role: "admin", accountType: "admin", correlationId: "corr-staff", ...overrides });
const customerOwner = () => staff({ adminId: ids.owner, organizationId: ACME, role: "customer", accountType: "planner" });
const usersAccountWithStaffRole = () => staff({ adminId: ids.planner, accountType: "planner", role: "super_admin" });

// What a careless directory could hand back. None of it may reach a response.
const SECRETS = { password: "$2a$10$hashhashhash", twoFactorSecret: "JBSWY3DPEHPK3PXP", recoveryCodes: ["aaaa-bbbb"], tokenHash: "deadbeefcafe", refreshToken: "rt_live_abc", googleId: "google-oauth-subject", sessionRevocationClaim: { sessionId: "sess-live-1" }, __v: 3 };
const SECRET_VALUES = ["$2a$10$", "JBSWY3DPEHPK3PXP", "aaaa-bbbb", "deadbeefcafe", "rt_live_abc", "google-oauth-subject", "sess-live-1"];
const noSecrets = (value, label) => {
  const json = JSON.stringify(value);
  for (const secret of SECRET_VALUES) assert.equal(json.includes(secret), false, `${label}: ${secret}`);
  for (const key of Object.keys(SECRETS)) assert.equal(json.includes(`"${key}"`), false, `${label}: key ${key}`);
};

const setup = () => {
  const audit = []; // every event written anywhere, with the organization it was written in
  const state = { failAudit: false };
  const calls = [];
  const row = (organizationId, userId, roles, status = "active") => ({ organizationId, membershipId: `m-${userId}`, userId, name: `Name ${userId[0]}`, email: `${userId[0]}@example.test`, roles, status, version: 1, lastSignedInAt: null, createdAt: new Date("2026-10-01T00:00:00Z") });
  const rows = [
    row(ACME, ids.owner, ["owner"]), row(ACME, ids.admin, ["organization_admin"]), row(ACME, ids.manager, ["team_manager", "knowledge_editor"]),
    row(ACME, ids.planner, ["planner"]), row(ACME, ids.viewer, ["viewer"]), row(ACME, ids.suspended, ["planner"], "suspended"),
    row(ACME, ids.invited, ["planner"], "invited"), row(ACME, ids.removed, ["planner"], "removed"),
    row(OTHER, FOREIGN, ["planner"]), row(OTHER, hex("0"), ["owner"]),
    row(STAFF_ORG, ids.planner, ["planner"]), row(SECOND_STAFF_ORG, ids.planner, ["planner"]), row(HOLDING, ids.planner, ["planner"]),
  ];
  const get = (organizationId, userId) => rows.find((r) => r.organizationId === organizationId && r.userId === userId) ?? null;
  const standing = {
    [ACME]: { kind: "customer", staffAccountCount: 0 }, [OTHER]: { kind: "customer", staffAccountCount: 0 },
    [STAFF_ORG]: { kind: "customer", staffAccountCount: 3 }, [SECOND_STAFF_ORG]: { kind: "customer", staffAccountCount: 1 },
    [HOLDING]: { kind: "legacy_holding", staffAccountCount: 0 },
  };
  const directory = {
    async organization(id) { calls.push(["organization", id]); return standing[id] ? { id, ...standing[id], ...SECRETS } : null; },
    async member(organizationId, userId) {
      calls.push(["member", organizationId, userId]);
      const r = get(organizationId, userId);
      if (!r) return null;
      return {
        member: { userId: r.userId, name: r.name, email: r.email, roles: [...r.roles], status: r.status, teams: [{ id: hex("8"), name: "West", archived: false, isManager: false, ...SECRETS }], joinedAt: r.createdAt, lastSignedInAt: null, version: r.version, ...SECRETS },
        version: r.version,
      };
    },
  };
  // The service is given a read-only directory and the staff-side audit writer: nothing that can write.
  const members = createStaffMemberManagement({
    directory,
    audit: { async append(event) { if (state.failAudit) throw new Error("audit store down"); audit.push(event); } },
  });
  return { members, audit, state, calls, rows, get, directory };
};

const refusedWith = (status, code) => (error) => {
  assert.ok(error instanceof StaffMemberError, `${code}: ${error && error.message}`);
  assert.equal(error.status, status, code);
  assert.equal(error.code, code);
  return true;
};

// Exactly one event, in the staff organization, naming the customer organization and member.
const oneStaffEvent = (audit, expected) => {
  assert.equal(audit.length, 1, JSON.stringify(audit.map((e) => [e.action, e.decision, e.reason])));
  const [event] = audit;
  assert.equal(event.organizationId, STAFF_ORG);
  assert.equal(event.actorUserId, STAFF);
  assert.equal(event.targetType, "organization_membership");
  assert.equal(event.correlationId, "corr-staff");
  assert.equal(event.metadata.agentAccountType, "admin");
  assert.match(event.action, /^platform\.organization_member\./);
  for (const [key, value] of Object.entries(expected)) {
    if (key === "metadata") for (const [k, v] of Object.entries(value)) assert.deepEqual(event.metadata[k], v, `metadata.${k}`);
    else assert.deepEqual(event[key], value, key);
  }
  return event;
};

// The one request of this service. `member` is who the request names.
const ALL = [["member", STAFF_MEMBER_AUDIT.read, (m, s, org = ACME, user = ids.planner) => m.member(s, org, user)]];

// ── Who ──────────────────────────────────────────────────────────────────────────────────────

test("only an `admins` account with an admin role passes: a customer session and a `users` account holding a staff role are refused, and nothing is read, written or recorded", async () => {
  for (const [name, , run] of ALL) {
    for (const caller of [customerOwner(), usersAccountWithStaffRole(), staff({ role: "planner" }), staff({ accountType: undefined })]) {
      const { members, audit, calls } = setup();
      await assert.rejects(run(members, caller), (error) => error instanceof StaffAccessError && !(error instanceof StaffMemberError) && error.status === 403 && error.code === "STAFF_ACCESS_FORBIDDEN", name);
      assert.deepEqual(calls, [], name);
      assert.deepEqual(audit, [], name);
    }
    const { members, audit, calls } = setup();
    await assert.rejects(run(members, staff({ organizationId: "" })), (error) => error.status === 401, name);
    assert.deepEqual([calls, audit], [[], []]);
  }
  for (const role of ["admin", "super_admin", "superadmin", "Super Admin"]) {
    const { members } = setup();
    assert.equal((await members.member(staff({ role }), ACME, ids.planner)).organizationId, ACME, role);
  }
  // The existing staff-account helper, not a variant of its own.
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/staffAccess/application/manageOrganizationMembers.ts"), "utf8");
  assert.match(source, /if \(!isPlanStaff\(staff\)\) throw new StaffAccessError\("STAFF_ACCESS_FORBIDDEN"/);
  assert.doesNotMatch(source, /STAFF_ROLES|accountType ===/);
});

// ── Ids, reason ──────────────────────────────────────────────────────────────────────────────

test("ids must be 24 lower-case hex characters: a malformed organization or member id is a 400, looks nothing up, and is recorded once as denied", async () => {
  const bad = ["", "not-an-id", "A".repeat(24), hex("a").slice(1), `${hex("a")}0`, "aaaaaaaaaaaaaaaaaaaaaaa$", { $ne: null }, null];
  for (const [name, action, run] of ALL) {
    for (const value of bad) {
      const forOrganization = setup();
      await assert.rejects(run(forOrganization.members, staff(), value), refusedWith(400, "INVALID_ORGANIZATION_ID"), `${name} org ${JSON.stringify(value)}`);
      assert.deepEqual(forOrganization.calls, []);
      const event = oneStaffEvent(forOrganization.audit, { action, decision: "denied", reason: "invalid_organization_id" });
      assert.equal("targetId" in event && !/^[a-f0-9]{24}$/.test(event.targetId), false);

      const forMember = setup();
      await assert.rejects(run(forMember.members, staff(), ACME, value), refusedWith(400, "INVALID_MEMBER_ID"), `${name} member ${JSON.stringify(value)}`);
      assert.deepEqual(forMember.calls, []);
      const denied = oneStaffEvent(forMember.audit, { action, decision: "denied" });
      assert.equal("targetId" in denied, false, "a malformed id is never stored as the target");
      assert.equal(denied.metadata.organizationId, ACME);
    }
  }
});

// ── Organizations ────────────────────────────────────────────────────────────────────────────

test("an unknown organization is 404; RFPilot's own organization, any organization holding `admins` accounts, and a legacy holding tenant are 409 ORGANIZATION_NOT_MANAGEABLE; none is changed", async () => {
  for (const [name, action, run] of ALL) {
    const unknown = setup();
    await assert.rejects(run(unknown.members, staff(), hex("0")), refusedWith(404, "ORGANIZATION_NOT_FOUND"), name);
    assert.deepEqual(unknown.calls, [["organization", hex("0")]]);
    oneStaffEvent(unknown.audit, { action, decision: "denied", reason: "organization_not_found", metadata: { organizationId: hex("0") } });

    for (const [organization, standing] of [[STAFF_ORG, "platform"], [SECOND_STAFF_ORG, "platform"], [HOLDING, "legacy_holding"]]) {
      const { members, audit, calls, rows } = setup();
      const before = JSON.stringify(rows);
      await assert.rejects(run(members, staff(), organization, ids.planner), refusedWith(409, "ORGANIZATION_NOT_MANAGEABLE"), `${name} ${organization}`);
      assert.deepEqual(calls, [["organization", organization]], "refused before any member is read");
      assert.equal(JSON.stringify(rows), before);
      oneStaffEvent(audit, { action, decision: "denied", reason: "organization_not_manageable", metadata: { organizationId: organization, standing } });
    }
    // The caller's own organization is refused even if no `admins` count came back for it.
    const own = setup();
    await assert.rejects(run(own.members, staff({ organizationId: ACME }), ACME), refusedWith(409, "ORGANIZATION_NOT_MANAGEABLE"), name);
    assert.equal(own.audit[0].organizationId, ACME, "the staff member's own organization receives the event");
  }
});

test("tenant scope: every store and directory call names the path's organization and the member; the session's organization is never used", async () => {
  for (const [name, , run] of ALL) {
    const { members, calls } = setup();
    await run(members, staff());
    for (const call of calls) {
      const organizationId = typeof call[1] === "string" ? call[1] : call[1].organizationId;
      assert.equal(organizationId, ACME, `${name} ${call[0]}`);
      assert.equal(JSON.stringify(call).includes(STAFF_ORG), call[0] !== "organization" && typeof call[1] !== "string", `${name} ${call[0]}: only the audit event names the staff organization`);
    }
  }
});

test("a member of another organization is 404 on every route, the same answer as a member that doesn't exist, and nothing is written in either organization", async () => {
  for (const [name, action, run] of ALL) {
    for (const user of [FOREIGN, hex("0")]) {
      const { members, audit, rows } = setup();
      const before = JSON.stringify(rows);
      await assert.rejects(run(members, staff(), ACME, user), refusedWith(404, "MEMBER_NOT_FOUND"), `${name} ${user}`);
      assert.equal(JSON.stringify(rows), before);
      oneStaffEvent(audit, { action, decision: "denied", reason: "member_not_found", targetId: user, metadata: { organizationId: ACME, memberUserId: user } });
    }
  }
});

// ── Deactivate, reactivate ───────────────────────────────────────────────────────────────────

// ── Ownership ────────────────────────────────────────────────────────────────────────────────

const owners = (rows, organizationId) => rows.filter((r) => r.organizationId === organizationId && r.roles.includes("owner")).map((r) => r.userId);

// ── Reassignment ─────────────────────────────────────────────────────────────────────────────

// ── Audit ────────────────────────────────────────────────────────────────────────────────────

test("audit: every request leaves exactly one event in the STAFF organization and none in the customer organization, allowed or refused", async () => {
  for (const [name, action, run] of ALL) {
    const allowed = setup();
    await run(allowed.members, staff());
    oneStaffEvent(allowed.audit, { action, decision: "allowed", metadata: { organizationId: ACME } });
    const refused = setup();
    await assert.rejects(run(refused.members, staff(), ACME, hex("0")));
    oneStaffEvent(refused.audit, { action, decision: "denied" });
    for (const event of [...allowed.audit, ...refused.audit]) {
      assert.notEqual(event.organizationId, ACME, name);
      assert.doesNotMatch(event.action, /^(organization\.|proposal\.|auth\.)/, name);
      assert.equal(ACTIONS.includes(event.action), true);
    }
  }
});

test("audit: a refusal is returned even when its event cannot be written; a read that returned data fails instead", async () => {
  // A refusal is returned even when its event cannot be written (nothing was changed).
  const refused = setup();
  refused.state.failAudit = true;
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    await assert.rejects(refused.members.member(staff(), ACME, hex("0")), refusedWith(404, "MEMBER_NOT_FOUND"));
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /could not be recorded/);
});

test("audit: no code path of the staff member service writes into the customer organization, and the service is given nothing that can write", () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const service = read("src/modules/staffAccess/application/manageOrganizationMembers.ts");
  const code = service.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // One place builds every event, and its organization is the staff member's.
  assert.equal((code.match(/\borganizationId: attempt\.staff\.organizationId,/g) ?? []).length, 1);
  assert.equal((code.match(/audit\.append\(/g) ?? []).length, 2);
  for (const append of code.match(/audit\.append\(\{[^\n]*/g)) assert.match(append, /audit\.append\(\{ \.\.\.(eventOf\(|event,)/);
  assert.doesNotMatch(code, /organization\.member\.|organization\.ownership\.|proposal\.owner\.reassigned|auth\.sessions/);
  // The customer service and its composition are not used: its audit writer and session hook write customer-side events.
  assert.doesNotMatch(service, /createMemberManagement|organizationMembers\/composition|membershipSessions\b/);
  // The service takes a directory and the audit writer and nothing else: no membership store, no
  // reassignment store, no session hook.
  assert.match(service, /type Dependencies = \{\s+directory: StaffMemberDirectory;\s+audit: StaffContentAudit;\s+\};/);
  assert.doesNotMatch(service, /organizationMembers|MembershipStore|RfpReassignmentStore|MemberSessionHooks|memberPolicy/);
  const composition = read("src/modules/staffAccess/composition.ts");
  assert.match(composition, /export const staffMemberManagement = createStaffMemberManagement\(\{\s+directory: mongoStaffMemberDirectory,\s+audit: mongoSecurityAuditWriter,\s+\}\);/);
  assert.doesNotMatch(composition, /membershipSessions|mongoMembershipStore|mongoRfpReassignmentStore|organizationMembers|modules\/teams|auth\/composition/);
  // Nothing sets the staff session markers any more: the staff session hook is gone.
  assert.doesNotMatch(read("src/modules/auth/composition.ts"), /staffMembershipSessions/);
  // The directory performs no write.
  const directory = read("src/modules/staffAccess/infrastructure/mongoStaffMemberDirectory.ts");
  assert.doesNotMatch(directory, /\.(create|insertMany|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|deleteOne|deleteMany|findOneAndDelete|replaceOne|bulkWrite|save)\(/);
  assert.doesNotMatch(directory, /securityAuditEventModel|SecurityAuditEvent/);
  assert.match(directory, /OrganizationMembership\.findOne\(\{ organizationId: organization, userId: user \}\)/);
  assert.match(directory, /TeamMembership\.find\(\{ organizationId: organization, userId: user \}\)/);
  assert.match(directory, /Team\.find\(\{ organizationId: organization, _id:/);
});

// ── The customer's audit log ─────────────────────────────────────────────────────────────────

let seq = 0;
const stored = (overrides) => {
  seq += 1;
  return { id: seq.toString(16).padStart(24, "0"), organizationId: ACME, actorUserId: STAFF, targetType: "organization_membership", targetId: ids.planner, decision: "allowed", reason: "role_changed", metadata: { staffReason: REASON, previousRole: "planner", role: "viewer", before: { role: "planner" } }, createdAt: new Date(Date.UTC(2026, 10, 18, 0, 0, seq)), ...overrides };
};
const fakeEvents = (rows, leaky = false) => {
  const calls = [];
  const nameLookups = [];
  return {
    calls, nameLookups,
    isValidId: (value) => /^[0-9a-f]{24}$/i.test(value),
    async list(organizationId, filter, limit) {
      calls.push({ organizationId, filter });
      return rows.filter((row) => row.organizationId === organizationId && (leaky || filter.actions.includes(row.action)))
        .filter((row) => leaky || !filter.actorUserId || row.actorUserId === filter.actorUserId)
        .slice(0, limit).map(({ organizationId: _o, ...row }) => row);
    },
    async memberNames(_organizationId, userIds) { nameLookups.push(...userIds); return new Map(userIds.map((id) => [id, id === STAFF ? { name: "Staff Name", email: "staff@example.test" } : { name: "Olive Owner", email: "olive@example.test" }])); },
  };
};
const owner = { organizationId: ACME, userId: ids.owner, roles: ["owner"] };

test("the customer audit log cannot return a staff member action: not in the catalog, not by default, not as a stored row, not in the CSV", async () => {
  for (const action of ACTIONS) {
    assert.match(action, /^platform\.organization_member\.[a-z_]+$/);
    assert.equal(Object.prototype.hasOwnProperty.call(AUDIT_CATALOG, action), false, action);
    assert.equal(catalogEntry(action), undefined, action);
    assert.equal(isStaffOnlyAction(action), true, action);
    assert.equal(VISIBLE_ACTIONS.includes(action), false, action);
  }
  assert.equal(JSON.stringify(AUDIT_CATALOG).includes("platform."), false);
  // Rows that should never exist: the staff actions stored in the CUSTOMER organization. Even
  // then, and even with a reader that ignores the action filter, none is returned.
  const visible = stored({ action: "organization.member.role_changed", actorUserId: ids.owner, metadata: { previousRole: "planner", role: "viewer" } });
  const rows = [...ACTIONS.flatMap((action) => [stored({ action }), stored({ action, decision: "denied", reason: "last_owner" })]), visible];
  for (const leaky of [false, true]) {
    const events = fakeEvents(rows, leaky);
    const log = createAuditLog({ events });
    for (const role of ["owner", "organization_admin"]) {
      const page = await log.list({ ...owner, roles: [role] }, {});
      assert.deepEqual(page.events.map((e) => e.id), [visible.id]);
      const exported = await log.exportCsv({ ...owner, roles: [role] }, {});
      assert.equal(exported.rows, 1);
      for (const hidden of ["platform.", "organization_member.", REASON, "Staff Name", STAFF, "staffReason"]) {
        assert.equal(JSON.stringify(page).includes(hidden), false, hidden);
        assert.equal(exported.csv.includes(hidden), false, hidden);
      }
    }
    assert.equal(events.nameLookups.includes(STAFF), false, "the staff account is never looked up as a member");
  }
});

test("a staff member action cannot be asked for by action, by category or by the staff account as actor, in the list or the CSV; the filter options do not offer one", async () => {
  const events = fakeEvents(ACTIONS.map((action) => stored({ action })));
  const log = createAuditLog({ events });
  const invalid = (error) => error instanceof AuditLogError && error.status === 400 && error.code === "AUDIT_FILTER_INVALID";
  for (const action of ACTIONS) {
    await assert.rejects(() => log.list(owner, { action }), invalid, action);
    await assert.rejects(() => log.exportCsv(owner, { action }), invalid, action);
  }
  for (const category of AUDIT_CATEGORIES.map((c) => c.key)) {
    for (const query of [{ category }, { category, actor: STAFF }, { actor: STAFF }, { actor: "support" }]) {
      assert.deepEqual((await log.list(owner, query)).events, [], JSON.stringify(query));
      assert.equal((await log.exportCsv(owner, query)).rows, 0, JSON.stringify(query));
    }
  }
  for (const category of ["platform", "staff", "organization_member"]) await assert.rejects(() => log.list(owner, { category }), invalid, category);
  for (const call of events.calls) for (const action of call.filter.actions) assert.equal(isStaffOnlyAction(action), false, action);
  const offered = log.filters(owner).categories.flatMap((category) => category.actions.map((action) => action.value));
  assert.deepEqual(offered.filter((action) => ACTIONS.includes(action) || action.startsWith("platform.")), []);
  assert.equal(JSON.stringify(log.filters(owner)).includes("platform"), false);
});

// ── Answers ──────────────────────────────────────────────────────────────────────────────────

const MEMBER_KEYS = ["userId", "name", "email", "roles", "status", "teams", "joinedAt", "lastSignedInAt"];

test("answers are built from the staff members read's allowlist: no token, hash, session data or stored document, whatever the directory hands back", async () => {
  const { staffMemberView } = require("../src/modules/staffAccess/application/readOrganizationContent");
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/staffAccess/application/manageOrganizationMembers.ts"), "utf8");
  assert.equal((source.match(/member: staffMemberView\(found\.member\)/g) ?? []).length, 1, "the read's answer");
  assert.deepEqual(Object.keys(staffMemberView({ userId: "u", name: null, email: null, roles: [], status: "active", teams: [], joinedAt: null, lastSignedInAt: null, ...SECRETS })), MEMBER_KEYS);
  const memberShaped = (member, label) => {
    assert.deepEqual(Object.keys(member), MEMBER_KEYS, label);
    for (const team of member.teams) assert.deepEqual(Object.keys(team), ["id", "name", "archived", "isManager"], label);
  };
  for (const [name, , run] of ALL) {
    const { members } = setup();
    const answer = await run(members, staff());
    noSecrets(answer, name);
    assert.equal(answer.organizationId, ACME);
    assert.deepEqual(Object.keys(answer), ["organizationId", "member", "version"]);
    memberShaped(answer.member, name);
    assert.equal(typeof answer.version, "number");
  }
});

test("member read: one member of the path's organization with the membership's version, recorded once; it fails if the event cannot be written", async () => {
  const { members, audit, calls } = setup();
  const answer = await members.member(staff(), ACME, ids.manager);
  assert.deepEqual([answer.member.userId, answer.member.roles, answer.version], [ids.manager, ["team_manager", "knowledge_editor"], 1]);
  assert.deepEqual(calls, [["organization", ACME], ["member", ACME, ids.manager]]);
  oneStaffEvent(audit, { action: "platform.organization_member.read", decision: "allowed", reason: "member", targetId: ids.manager, metadata: { organizationId: ACME, resource: "member" } });
  const failing = setup();
  failing.state.failAudit = true;
  await assert.rejects(failing.members.member(staff(), ACME, ids.manager), /audit store down/);
});

test("user-facing text says proposal, never RFP", () => {
  for (const file of ["src/modules/staffAccess/application/manageOrganizationMembers.ts", "controller/adminOrganizationMembersController.ts"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    for (const literal of source.match(/"[^"\n]*"|`[^`\n]*`/g) ?? []) {
      if (/^["`][A-Z_]+["`]$/.test(literal) || /rfpIds/.test(literal)) continue;
      assert.doesNotMatch(literal, /\bRFPs?\b/, `${file}: ${literal}`);
    }
  }
});

// ── Controller ───────────────────────────────────────────────────────────────────────────────

const fakeResponse = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const request = (overrides = {}) => ({
  user: { userId: STAFF, organizationId: STAFF_ORG, role: "admin", accountType: "admin", roles: ["dxg_admin"] },
  params: { organizationId: ACME, userId: ids.planner }, query: {}, body: {}, correlationId: "corr-staff", ...overrides,
});

test("controller: the organization and member come from the path only; refusals carry code, message and details; an unexpected error is a plain 500; there is no write handler", async () => {
  const { members, audit, calls } = setup();
  const controller = createAdminOrganizationMembersController(members);
  assert.deepEqual(Object.keys(controller), ["member"], "the read is the only handler");
  assert.deepEqual(Object.keys(members), ["member"], "and the only method of the service");
  // A body or query that names another organization or member is ignored.
  const res = fakeResponse();
  await controller.member(request({ body: { organizationId: OTHER, userId: FOREIGN }, query: { organizationId: OTHER, userId: FOREIGN } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual([res.body.success, res.body.data.organizationId, res.body.data.member.userId, res.body.data.version], [true, ACME, ids.planner, 1]);
  assert.equal(calls.some((call) => JSON.stringify(call).includes(OTHER)), false);
  assert.equal(audit.length, 1);

  const cases = [
    [request({ params: { organizationId: HOLDING, userId: ids.planner } }), 409, "ORGANIZATION_NOT_MANAGEABLE"],
    [request({ params: { organizationId: ACME, userId: FOREIGN } }), 404, "MEMBER_NOT_FOUND"],
    [request({ params: { organizationId: "nope", userId: ids.planner } }), 400, "INVALID_ORGANIZATION_ID"],
    [request({ user: { userId: ids.owner, organizationId: ACME, role: "customer", accountType: "planner", roles: ["owner"] } }), 403, "STAFF_ACCESS_FORBIDDEN"],
    [request({ user: undefined }), 401, "AUTHENTICATION_REQUIRED"],
  ];
  for (const [req, status, code] of cases) {
    const response = fakeResponse();
    await createAdminOrganizationMembersController(setup().members).member(req, response);
    assert.deepEqual([response.statusCode, response.body.success, response.body.code], [status, false, code], code);
    assert.equal(typeof response.body.message, "string");
    assert.equal("data" in response.body, false);
  }
  // Details sit beside code and message.
  const standing = fakeResponse();
  await controller.member(request({ params: { organizationId: HOLDING, userId: ids.planner } }), standing);
  assert.equal(standing.body.standing, "legacy_holding");

  const broken = createAdminOrganizationMembersController({ member: async () => { throw new Error("mongo exploded: secret detail"); } });
  const failed = fakeResponse();
  const original = console.error;
  console.error = () => {};
  try { await broken.member(request(), failed); } finally { console.error = original; }
  assert.deepEqual([failed.statusCode, failed.body.code], [500, "STAFF_MEMBERS_INTERNAL_ERROR"]);
  assert.equal(JSON.stringify(failed.body).includes("secret detail"), false);
});

// ── Routes ───────────────────────────────────────────────────────────────────────────────────

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
  const res = fakeResponse();
  guard({}, res, () => { throw new Error("no session must not pass"); });
  assert.equal(res.statusCode, 401);
};

test("routes: the one route is a GET behind authenticate, the staff role guard and the staff read limit; this file registers no write", () => {
  const router = require("../routes/adminOrganizationMembersRoute").default;
  const { staffMemberWrites } = require("../routes/adminOrganizationMembersRoute");
  const { staffContentReads } = require("../routes/adminOrganizationContentRoute");
  const { authenticate } = require("../middleware/auth");
  const { adminOrganizationMembersController: controller } = require("../controller/adminOrganizationMembersController");
  const routes = router.stack.filter((layer) => layer.route).map((layer) => layer.route);
  const describe = (route) => `${Object.keys(route.methods).join(",").toUpperCase()} ${route.path}`;
  assert.deepEqual(routes.map(describe), ["GET /admin/organizations/:organizationId/members/:userId"]);
  assert.equal(router.stack.every((layer) => layer.route), true, "no router-level middleware that could skip the guard");
  const [route] = routes;
  assert.equal(route.stack.length, 4, route.path);
  assert.equal(route.stack[0].handle, authenticate, route.path);
  guardRefusesCustomers(route.stack[1].handle, route.path);
  assert.equal(route.stack[2].handle, staffContentReads, route.path);
  assert.equal(route.stack[3].handle, controller.member, route.path);
  assert.notEqual(staffMemberWrites, staffContentReads);

  const source = fs.readFileSync(path.join(__dirname, "../routes/adminOrganizationMembersRoute.ts"), "utf8");
  // The staff write limit (now used by the organization block only): per staff account, stricter
  // than the 300 reads and the 120 plan writes.
  assert.match(source, /name: "organization-member-write",\s+limit: 60,\s+windowMs: 15 \* 60_000,\s+identity: \(req: Request\) => \(req as AuthRequest\)\.user\?\.userId/);
  assert.match(source, /const staff = \[authenticate, authorize\("admin", "super_admin", "superadmin"\)\];/);
  const lines = source.split("\n").filter((line) => /^router\./.test(line));
  assert.deepEqual(lines, ['router.get("/admin/organizations/:organizationId/members/:userId", ...staff, staffContentReads, controller.member);']);
  assert.doesNotMatch(source, /router\.(post|put|patch|delete|all|use)\(/);
  for (const file of ["routes/adminOrganizationMembersRoute.ts", "controller/adminOrganizationMembersController.ts", "src/modules/staffAccess/application/manageOrganizationMembers.ts", "src/modules/staffAccess/infrastructure/mongoStaffMemberDirectory.ts"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), /proposalTemplate|ProposalTemplate|organizationVendor|OrganizationVendor|proposalsModel|invitationModel|Invitation\b/, file);
  }
  assert.match(fs.readFileSync(path.join(__dirname, "../server.ts"), "utf8"), /app\.use\("\/api\/v1", adminOrganizationMembersRoutes\);/);
});

test("routes: the write limit refuses the 61st write in a window with 429, per staff account, before the handler runs", async () => {
  const { staffMemberWrites } = require("../routes/adminOrganizationMembersRoute");
  const hit = (userId) => new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, set(name, value) { this.headers[name] = value; return this; }, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ passed: false, status: this.statusCode, body }); return this; } };
    staffMemberWrites({ user: { userId }, ip: "203.0.113.9", headers: {} }, res, () => resolve({ passed: true }));
  });
  const first = hex("1").replace(/1$/, "a");
  for (let i = 0; i < 60; i++) assert.equal((await hit(first)).passed, true, `write ${i + 1}`);
  const refused = await hit(first);
  assert.deepEqual([refused.passed, refused.status], [false, 429]);
  assert.equal((await hit(hex("2").replace(/2$/, "b"))).passed, true, "another staff account has its own count");
});
