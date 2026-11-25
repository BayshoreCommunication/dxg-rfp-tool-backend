require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createStaffTeamManagement } = require("../src/modules/staffAccess/application/manageOrganizationTeams");
const { StaffAccessError, StaffMemberError, STAFF_MEMBER_AUDIT, STAFF_TEAM_AUDIT, unmanageableStanding } = require("../src/modules/staffAccess/domain");
const { createAdminOrganizationTeamsController } = require("../controller/adminOrganizationTeamsController");
const { createTeamAdministration } = require("../src/modules/teams/application/manageTeams");
const { TeamError } = require("../src/modules/teams/domain");
const { createMemberManagement } = require("../src/modules/organizationMembers/application/manageMembers");
const { createAuditLog } = require("../src/modules/auditLog/application/readAuditLog");
const { AUDIT_CATALOG, AUDIT_CATEGORIES, AuditLogError, VISIBLE_ACTIONS, catalogEntry, isStaffOnlyAction } = require("../src/modules/auditLog/domain");

// Owner decision 2026-11-24 (docs/DECISIONS.md): RFPilot staff VIEW a customer organization's
// teams and change none of them. What is left of staff team management is the read of one team,
// recorded in the STAFF organization only. The write tests that were here went with the routes;
// tests/staff-organization-routes-guard.test.js proves no staff team write exists. The sibling of
// tests/staff-member-management.test.js. The customer's REAL team and member services still run
// here over in-memory ports, to show the organization's own Admin is served exactly as before;
// the real-database proof is tests-integration/staff-team-management.test.ts.

const hex = (c) => c.repeat(24);
const ACME = hex("a");
const OTHER = hex("b");
const STAFF_ORG = hex("d");
const SECOND_STAFF_ORG = hex("e");
const HOLDING = hex("c");
const STAFF = hex("7");
const ids = { owner: hex("1"), admin: hex("2"), manager: hex("3"), planner: hex("4"), viewer: hex("5"), suspended: hex("6"), removed: hex("9") };
const FOREIGN = hex("f"); // a team_manager of OTHER
const T = { west: "aaaa00000000000000000001", east: "aaaa00000000000000000002", old: "aaaa00000000000000000003", north: "bbbb00000000000000000001" };
const REASON = "Customer asked us on the phone, ticket 4471"; // only as text that must never show in a customer audit log
const ACTIONS = Object.values(STAFF_TEAM_AUDIT);
const CUSTOMER_TEAM_ACTIONS = ["team.created", "team.renamed", "team.archived", "team.member_added", "team.member_removed", "team.manager_changed", "organization.member.teams_changed"];

const staff = (overrides = {}) => ({ adminId: STAFF, organizationId: STAFF_ORG, role: "admin", accountType: "admin", correlationId: "corr-staff", ...overrides });
const customerOwner = () => staff({ adminId: ids.owner, organizationId: ACME, role: "customer", accountType: "planner" });
const usersAccountWithStaffRole = () => staff({ adminId: ids.planner, accountType: "planner", role: "super_admin" });

// What a careless directory could hand back. None of it may reach a response.
const SECRETS = { password: "$2a$10$hashhashhash", twoFactorSecret: "JBSWY3DPEHPK3PXP", recoveryCodes: ["aaaa-bbbb"], tokenHash: "deadbeefcafe", refreshToken: "rt_live_abc", googleId: "google-oauth-subject", sessionRevocationClaim: { sessionId: "sess-live-1" }, createdBy: "created-by-someone", __v: 3 };
const SECRET_VALUES = ["$2a$10$", "JBSWY3DPEHPK3PXP", "aaaa-bbbb", "deadbeefcafe", "rt_live_abc", "google-oauth-subject", "sess-live-1", "created-by-someone"];
const noSecrets = (value, label) => {
  const json = JSON.stringify(value);
  for (const secret of SECRET_VALUES) assert.equal(json.includes(secret), false, `${label}: ${secret}`);
  for (const key of Object.keys(SECRETS)) assert.equal(json.includes(`"${key}"`), false, `${label}: key ${key}`);
};

// One world: organizations, members, teams and team memberships, with the ports of both the
// customer services and the staff service over it. `audit` holds every event written anywhere.
const setup = () => {
  const audit = [];
  const state = { failAudit: false };
  const calls = [];
  const memberRows = [];
  const addMemberRow = (organizationId, userId, roles, status = "active") => memberRows.push({ organizationId, membershipId: `m-${userId}`, userId, name: `Name ${userId[0]}`, email: `${userId[0]}@example.test`, roles, status, version: 1, lastSignedInAt: null, createdAt: new Date("2026-10-01T00:00:00Z") });
  addMemberRow(ACME, ids.owner, ["owner"]); addMemberRow(ACME, ids.admin, ["organization_admin"]); addMemberRow(ACME, ids.manager, ["team_manager"]);
  addMemberRow(ACME, ids.planner, ["planner"]); addMemberRow(ACME, ids.viewer, ["viewer"]); addMemberRow(ACME, ids.suspended, ["planner"], "suspended"); addMemberRow(ACME, ids.removed, ["planner"], "removed");
  addMemberRow(OTHER, FOREIGN, ["team_manager"]); addMemberRow(OTHER, hex("0"), ["owner"]);
  addMemberRow(STAFF_ORG, ids.planner, ["planner"]); addMemberRow(SECOND_STAFF_ORG, ids.planner, ["planner"]); addMemberRow(HOLDING, ids.planner, ["planner"]);
  const teamRows = [
    { id: T.west, organizationId: ACME, name: "West", archived: false, archivedAt: null, createdAt: new Date("2026-10-02T00:00:00Z"), createdBy: ids.owner },
    { id: T.east, organizationId: ACME, name: "East", archived: false, archivedAt: null, createdAt: new Date("2026-10-03T00:00:00Z"), createdBy: ids.owner },
    { id: T.old, organizationId: ACME, name: "Old", archived: true, archivedAt: new Date("2026-10-05T00:00:00Z"), createdAt: new Date("2026-10-01T00:00:00Z"), createdBy: ids.owner },
    { id: T.north, organizationId: OTHER, name: "North", archived: false, archivedAt: null, createdAt: new Date("2026-10-02T00:00:00Z"), createdBy: hex("0") },
    { id: "dddd00000000000000000001", organizationId: STAFF_ORG, name: "Staff team", archived: false, archivedAt: null, createdAt: new Date("2026-10-01T00:00:00Z"), createdBy: null },
    { id: "cccc00000000000000000001", organizationId: HOLDING, name: "Holding team", archived: false, archivedAt: null, createdAt: new Date("2026-10-01T00:00:00Z"), createdBy: null },
  ];
  const teamMembers = [
    { organizationId: ACME, teamId: T.west, userId: ids.planner, isManager: false },
    { organizationId: ACME, teamId: T.west, userId: ids.manager, isManager: true },
    { organizationId: ACME, teamId: T.old, userId: ids.planner, isManager: false },
    { organizationId: OTHER, teamId: T.north, userId: FOREIGN, isManager: true },
  ];
  let next = 1;
  const member = (organizationId, userId) => memberRows.find((r) => r.organizationId === organizationId && r.userId === userId) ?? null;
  const team = (organizationId, teamId) => teamRows.find((t) => t.id === teamId && t.organizationId === organizationId) ?? null;
  const record = ({ organizationId: _o, createdBy: _c, ...rest }) => ({ ...rest });
  const nameTaken = (organizationId, name, exceptId) => teamRows.some((t) => t.organizationId === organizationId && !t.archived && t.id !== exceptId && t.name.toLowerCase() === name.toLowerCase());
  const teams = {
    async list(organizationId) { calls.push(["teams.list", organizationId]); return teamRows.filter((t) => t.organizationId === organizationId).map(record); },
    async findById(organizationId, teamId) { calls.push(["teams.findById", organizationId, teamId]); const t = team(organizationId, teamId); return t ? record(t) : null; },
    async create(input) {
      calls.push(["teams.create", input]);
      if (nameTaken(input.organizationId, input.name)) return "duplicate";
      const created = { id: `aaaa${String(next++).padStart(20, "9")}`, organizationId: input.organizationId, name: input.name, archived: false, archivedAt: null, createdAt: new Date("2026-11-18T00:00:00Z"), createdBy: input.createdBy };
      teamRows.push(created);
      return record(created);
    },
    async rename(input) {
      calls.push(["teams.rename", input]);
      const t = team(input.organizationId, input.teamId);
      if (!t || t.archived) return null;
      if (nameTaken(input.organizationId, input.name, input.teamId)) return "duplicate";
      t.name = input.name;
      return record(t);
    },
    async archive(input) {
      calls.push(["teams.archive", input]);
      const t = team(input.organizationId, input.teamId);
      if (!t || t.archived) return false;
      Object.assign(t, { archived: true, archivedAt: input.at });
      return true;
    },
    async members(organizationId, teamIds) { calls.push(["teams.members", organizationId, teamIds]); return teamMembers.filter((m) => m.organizationId === organizationId && teamIds.includes(m.teamId)).map(({ organizationId: _o, ...m }) => m); },
    async addMember(input) {
      calls.push(["teams.addMember", input]);
      if (teamMembers.some((m) => m.teamId === input.teamId && m.userId === input.userId)) return "exists";
      teamMembers.push({ organizationId: input.organizationId, teamId: input.teamId, userId: input.userId, isManager: input.isManager });
      return "added";
    },
    async removeMember(input) {
      calls.push(["teams.removeMember", input]);
      const index = teamMembers.findIndex((m) => m.organizationId === input.organizationId && m.teamId === input.teamId && m.userId === input.userId);
      if (index < 0) return false;
      teamMembers.splice(index, 1);
      return true;
    },
    async setManager(input) {
      calls.push(["teams.setManager", input]);
      const m = teamMembers.find((x) => x.organizationId === input.organizationId && x.teamId === input.teamId && x.userId === input.userId);
      if (!m) return false;
      m.isManager = input.isManager;
      return true;
    },
  };
  const orgMembers = { async find(organizationId, userId) { calls.push(["orgMembers.find", organizationId, userId]); const r = member(organizationId, userId); return r ? { roles: r.roles, status: r.status } : null; } };
  const memberRecord = (r) => { const { organizationId: _o, ...rest } = r; return { ...rest, roles: [...rest.roles] }; };
  const store = {
    async list(organizationId) { return memberRows.filter((r) => r.organizationId === organizationId).map(memberRecord); },
    async find(organizationId, userId) { calls.push(["members.find", organizationId, userId]); const r = member(organizationId, userId); return r ? memberRecord(r) : null; },
    async bumpVersion(input) { calls.push(["members.bumpVersion", input]); const r = member(input.organizationId, input.userId); if (!r || r.version !== input.expectedVersion || r.status === "removed") return "stale"; r.version += 1; return memberRecord(r); },
  };
  const activeIn = (organizationId, teamIds) => teamIds.filter((id) => { const t = team(organizationId, id); return t && !t.archived; });
  const applyTeams = (organizationId, userId, teamIds) => {
    const current = activeIn(organizationId, teamMembers.filter((m) => m.organizationId === organizationId && m.userId === userId).map((m) => m.teamId));
    for (const id of current.filter((x) => !teamIds.includes(x))) teamMembers.splice(teamMembers.findIndex((m) => m.teamId === id && m.userId === userId), 1);
    for (const id of teamIds.filter((x) => !current.includes(x))) teamMembers.push({ organizationId, teamId: id, userId, isManager: false });
    return current;
  };
  const teamDirectory = {
    async teamsFor(organizationId, userIds) { return new Map(userIds.map((userId) => [userId, activeIn(organizationId, teamMembers.filter((m) => m.organizationId === organizationId && m.userId === userId).map((m) => m.teamId)).map((id) => ({ id, name: team(organizationId, id).name }))])); },
    async activeTeamIds(organizationId, teamIds) { calls.push(["memberTeams.activeTeamIds", organizationId, teamIds]); return activeIn(organizationId, teamIds); },
    async setMemberTeams(input) { calls.push(["memberTeams.setMemberTeams", input]); return { previousTeamIds: applyTeams(input.organizationId, input.userId, input.teamIds) }; },
  };
  const standing = {
    [ACME]: { kind: "customer", staffAccountCount: 0 }, [OTHER]: { kind: "customer", staffAccountCount: 0 },
    [STAFF_ORG]: { kind: "customer", staffAccountCount: 3 }, [SECOND_STAFF_ORG]: { kind: "customer", staffAccountCount: 1 },
    [HOLDING]: { kind: "legacy_holding", staffAccountCount: 0 },
  };
  const memberView = (r) => ({
    userId: r.userId, name: r.name, email: r.email, roles: [...r.roles], status: r.status,
    teams: teamMembers.filter((m) => m.organizationId === r.organizationId && m.userId === r.userId).map((m) => ({ id: m.teamId, name: team(r.organizationId, m.teamId).name, archived: team(r.organizationId, m.teamId).archived, isManager: m.isManager, ...SECRETS })),
    joinedAt: r.createdAt, lastSignedInAt: null, version: r.version, ...SECRETS,
  });
  const directory = {
    async organization(id) { calls.push(["organization", id]); return standing[id] ? { id, ...standing[id], ...SECRETS } : null; },
    async member(organizationId, userId) { calls.push(["member", organizationId, userId]); const r = member(organizationId, userId); return r ? { member: memberView(r), version: r.version } : null; },
  };
  const staffTeamDirectory = {
    async team(organizationId, teamId) {
      calls.push(["team", organizationId, teamId]);
      const t = team(organizationId, teamId);
      if (!t) return null;
      const own = teamMembers.filter((m) => m.organizationId === organizationId && m.teamId === teamId);
      const person = (userId) => { const r = member(organizationId, userId); return { id: userId, name: r.name, email: r.email, ...SECRETS }; };
      return {
        team: { id: t.id, name: t.name, archived: t.archived, archivedAt: t.archivedAt, createdAt: t.createdAt, memberCount: own.length, managers: own.filter((m) => m.isManager).map((m) => person(m.userId)), ...SECRETS },
        members: own.map((m) => ({ member: memberView(member(organizationId, m.userId)), version: member(organizationId, m.userId).version, isManager: m.isManager, ...SECRETS })),
        ...SECRETS,
      };
    },
  };
  const isValidId = (value) => /^[0-9a-f]{24}$/i.test(value);
  const now = () => new Date("2026-11-18T12:00:00Z");
  // The staff service is given read-only directories and the staff-side audit writer: nothing that can write.
  const management = createStaffTeamManagement({
    directory, teamDirectory: staffTeamDirectory,
    audit: { async append(event) { if (state.failAudit) throw new Error("audit store down"); audit.push(event); } },
  });
  // The customer's own services over the same world, writing to the same `audit` list.
  const customerAudit = { append: async (event) => { audit.push(event); } };
  const customerTeams = createTeamAdministration({ teams, directory: orgMembers, audit: customerAudit, isValidId, now });
  const customerMembers = createMemberManagement({
    store, teams: teamDirectory, audit: customerAudit, sessions: { afterRoleChange: async () => {}, afterDeactivation: async () => {} },
    reassignments: { reassign: async () => { throw new Error("not used"); } }, ownershipMirror: { afterReassign: async () => {} },
  });
  const world = () => JSON.stringify({ teamRows, teamMembers, memberRows });
  const writes = () => calls.filter(([name]) => /^(teams\.(create|rename|archive|addMember|removeMember|setManager)|memberTeams\.setMemberTeams)/.test(name));
  return { management, customerTeams, customerMembers, audit, state, calls, teamRows, teamMembers, memberRows, member, team, world, writes };
};

const refusedWith = (status, code) => (error) => {
  assert.ok(error instanceof StaffMemberError, `${code}: ${error && error.message}`);
  assert.equal(error.status, status, code);
  assert.equal(error.code, code);
  return true;
};

// Exactly one event, in the staff organization, naming the customer organization.
const oneStaffEvent = (audit, expected) => {
  assert.equal(audit.length, 1, JSON.stringify(audit.map((e) => [e.action, e.decision, e.reason])));
  const [event] = audit;
  assert.equal(event.organizationId, STAFF_ORG);
  assert.equal(event.actorUserId, STAFF);
  assert.equal(event.correlationId, "corr-staff");
  assert.equal(event.metadata.agentAccountType, "admin");
  assert.match(event.action, /^platform\.organization_(team|member)\./);
  assert.equal(event.targetType, event.action === STAFF_TEAM_AUDIT.memberTeamsChanged ? "organization_membership" : "team");
  for (const [key, value] of Object.entries(expected)) {
    if (key === "metadata") for (const [k, v] of Object.entries(value)) assert.deepEqual(event.metadata[k], v, `metadata.${k}`);
    else assert.deepEqual(event[key], value, key);
  }
  return event;
};

// The one request of this service. `teamId` is what the path names.
const ALL = [["team", STAFF_TEAM_AUDIT.read, (m, s, org = ACME, teamId = T.west) => m.team(s, org, teamId)]];

// ── Who ──────────────────────────────────────────────────────────────────────────────────────

test("only an `admins` account with an admin role passes: a customer session and a `users` account holding a staff role are refused, and nothing is read, written or recorded", async () => {
  for (const [name, , run] of ALL) {
    for (const caller of [customerOwner(), usersAccountWithStaffRole(), staff({ role: "planner" }), staff({ accountType: undefined })]) {
      const { management, audit, calls, world } = setup();
      const before = world();
      await assert.rejects(run(management, caller), (error) => error instanceof StaffAccessError && !(error instanceof StaffMemberError) && error.status === 403 && error.code === "STAFF_ACCESS_FORBIDDEN", name);
      assert.deepEqual([calls, audit, world()], [[], [], before], name);
    }
    const { management, audit, calls } = setup();
    await assert.rejects(run(management, staff({ organizationId: "" })), (error) => error.status === 401, name);
    assert.deepEqual([calls, audit], [[], []]);
  }
  for (const role of ["admin", "super_admin", "superadmin", "Super Admin"]) {
    const { management } = setup();
    assert.equal((await management.team(staff({ role }), ACME, T.west)).organizationId, ACME, role);
  }
  // The existing staff-account helper, not a variant of its own.
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/staffAccess/application/manageOrganizationTeams.ts"), "utf8");
  assert.match(source, /if \(!isPlanStaff\(staff\)\) throw new StaffAccessError\("STAFF_ACCESS_FORBIDDEN"/);
  assert.doesNotMatch(source, /STAFF_ROLES|accountType ===/);
});

// ── Ids, reason ──────────────────────────────────────────────────────────────────────────────

test("ids must be 24 lower-case hex characters: a malformed organization or team id is a 400, looks nothing up, and is recorded once as denied", async () => {
  const BAD = ["", "nope", ACME.toUpperCase(), `${ACME}0`, ACME.slice(1), "aaaaaaaaaaaaaaaaaaaaaaag", { $ne: null }, null, ["a"]];
  for (const bad of BAD) {
    for (const [name, action, run] of ALL) {
      const cases = [[(m) => run(m, staff(), bad), "INVALID_ORGANIZATION_ID", 400], [(m) => run(m, staff(), ACME, bad), "INVALID_TEAM_ID", 400]];
      for (const [call, code, status] of cases) {
        const { management, audit, calls, world } = setup();
        const before = world();
        await assert.rejects(call(management), refusedWith(status, code), `${name} ${code} ${JSON.stringify(bad)}`);
        assert.deepEqual(calls, [], `${name} ${code}: nothing looked up`);
        assert.equal(world(), before);
        const event = oneStaffEvent(audit, { action, decision: "denied", reason: code.toLowerCase() });
        // What was typed is kept as text, cut to 64 characters; it is never a target id and never an object.
        if ("targetId" in event) assert.match(event.targetId, /^[a-f0-9]{24}$/, name);
        for (const value of Object.values(event.metadata)) assert.equal(typeof value, "string", "nothing but text from the request is stored");
      }
    }
  }
  // A long id is cut before it is stored.
  const long = setup();
  await assert.rejects(long.management.team(staff(), ACME, "z".repeat(5000)), refusedWith(400, "INVALID_TEAM_ID"));
  assert.equal(long.audit[0].metadata.teamId.length, 64);
});

// ── Which organizations ──────────────────────────────────────────────────────────────────────

test("an unknown organization is 404; RFPilot's own organization, any organization holding `admins` accounts, and a legacy holding tenant are 409 ORGANIZATION_NOT_MANAGEABLE; none is changed", async () => {
  const cases = [[hex("0"), 404, "ORGANIZATION_NOT_FOUND", undefined], [STAFF_ORG, 409, "ORGANIZATION_NOT_MANAGEABLE", "platform"], [SECOND_STAFF_ORG, 409, "ORGANIZATION_NOT_MANAGEABLE", "platform"], [HOLDING, 409, "ORGANIZATION_NOT_MANAGEABLE", "legacy_holding"]];
  for (const [organizationId, status, code, standing] of cases) {
    for (const [name, action, run] of ALL) {
      const { management, audit, calls, world } = setup();
      const before = world();
      // The staff organization's and the holding tenant's own team and member, so only the organization refuses.
      const teamId = organizationId === STAFF_ORG ? "dddd00000000000000000001" : organizationId === HOLDING ? "cccc00000000000000000001" : undefined;
      await assert.rejects(run(management, staff(), organizationId, teamId), (error) => {
        refusedWith(status, code)(error);
        if (standing) assert.deepEqual(error.details, { standing });
        assert.doesNotMatch(error.message, /member/i, "the team routes speak of teams");
        return true;
      }, `${name} ${organizationId}`);
      assert.deepEqual(calls, [["organization", organizationId]], `${name}: only the organization was looked up`);
      assert.equal(world(), before);
      oneStaffEvent(audit, { action, decision: "denied", reason: code.toLowerCase(), metadata: { organizationId, ...(standing ? { standing } : {}) } });
    }
  }
  // A staff account whose own organization holds no `admins` row is still refused its own organization.
  const { management } = setup();
  await assert.rejects(management.team(staff({ organizationId: ACME }), ACME, T.west), refusedWith(409, "ORGANIZATION_NOT_MANAGEABLE"));
  // One rule for the member and the team reads.
  assert.equal(unmanageableStanding({ id: ACME, kind: "customer", staffAccountCount: 0 }, STAFF_ORG), null);
  assert.equal(unmanageableStanding({ id: ACME, kind: "customer", staffAccountCount: 1 }, STAFF_ORG), "platform");
  assert.equal(unmanageableStanding({ id: STAFF_ORG, kind: "customer", staffAccountCount: 0 }, STAFF_ORG), "platform");
  assert.equal(unmanageableStanding({ id: ACME, kind: "legacy_holding", staffAccountCount: 0 }, STAFF_ORG), "legacy_holding");
  assert.equal(unmanageableStanding({ id: ACME, kind: "", staffAccountCount: 0 }, STAFF_ORG), "");
  for (const file of ["manageOrganizationMembers.ts", "manageOrganizationTeams.ts"]) {
    const source = fs.readFileSync(path.join(__dirname, "../src/modules/staffAccess/application", file), "utf8");
    assert.match(source, /const standing = unmanageableStanding\(organization, current\.staff\.organizationId\);/, file);
    assert.doesNotMatch(source, /staffAccountCount|organization\.kind/, file);
  }
});

// ── Tenant scope ─────────────────────────────────────────────────────────────────────────────

test("tenant scope: every store and directory call names the path's organization; the session's organization is never used", async () => {
  for (const [name, , run] of ALL) {
    const { management, calls } = setup();
    await run(management, staff());
    assert.ok(calls.length >= 2, name);
    for (const call of calls) {
      const organizationId = typeof call[1] === "string" ? call[1] : call[1].organizationId;
      assert.equal(organizationId, ACME, `${name}: ${call[0]}`);
      // The staff organization is in no query at all: it is only the organization of the audit event.
      assert.equal(JSON.stringify(call).includes(STAFF_ORG), false, `${name}: ${call[0]}`);
    }
  }
});

test("a team of another organization is not found, exactly like one that doesn't exist, and nothing is written in either organization", async () => {
  const cases = [
    ["team", (m) => m.team(staff(), ACME, T.north), 404, "TEAM_NOT_FOUND"],
  ];
  for (const [name, run, status, code] of cases) {
    const { management, audit, calls, world, writes } = setup();
    const before = world();
    let message;
    await assert.rejects(run(management), (error) => { message = error.message; return refusedWith(status, code)(error); }, name);
    assert.equal(world(), before, name);
    for (const call of calls) assert.equal(typeof call[1] === "string" ? call[1] : call[1].organizationId, ACME, `${name}: ${call[0]} names the path's organization`);
    assert.equal(calls.some((call) => JSON.stringify(call).includes(OTHER)), false, `${name}: the other organization is never queried`);
    assert.equal(writes().length, 0, name);
    const event = oneStaffEvent(audit, { decision: "denied", reason: code.toLowerCase(), metadata: { organizationId: ACME } });
    assert.equal(JSON.stringify(event).includes("North"), false, "nothing of the other organization is named");
    // The same answer as for an id that exists nowhere.
    const missing = setup();
    const nowhere = (value) => (value === T.north ? "aaaa0000000000000000dead" : value === FOREIGN ? hex("0") : value);
    const again = { team: () => missing.management.team(staff(), ACME, nowhere(T.north)) }[name];
    if (again) await assert.rejects(again(), (error) => error.message === message && error.code === code);
  }
});

// ── The read ─────────────────────────────────────────────────────────────────────────────────

const TEAM_KEYS = ["id", "name", "archived", "archivedAt", "createdAt", "memberCount", "managers"];
const MEMBER_KEYS = ["userId", "name", "email", "roles", "status", "teams", "joinedAt", "lastSignedInAt"];

test("team read: the team of the path's organization with its members and their versions, recorded once; it fails if the event cannot be written", async () => {
  const { management, audit, calls } = setup();
  const answer = await management.team(staff(), ACME, T.west);
  assert.deepEqual([answer.team.id, answer.team.name, answer.team.memberCount, answer.team.managers.map((m) => m.id)], [T.west, "West", 2, [ids.manager]]);
  assert.deepEqual(answer.members.map((m) => [m.member.userId, m.version, m.isManager]), [[ids.planner, 1, false], [ids.manager, 1, true]]);
  assert.deepEqual(calls, [["organization", ACME], ["team", ACME, T.west]]);
  oneStaffEvent(audit, { action: "platform.organization_team.read", decision: "allowed", reason: "team", targetId: T.west, metadata: { organizationId: ACME, teamId: T.west, resource: "team" } });
  const failing = setup();
  failing.state.failAudit = true;
  await assert.rejects(failing.management.team(staff(), ACME, T.west), /audit store down/);
});

test("team read on a large team: the managers are read on their own, so a manager who sorts after the 200 members returned is still listed; every query names the organization and the team", async () => {
  const Team = require("../modal/teamModel").default;
  const TeamMembership = require("../modal/teamMembershipModel").default;
  const { createMongoStaffTeamDirectory, STAFF_TEAM_MEMBER_LIMIT, STAFF_TEAM_MANAGER_LIMIT } = require("../src/modules/staffAccess/infrastructure/mongoStaffTeamDirectory");
  assert.deepEqual([STAFF_TEAM_MEMBER_LIMIT, STAFF_TEAM_MANAGER_LIMIT], [200, 200]);
  const user = (n) => n.toString(16).padStart(24, "0");
  const at = (n) => new Date(Date.UTC(2026, 9, 1, 0, 0, n));
  // 205 members of West in Acme. The first (row 1) and the LAST two (rows 204 and 205) are managers.
  // Row 205's user is no longer a member of Acme. Plus a manager of another team and one of another organization.
  const TOTAL = 205;
  const stored = Array.from({ length: TOTAL }, (_, i) => ({ _id: user(1000 + i), organizationId: ACME, teamId: T.west, userId: user(i + 1), isManager: i === 0 || i >= TOTAL - 2, createdAt: at(i) }));
  stored.push({ _id: user(5000), organizationId: ACME, teamId: T.east, userId: user(9001), isManager: true, createdAt: at(0) });
  stored.push({ _id: user(5001), organizationId: OTHER, teamId: T.north, userId: user(9002), isManager: true, createdAt: at(0) });
  stored.reverse(); // stored order is not the answer's order
  const queries = [];
  const matches = (filter) => (row) => Object.entries(filter).every(([key, value]) => String(row[key]) === String(value));
  const original = { findOne: Team.findOne, find: TeamMembership.find, countDocuments: TeamMembership.countDocuments };
  Team.findOne = (filter) => ({ select() { return this; }, lean: async () => (String(filter._id) === T.west && String(filter.organizationId) === ACME ? { _id: T.west, name: "West", archived: false, archivedAt: null, createdAt: at(0) } : null) });
  TeamMembership.find = (filter) => {
    const query = { filter, fields: null, order: null, max: null };
    queries.push(query);
    return {
      select(fields) { query.fields = fields; return this; },
      sort(order) { query.order = order; return this; },
      limit(max) { query.max = max; return this; },
      lean: async () => stored.filter(matches(filter)).sort((x, y) => x.createdAt - y.createdAt || x._id.localeCompare(y._id)).slice(0, query.max ?? undefined)
        .map((row) => Object.fromEntries(["_id", ...query.fields.split(" ")].map((field) => [field, row[field]]))),
    };
  };
  TeamMembership.countDocuments = async (filter) => { queries.push({ filter, count: true }); return stored.filter(matches(filter)).length; };
  const lookups = [];
  const members = {
    async member(organizationId, userId) {
      lookups.push([organizationId, userId]);
      if (organizationId !== ACME || userId === user(TOTAL) || parseInt(userId, 16) > TOTAL) return null;
      return { member: { userId, name: `Member ${parseInt(userId, 16)}`, email: `m${parseInt(userId, 16)}@example.test`, roles: ["team_manager"], status: "active", teams: [], joinedAt: at(0), lastSignedInAt: null }, version: 3 };
    },
  };
  try {
    const answer = await createMongoStaffTeamDirectory(members).team(ACME, T.west);
    assert.equal(answer.team.memberCount, TOTAL, "the true count");
    assert.equal(answer.members.length, 200, "the first 200 members, oldest first");
    assert.deepEqual([answer.members[0].member.userId, answer.members[199].member.userId], [user(1), user(200)]);
    assert.equal(answer.members.some((m) => m.member.userId === user(204)), false, "the last manager is not among the members returned");
    assert.deepEqual(answer.members.filter((m) => m.isManager).map((m) => m.member.userId), [user(1)]);
    // The manager of row 204 is listed all the same; row 205's user is not a member of Acme and is left out.
    assert.deepEqual(answer.team.managers, [{ id: user(1), name: "Member 1", email: "m1@example.test" }, { id: user(204), name: "Member 204", email: "m204@example.test" }]);
    assert.deepEqual(Object.keys(answer.team).sort(), ["archived", "archivedAt", "createdAt", "id", "managers", "memberCount", "name"]);
    // Three reads of team rows: the members, the count and the managers. Each names the organization AND the team; both lists are bounded and ordered.
    assert.equal(queries.length, 3);
    for (const query of queries) assert.deepEqual([String(query.filter.organizationId), String(query.filter.teamId)], [ACME, T.west]);
    const [memberRead, , managerRead] = [queries.find((q) => !q.count && q.filter.isManager === undefined), null, queries.find((q) => q.filter.isManager !== undefined)];
    assert.deepEqual([Object.keys(memberRead.filter).sort(), memberRead.fields, memberRead.order, memberRead.max], [["organizationId", "teamId"], "userId isManager", { createdAt: 1, _id: 1 }, 200]);
    assert.deepEqual([Object.keys(managerRead.filter).sort(), managerRead.filter.isManager, managerRead.fields, managerRead.order, managerRead.max], [["isManager", "organizationId", "teamId"], true, "userId", { createdAt: 1, _id: 1 }, 200]);
    // Every person is read through the staff member directory in the path's organization, once each: the other team's and the other organization's managers never.
    assert.equal(lookups.every(([organizationId]) => organizationId === ACME), true);
    assert.equal(new Set(lookups.map(([, userId]) => userId)).size, lookups.length);
    assert.deepEqual(lookups.map(([, userId]) => userId).filter((userId) => parseInt(userId, 16) > 200), [user(204), user(205)]);
    assert.equal(lookups.length, 202);
    // Another organization's team is not found, and no team row is read for it.
    queries.length = 0;
    assert.equal(await createMongoStaffTeamDirectory(members).team(OTHER, T.west), null);
    assert.deepEqual(queries, []);
  } finally {
    Team.findOne = original.findOne;
    TeamMembership.find = original.find;
    TeamMembership.countDocuments = original.countDocuments;
  }
  const directory = read("src/modules/staffAccess/infrastructure/mongoStaffTeamDirectory.ts");
  assert.match(directory, /TeamMembership\.find\(\{ organizationId: organization, teamId: team\._id, isManager: true \}\)\.select\("userId"\)\s+\.sort\(\{ createdAt: 1, _id: 1 \}\)\.limit\(STAFF_TEAM_MANAGER_LIMIT\)\.lean<Row\[\]>\(\)/);
  assert.equal((directory.match(/TeamMembership\.\w+\(/g) ?? []).length, 3);
  assert.doesNotMatch(directory, /detail\.filter\(/, "the managers are not picked from the members returned");
});

// ── Audit ────────────────────────────────────────────────────────────────────────────────────

test("audit: every request leaves exactly one event in the STAFF organization and none in the customer organization, allowed or refused", async () => {
  for (const [name, action, run] of ALL) {
    const allowed = setup();
    await run(allowed.management, staff());
    oneStaffEvent(allowed.audit, { action, decision: "allowed", metadata: { organizationId: ACME } });
    const refused = setup();
    await assert.rejects(run(refused.management, staff(), hex("0")));
    oneStaffEvent(refused.audit, { action, decision: "denied" });
    for (const event of [...allowed.audit, ...refused.audit]) {
      assert.notEqual(event.organizationId, ACME, name);
      assert.doesNotMatch(event.action, /^(team\.|organization\.|proposal\.|auth\.)/, name);
      assert.equal(ACTIONS.includes(event.action), true);
    }
  }
  assert.deepEqual(ACTIONS, [
    "platform.organization_team.read", "platform.organization_team.created", "platform.organization_team.renamed", "platform.organization_team.archived",
    "platform.organization_team.member_added", "platform.organization_team.member_removed", "platform.organization_team.manager_changed", "platform.organization_member.teams_changed",
  ]);
  // The member actions of the sibling change are what they were.
  assert.equal(Object.values(STAFF_MEMBER_AUDIT).some((action) => ACTIONS.includes(action)), false);
});

test("audit: a refusal is returned even when its event cannot be written; a read that returned data fails instead", async () => {
  // A refusal is returned even when its event cannot be written (nothing was changed).
  const refused = setup();
  refused.state.failAudit = true;
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    await assert.rejects(refused.management.team(staff(), ACME, T.north), refusedWith(404, "TEAM_NOT_FOUND"));
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /could not be recorded/);
  // A read that returned the team needs its event: it fails without one.
  const failing = setup();
  failing.state.failAudit = true;
  await assert.rejects(failing.management.team(staff(), ACME, T.west), /audit store down/);
});

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const codeOf = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("audit: no code path of the staff team service writes into the customer organization, and the service is given nothing that can write", async () => {
  const service = read("src/modules/staffAccess/application/manageOrganizationTeams.ts");
  const code = codeOf(service);
  // One place builds every event, and its organization is the staff member's.
  assert.equal((code.match(/\borganizationId: attempt\.staff\.organizationId,/g) ?? []).length, 1);
  assert.equal((code.match(/audit\.append\(/g) ?? []).length, 2);
  for (const append of code.match(/audit\.append\(\{[^\n]*/g)) assert.match(append, /audit\.append\(\{ \.\.\.(eventOf\(|event,)/);
  assert.doesNotMatch(code, /"team\.|organization\.member\.|auth\.sessions|proposal\./);
  // The customer compositions (whose team service writes `team.*`) are not used by the staff service or its controller.
  for (const file of ["src/modules/staffAccess/application/manageOrganizationTeams.ts", "controller/adminOrganizationTeamsController.ts", "routes/adminOrganizationTeamsRoute.ts"]) {
    assert.doesNotMatch(read(file), /teams\/composition|organizationMembers\/composition|teamAdministration\b|\bmemberManagement\b|createMemberManagement/, file);
  }
  // The service takes two read-only directories and the audit writer and nothing else: no team
  // rules, no membership store, no team store.
  assert.match(service, /type Dependencies = \{\s+directory: StaffMemberDirectory;\s+teamDirectory: StaffTeamDirectory;\s+audit: StaffContentAudit;\s+\};/);
  assert.doesNotMatch(service, /modules\/teams|organizationMembers|TeamAdministration|MembershipStore|(?<!Staff)TeamDirectory\b|staffTeamActor/);
  const composition = read("src/modules/staffAccess/composition.ts");
  assert.match(composition, /export const staffTeamManagement = createStaffTeamManagement\(\{\s+directory: mongoStaffMemberDirectory,\s+teamDirectory: mongoStaffTeamDirectory,\s+audit: mongoSecurityAuditWriter,\s+\}\);/);
  assert.doesNotMatch(composition, /createTeamAdministration|mongoTeamRepository|mongoTeamDirectory|mongoMembershipStore|modules\/teams|organizationMembers/);
  // The customer's team rules write the member event in one place and have no staff branch.
  const rules = codeOf(read("src/modules/teams/application/manageTeams.ts"));
  assert.equal((rules.match(/audit\.append\(/g) ?? []).length, 1);
  assert.doesNotMatch(rules, /staff/i);
  // The directory performs no write.
  const directory = read("src/modules/staffAccess/infrastructure/mongoStaffTeamDirectory.ts");
  assert.doesNotMatch(directory, /\.(create|insertMany|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|deleteOne|deleteMany|findOneAndDelete|replaceOne|bulkWrite|save)\(/);
  assert.doesNotMatch(directory, /securityAuditEventModel|SecurityAuditEvent/);
  assert.match(directory, /Team\.findOne\(\{ organizationId: organization, _id: oid\(teamId\) \}\)\.select\("name archived archivedAt createdAt"\)/);
  assert.match(directory, /TeamMembership\.find\(\{ organizationId: organization, teamId: team\._id \}\)\.select\("userId isManager"\)/);
  assert.match(directory, /TeamMembership\.countDocuments\(\{ organizationId: organization, teamId: team\._id \}\)/);
  assert.match(directory, /members\.member\(organizationId, String\(row\.userId\)\)/);
});

// ── The customer path ────────────────────────────────────────────────────────────────────────

const fakeResponse = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test("the organization's own Admin is served as before: the same outcome, the member event in the organization, the Admin stored as creator, and a store that is handed no event", async () => {
  const ADMIN = { organizationId: ACME, userId: ids.admin, roles: ["organization_admin"], correlationId: "corr-admin" };
  const scenario = [
    ["create", (c) => c.customerTeams.create(ADMIN, { name: "South" }), "team.created", "created", { name: "South" }],
    ["rename", (c) => c.customerTeams.rename(ADMIN, T.west, { name: "West Coast" }), "team.renamed", "allowed", { name: "West Coast", previousName: "West" }],
    ["addMember", (c) => c.customerTeams.addMember(ADMIN, T.east, { userId: ids.manager, isManager: true }), "team.member_added", "created", { userId: ids.manager, isManager: true }],
    ["setManager", (c) => c.customerTeams.setManager(ADMIN, T.west, ids.manager, { isManager: false }), "team.manager_changed", "revoked", { userId: ids.manager, isManager: false }],
    ["removeMember", (c) => c.customerTeams.removeMember(ADMIN, T.west, ids.planner), "team.member_removed", "revoked", { userId: ids.planner }],
    ["archive", (c) => c.customerTeams.archive(ADMIN, T.west), "team.archived", "revoked", {}],
    ["setMemberTeams", (c) => c.customerMembers.changeTeams(ADMIN, { userId: ids.planner, teamIds: [T.east], version: 1 }), "organization.member.teams_changed", "allowed", { previousTeamIds: [T.west], teamIds: [T.east], version: 2 }],
  ];
  for (const [name, byAdmin, action, decision, metadata] of scenario) {
    const customer = setup();
    const before = customer.world();
    await byAdmin(customer);
    assert.notEqual(customer.world(), before, `${name}: applied`);
    if (name === "create") assert.equal(customer.teamRows.at(-1).createdBy, ids.admin);
    // The Admin's event, in the customer organization; no staff-side event.
    assert.equal(customer.audit.length, 1, name);
    const [event] = customer.audit;
    assert.deepEqual([event.organizationId, event.actorUserId, event.action, event.decision, event.correlationId, event.metadata], [ACME, ids.admin, action, decision, "corr-admin", metadata], name);
    assert.deepEqual([event.targetType, event.reason], name === "setMemberTeams" ? ["organization_membership", "teams_changed"] : ["team", action], name);
    // The store is given no event and no `audit` key at all.
    for (const [write, input] of customer.writes()) assert.equal("audit" in input, false, `${name}: ${write}`);
    if (name === "setMemberTeams") assert.deepEqual(customer.calls.filter(([n]) => /bumpVersion|setMemberTeams/.test(n)).map(([n]) => n), ["members.bumpVersion", "memberTeams.setMemberTeams"]);
  }
  // The refusals the Admin gets are the customer's own.
  const refusals = [
    [(c) => c.customerTeams.create(ADMIN, { name: "west" }), 409, "TEAM_NAME_TAKEN"],
    [(c) => c.customerTeams.rename(ADMIN, T.old, { name: "X" }), 409, "TEAM_ARCHIVED"],
    [(c) => c.customerTeams.rename(ADMIN, T.north, { name: "X" }), 404, "TEAM_NOT_FOUND"],
    [(c) => c.customerTeams.archive(ADMIN, T.old), 409, "TEAM_ARCHIVED"],
    [(c) => c.customerTeams.addMember(ADMIN, T.east, { userId: ids.planner, isManager: true }), 422, "TEAM_MANAGER_ROLE_REQUIRED"],
    [(c) => c.customerTeams.addMember(ADMIN, T.east, { userId: FOREIGN }), 404, "MEMBER_NOT_FOUND"],
    [(c) => c.customerTeams.addMember(ADMIN, T.east, { userId: "not-an-id" }), 404, "MEMBER_NOT_FOUND"],
    [(c) => c.customerTeams.addMember(ADMIN, T.west, { userId: ids.planner }), 409, "TEAM_MEMBER_EXISTS"],
    [(c) => c.customerTeams.removeMember(ADMIN, T.west, ids.viewer), 404, "TEAM_MEMBER_NOT_FOUND"],
    [(c) => c.customerTeams.setManager(ADMIN, T.west, ids.planner, { isManager: true }), 422, "TEAM_MANAGER_ROLE_REQUIRED"],
    [(c) => c.customerTeams.setManager(ADMIN, T.west, ids.manager, { isManager: 1 }), 400, "INVALID_TEAM_MANAGER"],
    [(c) => c.customerTeams.setManager(ADMIN, T.east, ids.manager, { isManager: false }), 404, "TEAM_MEMBER_NOT_FOUND"],
  ];
  for (const [byAdmin, status, code] of refusals) {
    await assert.rejects(byAdmin(setup()), (error) => error instanceof TeamError && error.status === status && error.code === code, code);
  }
  for (const [body, status, code] of [
    [{ teamIds: "x", version: 1 }, 400, "INVALID_TEAMS"], [{ teamIds: [T.east] }, 400, "VERSION_REQUIRED"], [{ teamIds: [T.east], version: 9 }, 409, "STALE_VERSION"],
    [{ teamIds: [T.old], version: 1 }, 400, "UNKNOWN_TEAMS"], [{ teamIds: [T.north, T.east], version: 1 }, 400, "UNKNOWN_TEAMS"],
  ]) {
    const refused = await setup().customerMembers.changeTeams(ADMIN, { userId: ids.planner, ...body });
    assert.deepEqual([refused.ok, refused.status, refused.code], [false, status, code], JSON.stringify(body));
  }
  for (const [userId, code] of [[ids.removed, "MEMBER_REMOVED"], [FOREIGN, "MEMBER_NOT_FOUND"]]) {
    assert.equal((await setup().customerMembers.changeTeams(ADMIN, { userId, teamIds: [T.east], version: 1 })).code, code);
  }
  // No one but a member holding the role passes the team rules: there is no staff actor any more.
  const teamsDomain = require("../src/modules/teams/domain");
  assert.equal("staffTeamActor" in teamsDomain || "isStaffTeamActor" in teamsDomain, false);
  for (const actor of [{ staff: true, organizationId: ACME, roles: [] }, { ...ADMIN, roles: [], staff: true }, { ...ADMIN, roles: ["planner"] }]) {
    await assert.rejects(setup().customerTeams.create(actor, { name: "South" }), (error) => error instanceof TeamError && error.status === 403 && error.code === "TEAM_ADMIN_REQUIRED");
  }
});

// ── The customer's audit log ─────────────────────────────────────────────────────────────────

let seq = 0;
const stored = (overrides) => {
  seq += 1;
  return { id: seq.toString(16).padStart(24, "0"), organizationId: ACME, actorUserId: STAFF, targetType: "team", targetId: T.west, decision: "allowed", reason: "team_renamed", metadata: { staffReason: REASON, name: "West Coast", previousName: "West", before: { name: "West" }, userId: ids.planner, isManager: true }, createdAt: new Date(Date.UTC(2026, 10, 18, 0, 0, seq)), ...overrides };
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

test("the customer audit log cannot return a staff team action: not in the catalog, not by default, not as a stored row, not in the CSV", async () => {
  for (const action of ACTIONS) {
    assert.match(action, /^platform\.organization_(team|member)\.[a-z_]+$/);
    assert.equal(Object.prototype.hasOwnProperty.call(AUDIT_CATALOG, action), false, action);
    assert.equal(catalogEntry(action), undefined, action);
    assert.equal(isStaffOnlyAction(action), true, action);
    assert.equal(VISIBLE_ACTIONS.includes(action), false, action);
  }
  assert.equal(JSON.stringify(AUDIT_CATALOG).includes("platform."), false);
  // The customer's own team actions are still in the catalog.
  for (const action of CUSTOMER_TEAM_ACTIONS) assert.equal(VISIBLE_ACTIONS.includes(action), true, action);
  // Rows that should never exist: the staff actions stored in the CUSTOMER organization. Even
  // then, and even with a reader that ignores the action filter, none is returned.
  const visible = stored({ action: "team.renamed", actorUserId: ids.owner, metadata: { name: "West Coast", previousName: "West" } });
  const rows = [...ACTIONS.flatMap((action) => [stored({ action }), stored({ action, decision: "denied", reason: "team_archived" })]), visible];
  for (const leaky of [false, true]) {
    const events = fakeEvents(rows, leaky);
    const log = createAuditLog({ events });
    for (const role of ["owner", "organization_admin"]) {
      const page = await log.list({ ...owner, roles: [role] }, {});
      assert.deepEqual(page.events.map((e) => e.id), [visible.id]);
      const exported = await log.exportCsv({ ...owner, roles: [role] }, {});
      assert.equal(exported.rows, 1);
      for (const hidden of ["platform.", "organization_team.", "organization_member.", REASON, "Staff Name", STAFF, "staffReason"]) {
        assert.equal(JSON.stringify(page).includes(hidden), false, hidden);
        assert.equal(exported.csv.includes(hidden), false, hidden);
      }
    }
    assert.equal(events.nameLookups.includes(STAFF), false, "the staff account is never looked up as a member");
  }
});

test("a staff team action cannot be asked for by action, by category or by the staff account as actor, in the list or the CSV; the filter options do not offer one", async () => {
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
  for (const category of ["platform", "staff", "organization_team", "organization_member"]) await assert.rejects(() => log.list(owner, { category }), invalid, category);
  for (const call of events.calls) for (const action of call.filter.actions) assert.equal(isStaffOnlyAction(action), false, action);
  const offered = log.filters(owner).categories.flatMap((category) => category.actions.map((action) => action.value));
  assert.deepEqual(offered.filter((action) => ACTIONS.includes(action) || action.startsWith("platform.")), []);
  assert.equal(JSON.stringify(log.filters(owner)).includes("platform"), false);
  // The "teams" category still offers the customer's own six actions and nothing else.
  assert.deepEqual(log.filters(owner).categories.find((category) => category.key === "teams").actions.map((action) => action.value).sort(), CUSTOMER_TEAM_ACTIONS.filter((action) => action.startsWith("team.")).sort());
});

// ── Answers ──────────────────────────────────────────────────────────────────────────────────

test("answers are built from the staff reads' allowlists: the team view and the member view, no token, hash, session data or stored document, whatever the directory hands back", async () => {
  const { staffMemberView, staffTeamView } = require("../src/modules/staffAccess/application/readOrganizationContent");
  const source = read("src/modules/staffAccess/application/manageOrganizationTeams.ts");
  assert.match(source, /team: staffTeamView\(detail\.team\),\s+members: detail\.members\.map\(\(entry\) => \(\{ member: staffMemberView\(entry\.member\), version: entry\.version, isManager: entry\.isManager === true \}\)\),/);
  assert.equal((source.match(/staffTeamView\(/g) ?? []).length, 1);
  assert.equal((source.match(/staffMemberView\(/g) ?? []).length, 1, "a team's members");
  assert.equal((source.match(/\.\.\.teamDetailView\(found\)/g) ?? []).length, 1, "the read's answer");
  // The staff teams read uses the same team view.
  assert.match(read("src/modules/staffAccess/application/readOrganizationContent.ts"), /teams: teams\.map\(staffTeamView\),/);
  assert.deepEqual(Object.keys(staffTeamView({ id: "t", name: "n", archived: false, archivedAt: null, createdAt: null, memberCount: 0, managers: [{ id: "u", name: null, email: null, ...SECRETS }], ...SECRETS })), TEAM_KEYS);
  assert.deepEqual(Object.keys(staffTeamView({ id: "t", name: "n", archived: false, archivedAt: null, createdAt: null, memberCount: 0, managers: [{ id: "u", name: null, email: null, ...SECRETS }] }).managers[0]), ["id", "name", "email"]);
  assert.deepEqual(Object.keys(staffMemberView({ userId: "u", name: null, email: null, roles: [], status: "active", teams: [], joinedAt: null, lastSignedInAt: null, ...SECRETS })), MEMBER_KEYS);
  const memberShaped = (member, label) => {
    assert.deepEqual(Object.keys(member), MEMBER_KEYS, label);
    for (const team of member.teams) assert.deepEqual(Object.keys(team), ["id", "name", "archived", "isManager"], label);
  };
  for (const [name, , run] of ALL) {
    const { management } = setup();
    const answer = await run(management, staff());
    noSecrets(answer, name);
    assert.equal(answer.organizationId, ACME);
    assert.deepEqual(Object.keys(answer), ["organizationId", "team", "members"], name);
    assert.deepEqual(Object.keys(answer.team), TEAM_KEYS, name);
    for (const manager of answer.team.managers) assert.deepEqual(Object.keys(manager), ["id", "name", "email"]);
    for (const entry of answer.members) {
      assert.deepEqual(Object.keys(entry), ["member", "version", "isManager"], name);
      memberShaped(entry.member, name);
      assert.deepEqual([typeof entry.version, typeof entry.isManager], ["number", "boolean"]);
    }
  }
});

test("user-facing text says proposal, never RFP", async () => {
  for (const file of ["src/modules/staffAccess/application/manageOrganizationTeams.ts", "controller/adminOrganizationTeamsController.ts", "routes/adminOrganizationTeamsRoute.ts", "src/modules/staffAccess/infrastructure/mongoStaffTeamDirectory.ts"]) {
    for (const literal of read(file).match(/"[^"\n]*"|`[^`\n]*`/g) ?? []) {
      if (/^["`][A-Z_]+["`]$/.test(literal)) continue;
      assert.doesNotMatch(literal, /\bRFPs?\b/i, `${file}: ${literal}`);
    }
  }
});

// ── Controller ───────────────────────────────────────────────────────────────────────────────

const request = (overrides = {}) => ({
  user: { userId: STAFF, organizationId: STAFF_ORG, role: "admin", accountType: "admin", roles: ["dxg_admin"] },
  params: { organizationId: ACME, teamId: T.west }, query: {}, body: {}, correlationId: "corr-staff", ...overrides,
});

test("controller: the organization and team come from the path only; refusals carry code, message and details; an unexpected error is a plain 500; there is no write handler", async () => {
  const { management, audit, world, calls } = setup();
  const controller = createAdminOrganizationTeamsController(management);
  assert.deepEqual(Object.keys(controller), ["team"], "the read is the only handler");
  assert.deepEqual(Object.keys(management), ["team"], "and the only method of the service");
  // A body or query that names another organization or team is ignored.
  const before = world();
  const res = fakeResponse();
  await controller.team(request({ body: { organizationId: OTHER, teamId: T.north }, query: { organizationId: OTHER, teamId: T.north } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual([res.body.success, res.body.data.organizationId, res.body.data.team.id, res.body.data.members.map((m) => m.member.userId)], [true, ACME, T.west, [ids.planner, ids.manager]]);
  assert.equal(calls.some((call) => JSON.stringify(call).includes(OTHER) || JSON.stringify(call).includes(T.north)), false);
  assert.equal(audit.length, 1);
  assert.equal(world(), before, "a read changes nothing");

  const cases = [
    [request({ params: { organizationId: HOLDING, teamId: T.west } }), 409, "ORGANIZATION_NOT_MANAGEABLE"],
    [request({ params: { organizationId: ACME, teamId: T.north } }), 404, "TEAM_NOT_FOUND"],
    [request({ params: { organizationId: ACME, teamId: "x" } }), 400, "INVALID_TEAM_ID"],
    [request({ user: { userId: ids.owner, organizationId: ACME, role: "customer", accountType: "planner", roles: ["owner"] } }), 403, "STAFF_ACCESS_FORBIDDEN"],
    [request({ user: undefined }), 401, "AUTHENTICATION_REQUIRED"],
  ];
  for (const [req, status, code] of cases) {
    const response = fakeResponse();
    await createAdminOrganizationTeamsController(setup().management).team(req, response);
    assert.deepEqual([response.statusCode, response.body.success, response.body.code], [status, false, code], code);
    assert.equal(typeof response.body.message, "string");
    assert.equal("data" in response.body, false);
    if (code === "ORGANIZATION_NOT_MANAGEABLE") assert.equal(response.body.standing, "legacy_holding", "details sit beside code and message");
  }

  const broken = createAdminOrganizationTeamsController({ team: async () => { throw new Error("mongo exploded: secret detail"); } });
  const failed = fakeResponse();
  const original = console.error;
  console.error = () => {};
  try { await broken.team(request(), failed); } finally { console.error = original; }
  assert.deepEqual([failed.statusCode, failed.body.code], [500, "STAFF_TEAMS_INTERNAL_ERROR"]);
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
  const router = require("../routes/adminOrganizationTeamsRoute").default;
  const { staffContentReads } = require("../routes/adminOrganizationContentRoute");
  const { authenticate } = require("../middleware/auth");
  const { adminOrganizationTeamsController: controller } = require("../controller/adminOrganizationTeamsController");
  const routes = router.stack.filter((layer) => layer.route).map((layer) => layer.route);
  const describe = (route) => `${Object.keys(route.methods).join(",").toUpperCase()} ${route.path}`;
  assert.deepEqual(routes.map(describe), ["GET /admin/organizations/:organizationId/teams/:teamId"]);
  assert.equal(router.stack.every((layer) => layer.route), true, "no router-level middleware that could skip the guard");
  const [route] = routes;
  assert.equal(route.stack.length, 4, route.path);
  assert.equal(route.stack[0].handle, authenticate, route.path);
  guardRefusesCustomers(route.stack[1].handle, route.path);
  assert.equal(route.stack[2].handle, staffContentReads, route.path);
  assert.equal(route.stack[3].handle, controller.team, route.path);

  const source = read("routes/adminOrganizationTeamsRoute.ts");
  assert.doesNotMatch(source, /securityRateLimit\(|staffMemberWrites/, "no write limit, because there is no write");
  assert.match(source, /const staff = \[authenticate, authorize\("admin", "super_admin", "superadmin"\)\];/);
  const lines = source.split("\n").filter((line) => /^router\./.test(line));
  assert.deepEqual(lines, ['router.get("/admin/organizations/:organizationId/teams/:teamId", ...staff, staffContentReads, controller.team);']);
  assert.doesNotMatch(source, /router\.(post|put|patch|delete|all|use)\(/);
  for (const file of ["routes/adminOrganizationTeamsRoute.ts", "controller/adminOrganizationTeamsController.ts", "src/modules/staffAccess/application/manageOrganizationTeams.ts", "src/modules/staffAccess/infrastructure/mongoStaffTeamDirectory.ts"]) {
    assert.doesNotMatch(read(file), /proposalTemplate|ProposalTemplate|organizationVendor|OrganizationVendor|proposalsModel|invitationModel|Invitation\b|teamId: .*Proposal/, file);
  }
  assert.match(read("server.ts"), /app\.use\("\/api\/v1", adminOrganizationTeamsRoutes\);/);
  // Linted, as CLAUDE.md asks of a top-level controller and route.
  for (const file of ["controller/adminOrganizationTeamsController.ts", "routes/adminOrganizationTeamsRoute.ts"]) {
    assert.ok(JSON.parse(read("package.json")).scripts.lint.split(" ").includes(file), file);
    assert.ok(read("eslint.config.mjs").includes(`"${file}"`), file);
  }
});
