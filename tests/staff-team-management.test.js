require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createStaffTeamManagement } = require("../src/modules/staffAccess/application/manageOrganizationTeams");
const { STAFF_REASON_MIN, STAFF_REASON_MAX } = require("../src/modules/staffAccess/application/manageOrganizationMembers");
const { StaffAccessError, StaffMemberError, STAFF_MEMBER_AUDIT, STAFF_TEAM_AUDIT, unmanageableStanding } = require("../src/modules/staffAccess/domain");
const { createAdminOrganizationTeamsController } = require("../controller/adminOrganizationTeamsController");
const { createTeamsController } = require("../controller/teamsController");
const { createTeamAdministration } = require("../src/modules/teams/application/manageTeams");
const { TeamError, staffTeamActor, isStaffTeamActor } = require("../src/modules/teams/domain");
const { createMemberManagement } = require("../src/modules/organizationMembers/application/manageMembers");
const policy = require("../src/modules/organizationMembers/domain/memberPolicy");
const { createAuditLog } = require("../src/modules/auditLog/application/readAuditLog");
const { AUDIT_CATALOG, AUDIT_CATEGORIES, AuditLogError, VISIBLE_ACTIONS, catalogEntry, isStaffOnlyAction } = require("../src/modules/auditLog/domain");

// Owner decision 2026-11-18 (docs/DECISIONS.md): RFPilot staff manage a customer organization's
// teams under the customer's own rules; every request is recorded in the STAFF organization
// only. The sibling of tests/staff-member-management.test.js. The REAL team service runs here over
// in-memory ports; the real-database proof is tests-integration/staff-team-management.test.ts.

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
const REASON = "Customer asked us on the phone, ticket 4471";
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
  const state = { failAudit: false, failStoreAudit: false, archiveRace: false, teamsUnavailable: false, archivedAtCommit: null, storeRefusal: null };
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
  // As the Mongo store: a write given an event commits both in one transaction, or neither.
  const commit = (event, extra, apply) => {
    if (event && state.failStoreAudit) throw new Error("audit store down");
    apply();
    if (event) audit.push({ ...event, ...(extra.targetId ? { targetId: extra.targetId } : {}), decision: "allowed", metadata: { ...event.metadata, ...(extra.metadata ?? {}) } });
  };
  const teams = {
    async list(organizationId) { calls.push(["teams.list", organizationId]); return teamRows.filter((t) => t.organizationId === organizationId).map(record); },
    async findById(organizationId, teamId) { calls.push(["teams.findById", organizationId, teamId]); const t = team(organizationId, teamId); return t ? record(t) : null; },
    async create(input) {
      calls.push(["teams.create", input]);
      if (nameTaken(input.organizationId, input.name)) return "duplicate";
      const created = { id: `aaaa${String(next++).padStart(20, "9")}`, organizationId: input.organizationId, name: input.name, archived: false, archivedAt: null, createdAt: new Date("2026-11-18T00:00:00Z"), createdBy: input.createdBy };
      commit(input.audit, { targetId: created.id, metadata: { teamId: created.id } }, () => teamRows.push(created));
      return record(created);
    },
    async rename(input) {
      calls.push(["teams.rename", input]);
      const t = team(input.organizationId, input.teamId);
      if (!t || t.archived) return null;
      if (nameTaken(input.organizationId, input.name, input.teamId)) return "duplicate";
      const before = t.name;
      commit(input.audit, { metadata: { before: { name: before }, changed: before !== input.name } }, () => { t.name = input.name; });
      return record(t);
    },
    async archive(input) {
      calls.push(["teams.archive", input]);
      const t = team(input.organizationId, input.teamId);
      if (!t || t.archived || state.archiveRace) return false;
      commit(input.audit, {}, () => Object.assign(t, { archived: true, archivedAt: input.at }));
      return true;
    },
    async members(organizationId, teamIds) { calls.push(["teams.members", organizationId, teamIds]); return teamMembers.filter((m) => m.organizationId === organizationId && teamIds.includes(m.teamId)).map(({ organizationId: _o, ...m }) => m); },
    async addMember(input) {
      calls.push(["teams.addMember", input]);
      // As the Mongo store: what a staff write finds changed inside its transaction. Nothing is applied.
      if (input.audit && state.storeRefusal) return state.storeRefusal;
      if (teamMembers.some((m) => m.teamId === input.teamId && m.userId === input.userId)) return "exists";
      commit(input.audit, {}, () => teamMembers.push({ organizationId: input.organizationId, teamId: input.teamId, userId: input.userId, isManager: input.isManager }));
      return "added";
    },
    async removeMember(input) {
      calls.push(["teams.removeMember", input]);
      const index = teamMembers.findIndex((m) => m.organizationId === input.organizationId && m.teamId === input.teamId && m.userId === input.userId);
      if (index < 0) return false;
      commit(input.audit, { metadata: { before: { userId: input.userId, isManager: teamMembers[index].isManager } } }, () => teamMembers.splice(index, 1));
      return true;
    },
    async setManager(input) {
      calls.push(["teams.setManager", input]);
      if (input.audit && state.storeRefusal) return state.storeRefusal;
      const m = teamMembers.find((x) => x.organizationId === input.organizationId && x.teamId === input.teamId && x.userId === input.userId);
      if (!m) return false;
      const before = m.isManager;
      commit(input.audit, { metadata: { before: { isManager: before }, changed: before !== input.isManager } }, () => { m.isManager = input.isManager; });
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
    async activeTeamIds(organizationId, teamIds) { calls.push(["memberTeams.activeTeamIds", organizationId, teamIds]); return state.teamsUnavailable ? "unavailable" : activeIn(organizationId, teamIds); },
    // The member route's write: no version, no event.
    async setMemberTeams(input) { calls.push(["memberTeams.setMemberTeams(member)", input]); return { previousTeamIds: applyTeams(input.organizationId, input.userId, input.teamIds) }; },
  };
  const staffMemberTeams = {
    async setMemberTeams(input) {
      calls.push(["memberTeams.setMemberTeams", input]);
      const r = member(input.organizationId, input.userId);
      if (!r || r.version !== input.expectedVersion || r.status === "removed") return "stale";
      if (state.archivedAtCommit) return { unknownTeamIds: state.archivedAtCommit };
      if (state.failStoreAudit) throw new Error("audit store down");
      r.version += 1;
      const previousTeamIds = applyTeams(input.organizationId, input.userId, input.teamIds);
      const changed = previousTeamIds.length !== input.teamIds.length || previousTeamIds.some((id) => !input.teamIds.includes(id));
      audit.push({ ...input.audit, decision: "allowed", metadata: { ...input.audit.metadata, before: { teamIds: [...previousTeamIds].sort() }, changed, version: r.version } });
      return { previousTeamIds, version: r.version };
    },
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
  // The staff instance of the team service has no writer for the member events (composition.ts).
  const staffRules = createTeamAdministration({ teams, directory: orgMembers, audit: { append: async () => { throw new Error("A staff team change never writes an event in the customer organization."); } }, isValidId, now });
  const management = createStaffTeamManagement({
    directory, teamDirectory: staffTeamDirectory, teams: staffRules, members: store,
    memberTeams: { activeTeamIds: teamDirectory.activeTeamIds, setMemberTeams: staffMemberTeams.setMemberTeams },
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

// Every write, with a valid request in Acme. `teamId` and `userId` are what the path names.
const WRITES = [
  ["create", STAFF_TEAM_AUDIT.created, (m, s, org = ACME, _team, _user, body = {}) => m.create(s, org, { name: "South", reason: REASON, ...body })],
  ["rename", STAFF_TEAM_AUDIT.renamed, (m, s, org = ACME, teamId = T.west, _user, body = {}) => m.rename(s, org, teamId, { name: "West Coast", reason: REASON, ...body })],
  ["archive", STAFF_TEAM_AUDIT.archived, (m, s, org = ACME, teamId = T.west, _user, body = {}) => m.archive(s, org, teamId, { reason: REASON, ...body })],
  ["addMember", STAFF_TEAM_AUDIT.memberAdded, (m, s, org = ACME, teamId = T.east, userId = ids.manager, body = {}) => m.addMember(s, org, teamId, { userId, isManager: true, reason: REASON, ...body })],
  ["setManager", STAFF_TEAM_AUDIT.managerChanged, (m, s, org = ACME, teamId = T.west, userId = ids.manager, body = {}) => m.setManager(s, org, teamId, userId, { isManager: false, reason: REASON, ...body })],
  ["removeMember", STAFF_TEAM_AUDIT.memberRemoved, (m, s, org = ACME, teamId = T.west, userId = ids.planner, body = {}) => m.removeMember(s, org, teamId, userId, { reason: REASON, ...body })],
  ["setMemberTeams", STAFF_TEAM_AUDIT.memberTeamsChanged, (m, s, org = ACME, teamId = T.east, userId = ids.planner, body = {}) => m.setMemberTeams(s, org, userId, { teamIds: [teamId], version: 1, reason: REASON, ...body })],
];
const ALL = [...WRITES, ["team", STAFF_TEAM_AUDIT.read, (m, s, org = ACME, teamId = T.west) => m.team(s, org, teamId)]];
const TAKES_TEAM = ["rename", "archive", "addMember", "setManager", "removeMember", "team"];
const TAKES_MEMBER = ["setManager", "removeMember", "setMemberTeams"];

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

test("ids must be 24 lower-case hex characters: a malformed organization, team or member id is a 400 (the customer's code for a body id), looks nothing up, and is recorded once as denied", async () => {
  const BAD = ["", "nope", ACME.toUpperCase(), `${ACME}0`, ACME.slice(1), "aaaaaaaaaaaaaaaaaaaaaaag", { $ne: null }, null, ["a"]];
  for (const bad of BAD) {
    for (const [name, action, run] of ALL) {
      const cases = [[(m) => run(m, staff(), bad), "INVALID_ORGANIZATION_ID", 400]];
      if (TAKES_TEAM.includes(name)) cases.push([(m) => run(m, staff(), ACME, bad), "INVALID_TEAM_ID", 400]);
      if (TAKES_MEMBER.includes(name)) cases.push([(m) => run(m, staff(), ACME, undefined, bad), "INVALID_MEMBER_ID", 400]);
      // The member a team gains is named in the body: the customer's own answer for an id that can't be one.
      if (name === "addMember") cases.push([(m) => run(m, staff(), ACME, undefined, bad), "MEMBER_NOT_FOUND", 404]);
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
  // Every id in `teamIds`: a list of strings of 24 lower-case hex, at most 100.
  for (const teamIds of [undefined, null, "x", T.east, [T.east.toUpperCase()], ["nope"], [{ $ne: null }], [T.east, 5], Array.from({ length: 101 }, (_, i) => `aaaa${String(i).padStart(20, "0")}`)]) {
    const { management, audit, calls, world } = setup();
    const before = world();
    await assert.rejects(management.setMemberTeams(staff(), ACME, ids.planner, { teamIds, version: 1, reason: REASON }), refusedWith(400, "INVALID_TEAMS"), JSON.stringify(teamIds)?.slice(0, 60));
    assert.deepEqual([calls, world()], [[], before]);
    oneStaffEvent(audit, { decision: "denied", reason: "invalid_teams" });
  }
  // A long id is cut before it is stored.
  const long = setup();
  await assert.rejects(long.management.team(staff(), ACME, "z".repeat(5000)), refusedWith(400, "INVALID_TEAM_ID"));
  assert.equal(long.audit[0].metadata.teamId.length, 64);
});

test("reason is required on every write: trimmed, 10 to 500 characters, else 400 with a field error and nothing looked up", async () => {
  assert.deepEqual([STAFF_REASON_MIN, STAFF_REASON_MAX], [10, 500]);
  for (const [name, action, run] of WRITES) {
    for (const reason of [undefined, null, "", "   ", "too short", `  ${"x".repeat(9)}  `, "x".repeat(501), 12345678901, ["a reason in a list"], { reason: REASON }]) {
      const { management, audit, calls, world } = setup();
      const before = world();
      await assert.rejects(run(management, staff(), ACME, undefined, undefined, { reason }), (error) => {
        refusedWith(400, "INVALID_REASON")(error);
        assert.deepEqual(error.details, { fields: { reason: "Give a reason of 10 to 500 characters." } });
        return true;
      }, `${name} ${JSON.stringify(reason)?.slice(0, 30)}`);
      assert.deepEqual([calls, world()], [[], before], name);
      const event = oneStaffEvent(audit, { action, decision: "denied", reason: "invalid_reason" });
      assert.equal("staffReason" in event.metadata, false);
    }
    for (const reason of ["x".repeat(10), "x".repeat(500), `   ${REASON}   `]) {
      const { management, audit } = setup();
      await run(management, staff(), ACME, undefined, undefined, { reason });
      assert.equal(oneStaffEvent(audit, { action, decision: "allowed" }).metadata.staffReason, reason.trim(), name);
    }
  }
});

test("the reason is stored on the staff-side event only: never in an answer, never in the event's machine-readable reason", async () => {
  for (const [name, , run] of WRITES) {
    const { management, audit } = setup();
    const answer = await run(management, staff());
    assert.equal(JSON.stringify(answer).includes(REASON), false, name);
    assert.equal(audit[0].metadata.staffReason, REASON);
    assert.match(audit[0].reason, /^team[a-z_]*$/);
  }
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
      await assert.rejects(run(management, staff(), organizationId, teamId, ids.planner), (error) => {
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
  await assert.rejects(management.create(staff({ organizationId: ACME }), ACME, { name: "X", reason: REASON }), refusedWith(409, "ORGANIZATION_NOT_MANAGEABLE"));
  // One rule for the member and the team routes.
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
      assert.equal(JSON.stringify(call).includes(STAFF_ORG) && !call[0].startsWith("teams.") && call[0] !== "memberTeams.setMemberTeams", false, `${name}: ${call[0]}`);
      // The staff organization appears only as the organization of the event handed to a write.
      if (JSON.stringify(call).includes(STAFF_ORG)) assert.equal(call[1].audit.organizationId, STAFF_ORG);
    }
  }
});

test("a team, a member or a team id of another organization is not found (or an unknown team), exactly like one that doesn't exist, and nothing is written in either organization", async () => {
  const cases = [
    ["team", (m) => m.team(staff(), ACME, T.north), 404, "TEAM_NOT_FOUND"],
    ["rename", (m) => m.rename(staff(), ACME, T.north, { name: "Taken over", reason: REASON }), 404, "TEAM_NOT_FOUND"],
    ["archive", (m) => m.archive(staff(), ACME, T.north, { reason: REASON }), 404, "TEAM_NOT_FOUND"],
    ["addMember to a foreign team", (m) => m.addMember(staff(), ACME, T.north, { userId: ids.planner, reason: REASON }), 404, "TEAM_NOT_FOUND"],
    ["addMember of a foreign member", (m) => m.addMember(staff(), ACME, T.east, { userId: FOREIGN, isManager: true, reason: REASON }), 404, "MEMBER_NOT_FOUND"],
    ["setManager on a foreign team", (m) => m.setManager(staff(), ACME, T.north, FOREIGN, { isManager: false, reason: REASON }), 404, "TEAM_NOT_FOUND"],
    ["setManager of a foreign member", (m) => m.setManager(staff(), ACME, T.west, FOREIGN, { isManager: true, reason: REASON }), 404, "MEMBER_NOT_FOUND"],
    ["setManager off, foreign member", (m) => m.setManager(staff(), ACME, T.west, FOREIGN, { isManager: false, reason: REASON }), 404, "TEAM_MEMBER_NOT_FOUND"],
    ["removeMember from a foreign team", (m) => m.removeMember(staff(), ACME, T.north, FOREIGN, { reason: REASON }), 404, "TEAM_NOT_FOUND"],
    ["removeMember of a foreign member", (m) => m.removeMember(staff(), ACME, T.west, FOREIGN, { reason: REASON }), 404, "TEAM_MEMBER_NOT_FOUND"],
    ["setMemberTeams of a foreign member", (m) => m.setMemberTeams(staff(), ACME, FOREIGN, { teamIds: [T.east], version: 1, reason: REASON }), 404, "MEMBER_NOT_FOUND"],
    ["setMemberTeams with a foreign team", (m) => m.setMemberTeams(staff(), ACME, ids.planner, { teamIds: [T.east, T.north], version: 1, reason: REASON }), 400, "UNKNOWN_TEAMS"],
  ];
  for (const [name, run, status, code] of cases) {
    const { management, audit, calls, world, writes } = setup();
    const before = world();
    let message;
    await assert.rejects(run(management), (error) => { message = error.message; return refusedWith(status, code)(error); }, name);
    assert.equal(world(), before, name);
    for (const call of calls) assert.equal(typeof call[1] === "string" ? call[1] : call[1].organizationId, ACME, `${name}: ${call[0]} names the path's organization`);
    assert.equal(calls.some((call) => JSON.stringify(call).includes(OTHER)), false, `${name}: the other organization is never queried`);
    assert.equal(writes().filter(([n]) => n !== "teams.removeMember" && n !== "teams.setManager").length, 0, name);
    const event = oneStaffEvent(audit, { decision: "denied", reason: code.toLowerCase(), metadata: { organizationId: ACME } });
    assert.equal(JSON.stringify(event).includes("North"), false, "nothing of the other organization is named");
    // The same answer as for an id that exists nowhere.
    const missing = setup();
    const nowhere = (value) => (value === T.north ? "aaaa0000000000000000dead" : value === FOREIGN ? hex("0") : value);
    const again = { team: () => missing.management.team(staff(), ACME, nowhere(T.north)) }[name];
    if (again) await assert.rejects(again(), (error) => error.message === message && error.code === code);
  }
  const unknown = setup();
  await assert.rejects(unknown.management.setMemberTeams(staff(), ACME, ids.planner, { teamIds: [T.north, T.old, "aaaa0000000000000000dead", T.east], version: 1, reason: REASON }), (error) => {
    refusedWith(400, "UNKNOWN_TEAMS")(error);
    // Only ids the caller typed: a foreign, an archived and a missing team are told apart by nothing.
    assert.deepEqual(error.details, { unknownTeamIds: [T.north, T.old, "aaaa0000000000000000dead"] });
    return true;
  });
});

// ── The changes ──────────────────────────────────────────────────────────────────────────────

const TEAM_KEYS = ["id", "name", "archived", "archivedAt", "createdAt", "memberCount", "managers"];
const MEMBER_KEYS = ["userId", "name", "email", "roles", "status", "teams", "joinedAt", "lastSignedInAt"];

test("create: a team in the path's organization with no creator stored, one event with the new team's id committed with it; names are unique ignoring case", async () => {
  const { management, audit, teamRows, calls } = setup();
  const answer = await management.create(staff(), ACME, { name: "  South  ", reason: REASON });
  const created = teamRows.at(-1);
  assert.deepEqual([created.organizationId, created.name, created.archived, created.createdBy], [ACME, "South", false, null]);
  assert.deepEqual([answer.organizationId, answer.team.id, answer.team.name, answer.team.memberCount, answer.members], [ACME, created.id, "South", 0, []]);
  const write = calls.find(([n]) => n === "teams.create")[1];
  assert.equal(write.createdBy, null, "a staff account is never written into a customer organization");
  oneStaffEvent(audit, { action: STAFF_TEAM_AUDIT.created, decision: "allowed", reason: "team_created", targetId: created.id, metadata: { organizationId: ACME, teamId: created.id, changed: true, before: null, after: { name: "South" }, staffReason: REASON } });
  for (const [name, code, status] of [["west", "TEAM_NAME_TAKEN", 409], ["   ", "INVALID_TEAM_NAME", 400], ["x".repeat(121), "INVALID_TEAM_NAME", 400], [undefined, "INVALID_TEAM_NAME", 400], [{ $ne: "" }, "INVALID_TEAM_NAME", 400]]) {
    const refused = setup();
    const before = refused.world();
    await assert.rejects(refused.management.create(staff(), ACME, { name, reason: REASON }), refusedWith(status, code));
    assert.equal(refused.world(), before);
    oneStaffEvent(refused.audit, { action: STAFF_TEAM_AUDIT.created, decision: "denied", reason: code.toLowerCase() });
  }
  // An archived team's name is free, and another organization's names don't count.
  for (const name of ["Old", "North"]) assert.equal((await setup().management.create(staff(), ACME, { name, reason: REASON })).team.name, name);
});

test("rename: the name changes, one event with the name before and after; a taken name, an archived team and a missing team are refused", async () => {
  const { management, audit, team } = setup();
  const answer = await management.rename(staff(), ACME, T.west, { name: "West Coast", reason: REASON });
  assert.equal(team(ACME, T.west).name, "West Coast");
  assert.deepEqual([answer.team.id, answer.team.name, answer.members.length], [T.west, "West Coast", 2]);
  oneStaffEvent(audit, { action: STAFF_TEAM_AUDIT.renamed, decision: "allowed", reason: "team_renamed", targetId: T.west, metadata: { teamId: T.west, changed: true, before: { name: "West" }, after: { name: "West Coast" } } });
  const same = setup();
  await same.management.rename(staff(), ACME, T.west, { name: "West", reason: REASON });
  oneStaffEvent(same.audit, { decision: "allowed", metadata: { changed: false, before: { name: "West" }, after: { name: "West" } } });
  for (const [teamId, name, code, status] of [[T.west, "EAST", "TEAM_NAME_TAKEN", 409], [T.west, "", "INVALID_TEAM_NAME", 400], [T.old, "New", "TEAM_ARCHIVED", 409], ["aaaa0000000000000000dead", "New", "TEAM_NOT_FOUND", 404]]) {
    const refused = setup();
    const before = refused.world();
    await assert.rejects(refused.management.rename(staff(), ACME, teamId, { name, reason: REASON }), refusedWith(status, code));
    assert.equal(refused.world(), before);
    oneStaffEvent(refused.audit, { action: STAFF_TEAM_AUDIT.renamed, decision: "denied", reason: code.toLowerCase(), targetId: teamId });
  }
});

test("archive: the team is archived and its memberships are kept; no proposal is read or changed; an archived team is refused; a team archived meanwhile leaves one unchanged event", async () => {
  const { management, audit, team, teamMembers } = setup();
  const answer = await management.archive(staff(), ACME, T.west, { reason: REASON });
  assert.deepEqual([team(ACME, T.west).archived, team(ACME, T.west).archivedAt.toISOString()], [true, "2026-11-18T12:00:00.000Z"]);
  assert.equal(teamMembers.filter((m) => m.teamId === T.west).length, 2, "memberships are kept");
  assert.deepEqual([answer.team.archived, answer.team.memberCount, answer.members.length], [true, 2, 2]);
  oneStaffEvent(audit, { action: STAFF_TEAM_AUDIT.archived, decision: "allowed", reason: "team_archived", targetId: T.west, metadata: { changed: true, before: { archived: false, archivedAt: null }, after: { archived: true, archivedAt: new Date("2026-11-18T12:00:00Z") } } });
  for (const [teamId, code, status] of [[T.old, "TEAM_ARCHIVED", 409], ["aaaa0000000000000000dead", "TEAM_NOT_FOUND", 404]]) {
    const refused = setup();
    await assert.rejects(refused.management.archive(staff(), ACME, teamId, { reason: REASON }), refusedWith(status, code));
    oneStaffEvent(refused.audit, { action: STAFF_TEAM_AUDIT.archived, decision: "denied", reason: code.toLowerCase() });
  }
  const raced = setup();
  raced.state.archiveRace = true;
  await raced.management.archive(staff(), ACME, T.west, { reason: REASON });
  oneStaffEvent(raced.audit, { action: STAFF_TEAM_AUDIT.archived, decision: "allowed", reason: "team_archived_unchanged", metadata: { changed: false } });
  // Nothing in the team rules, the team store or the staff team service knows a proposal.
  for (const file of ["src/modules/teams/application/manageTeams.ts", "src/modules/teams/infrastructure/mongoTeamRepository.ts", "src/modules/teams/domain.ts", "src/modules/staffAccess/application/manageOrganizationTeams.ts",
    "src/modules/staffAccess/infrastructure/mongoStaffTeamDirectory.ts", "controller/adminOrganizationTeamsController.ts", "src/modules/organizationMembers/infrastructure/mongoTeamDirectory.ts"]) {
    const code = fs.readFileSync(path.join(__dirname, "..", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /proposalsModel|Proposal\b|proposalTemplate|organizationVendor|rfpShare|RfpShare/, file);
  }
});

test("team members: add (as a member or a manager), set and unset the manager, remove; each one event with before and after; the customer's refusals", async () => {
  const { management, audit, teamMembers } = setup();
  const row = (teamId, userId) => teamMembers.find((m) => m.teamId === teamId && m.userId === userId);
  const added = await management.addMember(staff(), ACME, T.east, { userId: ids.manager, isManager: true, reason: REASON });
  assert.deepEqual(row(T.east, ids.manager), { organizationId: ACME, teamId: T.east, userId: ids.manager, isManager: true });
  assert.deepEqual([added.team.memberCount, added.team.managers.map((m) => m.id), added.members.map((m) => [m.member.userId, m.isManager, m.version])], [1, [ids.manager], [[ids.manager, true, 1]]]);
  await management.addMember(staff(), ACME, T.east, { userId: ids.viewer, isManager: "true", reason: REASON });
  assert.equal(row(T.east, ids.viewer).isManager, false, "only `true` makes a manager, as on the customer route");
  await management.setManager(staff(), ACME, T.east, ids.manager, { isManager: false, reason: REASON });
  assert.equal(row(T.east, ids.manager).isManager, false);
  await management.setManager(staff(), ACME, T.east, ids.manager, { isManager: false, reason: REASON });
  const removed = await management.removeMember(staff(), ACME, T.east, ids.manager, { reason: REASON });
  assert.equal(row(T.east, ids.manager), undefined);
  assert.deepEqual(removed.members.map((m) => m.member.userId), [ids.viewer]);
  assert.deepEqual(audit.map((e) => [e.action, e.decision, e.reason, e.targetId, e.metadata.memberUserId, e.metadata.changed, e.metadata.before, e.metadata.after]), [
    [STAFF_TEAM_AUDIT.memberAdded, "allowed", "team_member_added", T.east, ids.manager, true, null, { userId: ids.manager, isManager: true }],
    [STAFF_TEAM_AUDIT.memberAdded, "allowed", "team_member_added", T.east, ids.viewer, true, null, { userId: ids.viewer, isManager: false }],
    [STAFF_TEAM_AUDIT.managerChanged, "allowed", "team_manager_changed", T.east, ids.manager, true, { isManager: true }, { isManager: false }],
    [STAFF_TEAM_AUDIT.managerChanged, "allowed", "team_manager_changed", T.east, ids.manager, false, { isManager: false }, { isManager: false }],
    [STAFF_TEAM_AUDIT.memberRemoved, "allowed", "team_member_removed", T.east, ids.manager, true, { userId: ids.manager, isManager: false }, null],
  ]);
  for (const event of audit) assert.deepEqual([event.organizationId, event.targetType, event.metadata.organizationId, event.metadata.staffReason], [STAFF_ORG, "team", ACME, REASON]);

  const refusals = [
    ["a manager must hold the Team Manager role (add)", STAFF_TEAM_AUDIT.memberAdded, (m) => m.addMember(staff(), ACME, T.east, { userId: ids.planner, isManager: true, reason: REASON }), 422, "TEAM_MANAGER_ROLE_REQUIRED"],
    ["an Admin is not a Team Manager", STAFF_TEAM_AUDIT.memberAdded, (m) => m.addMember(staff(), ACME, T.east, { userId: ids.admin, isManager: true, reason: REASON }), 422, "TEAM_MANAGER_ROLE_REQUIRED"],
    ["a manager must hold the Team Manager role (set)", STAFF_TEAM_AUDIT.managerChanged, (m) => m.setManager(staff(), ACME, T.west, ids.planner, { isManager: true, reason: REASON }), 422, "TEAM_MANAGER_ROLE_REQUIRED"],
    ["isManager must be a boolean", STAFF_TEAM_AUDIT.managerChanged, (m) => m.setManager(staff(), ACME, T.west, ids.manager, { isManager: "yes", reason: REASON }), 400, "INVALID_TEAM_MANAGER"],
    ["isManager is required", STAFF_TEAM_AUDIT.managerChanged, (m) => m.setManager(staff(), ACME, T.west, ids.manager, { reason: REASON }), 400, "INVALID_TEAM_MANAGER"],
    ["a suspended member can't be added", STAFF_TEAM_AUDIT.memberAdded, (m) => m.addMember(staff(), ACME, T.east, { userId: ids.suspended, reason: REASON }), 404, "MEMBER_NOT_FOUND"],
    ["a removed member can't be added", STAFF_TEAM_AUDIT.memberAdded, (m) => m.addMember(staff(), ACME, T.east, { userId: ids.removed, reason: REASON }), 404, "MEMBER_NOT_FOUND"],
    ["someone who is not a member can't be added", STAFF_TEAM_AUDIT.memberAdded, (m) => m.addMember(staff(), ACME, T.east, { userId: hex("0"), reason: REASON }), 404, "MEMBER_NOT_FOUND"],
    ["no member named", STAFF_TEAM_AUDIT.memberAdded, (m) => m.addMember(staff(), ACME, T.east, { reason: REASON }), 404, "MEMBER_NOT_FOUND"],
    ["the staff account itself can't be added", STAFF_TEAM_AUDIT.memberAdded, (m) => m.addMember(staff(), ACME, T.east, { userId: STAFF, reason: REASON }), 404, "MEMBER_NOT_FOUND"],
    ["already on the team", STAFF_TEAM_AUDIT.memberAdded, (m) => m.addMember(staff(), ACME, T.west, { userId: ids.planner, reason: REASON }), 409, "TEAM_MEMBER_EXISTS"],
    ["add to an archived team", STAFF_TEAM_AUDIT.memberAdded, (m) => m.addMember(staff(), ACME, T.old, { userId: ids.viewer, reason: REASON }), 409, "TEAM_ARCHIVED"],
    ["remove from an archived team", STAFF_TEAM_AUDIT.memberRemoved, (m) => m.removeMember(staff(), ACME, T.old, ids.planner, { reason: REASON }), 409, "TEAM_ARCHIVED"],
    ["set a manager on an archived team", STAFF_TEAM_AUDIT.managerChanged, (m) => m.setManager(staff(), ACME, T.old, ids.planner, { isManager: false, reason: REASON }), 409, "TEAM_ARCHIVED"],
    ["remove someone not on the team", STAFF_TEAM_AUDIT.memberRemoved, (m) => m.removeMember(staff(), ACME, T.west, ids.viewer, { reason: REASON }), 404, "TEAM_MEMBER_NOT_FOUND"],
    ["set a manager who is not on the team", STAFF_TEAM_AUDIT.managerChanged, (m) => m.setManager(staff(), ACME, T.east, ids.manager, { isManager: true, reason: REASON }), 404, "TEAM_MEMBER_NOT_FOUND"],
    ["a missing team", STAFF_TEAM_AUDIT.memberAdded, (m) => m.addMember(staff(), ACME, "aaaa0000000000000000dead", { userId: ids.viewer, reason: REASON }), 404, "TEAM_NOT_FOUND"],
  ];
  for (const [name, action, run, status, code] of refusals) {
    const refused = setup();
    const before = refused.world();
    await assert.rejects(run(refused.management), refusedWith(status, code), name);
    assert.equal(refused.world(), before, name);
    oneStaffEvent(refused.audit, { action, decision: "denied", reason: code.toLowerCase(), metadata: { organizationId: ACME } });
  }
});

test("set a member's teams: the active teams become exactly the list, manager flags kept on teams the member stays on; version checked and moved with the change; one event", async () => {
  const { management, audit, teamMembers, member } = setup();
  const of = (userId) => teamMembers.filter((m) => m.userId === userId).map((m) => [m.teamId, m.isManager]).sort();
  const answer = await management.setMemberTeams(staff(), ACME, ids.manager, { teamIds: [T.west, T.east, T.east], version: 1, reason: REASON });
  assert.deepEqual(of(ids.manager), [[T.west, true], [T.east, false]].sort());
  assert.deepEqual([answer.organizationId, answer.changed, answer.member.userId, answer.version, member(ACME, ids.manager).version], [ACME, true, ids.manager, 2, 2]);
  assert.deepEqual(Object.keys(answer), ["organizationId", "changed", "member", "version"]);
  oneStaffEvent(audit, { action: STAFF_TEAM_AUDIT.memberTeamsChanged, decision: "allowed", reason: "teams_changed", targetId: ids.manager, metadata: { organizationId: ACME, memberUserId: ids.manager, changed: true, before: { teamIds: [T.west] }, after: { teamIds: [T.west, T.east].sort() }, version: 2, staffReason: REASON } });
  // The archived team's membership is history: neither listed as a current team nor removed.
  const planner = setup();
  const none = await planner.management.setMemberTeams(staff(), ACME, ids.planner, { teamIds: [], version: 1, reason: REASON });
  assert.deepEqual(planner.teamMembers.filter((m) => m.userId === ids.planner).map((m) => m.teamId), [T.old]);
  assert.deepEqual([none.changed, planner.audit[0].metadata.before, planner.audit[0].metadata.after], [true, { teamIds: [T.west] }, { teamIds: [] }]);
  // The same teams again: the version still moves, as on the customer route, and the event says nothing changed.
  const same = setup();
  const unchanged = await same.management.setMemberTeams(staff(), ACME, ids.planner, { teamIds: [T.west], version: 1, reason: REASON });
  assert.deepEqual([unchanged.changed, unchanged.version, same.audit[0].metadata.changed], [false, 2, false]);
  // A deactivated member's teams can be set, as on the customer route.
  assert.equal((await setup().management.setMemberTeams(staff(), ACME, ids.suspended, { teamIds: [T.east], version: 1, reason: REASON })).changed, true);

  const refusals = [
    ["no version", { teamIds: [T.east], reason: REASON }, ids.planner, 400, "VERSION_REQUIRED", undefined],
    ["a version that is not a positive integer", { teamIds: [T.east], version: "1", reason: REASON }, ids.planner, 400, "VERSION_REQUIRED", undefined],
    ["a stale version", { teamIds: [T.east], version: 7, reason: REASON }, ids.planner, 409, "STALE_VERSION", { currentVersion: 1 }],
    ["a removed member", { teamIds: [T.east], version: 1, reason: REASON }, ids.removed, 409, "MEMBER_REMOVED", undefined],
    ["someone who is not a member", { teamIds: [T.east], version: 1, reason: REASON }, hex("0"), 404, "MEMBER_NOT_FOUND", undefined],
    ["an archived team", { teamIds: [T.east, T.old], version: 1, reason: REASON }, ids.planner, 400, "UNKNOWN_TEAMS", { unknownTeamIds: [T.old] }],
    ["a missing team", { teamIds: ["aaaa0000000000000000dead"], version: 1, reason: REASON }, ids.planner, 400, "UNKNOWN_TEAMS", { unknownTeamIds: ["aaaa0000000000000000dead"] }],
  ];
  for (const [name, body, userId, status, code, details] of refusals) {
    const refused = setup();
    const before = refused.world();
    await assert.rejects(refused.management.setMemberTeams(staff(), ACME, userId, body), (error) => { refusedWith(status, code)(error); assert.deepEqual(error.details, details, name); return true; }, name);
    assert.equal(refused.world(), before, name);
    assert.equal(refused.writes().length, 0, name);
    oneStaffEvent(refused.audit, { action: STAFF_TEAM_AUDIT.memberTeamsChanged, decision: "denied", reason: code.toLowerCase(), targetId: userId });
  }
  // The version moved, or a team was archived, between the read and the commit: nothing applied, not even the version.
  const racing = setup();
  const raced = createStaffTeamManagement({
    directory: { organization: async (id) => ({ id, kind: "customer", staffAccountCount: 0 }), member: async () => null },
    teamDirectory: { team: async () => null }, teams: {},
    members: { find: async () => ({ userId: ids.planner, roles: ["planner"], status: "active", version: 1 }) },
    memberTeams: { activeTeamIds: async (_o, teamIds) => teamIds, setMemberTeams: async () => "stale" },
    audit: { append: async (event) => { racing.audit.push(event); } },
  });
  await assert.rejects(raced.setMemberTeams(staff(), ACME, ids.planner, { teamIds: [T.east], version: 1, reason: REASON }), refusedWith(409, "STALE_VERSION"));
  oneStaffEvent(racing.audit, { decision: "denied", reason: "stale_version" });
  const archived = setup();
  archived.state.archivedAtCommit = [T.east];
  const before = archived.world();
  await assert.rejects(archived.management.setMemberTeams(staff(), ACME, ids.planner, { teamIds: [T.east], version: 1, reason: REASON }), refusedWith(400, "UNKNOWN_TEAMS"));
  assert.equal(archived.world(), before);
  const unavailable = setup();
  unavailable.state.teamsUnavailable = true;
  await assert.rejects(unavailable.management.setMemberTeams(staff(), ACME, ids.planner, { teamIds: [T.east], version: 1, reason: REASON }), refusedWith(503, "TEAMS_UNAVAILABLE"));
});

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

test("audit: an applied change's event is handed to the store to commit with the change; if it cannot be written nothing is applied and nothing is returned", async () => {
  for (const [name, action, run] of WRITES) {
    const { management, audit, state, calls, world } = setup();
    const before = world();
    state.failStoreAudit = true;
    await assert.rejects(run(management, staff()), /audit store down/, name);
    assert.equal(world(), before, `${name}: nothing applied`);
    assert.deepEqual(audit, [], name);
    const write = calls.find(([n]) => /^(teams\.(create|rename|archive|addMember|removeMember|setManager)|memberTeams\.setMemberTeams)$/.test(n))[1];
    assert.deepEqual([write.audit.organizationId, write.audit.actorUserId, write.audit.action, write.audit.targetType, write.audit.correlationId], [STAFF_ORG, STAFF, action, name === "setMemberTeams" ? "organization_membership" : "team", "corr-staff"], name);
    assert.deepEqual([write.audit.metadata.organizationId, write.audit.metadata.staffReason, write.audit.metadata.agentAccountType], [ACME, REASON, "admin"]);
    assert.equal(write.organizationId, ACME, "the change is in the customer organization, its event in the staff one");
  }
  // A refusal is returned even when its event cannot be written (nothing was changed).
  const refused = setup();
  refused.state.failAudit = true;
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    await assert.rejects(refused.management.rename(staff(), ACME, T.old, { name: "New", reason: REASON }), refusedWith(409, "TEAM_ARCHIVED"));
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /could not be recorded/);
  // A request that changed nothing still needs its event: it fails without one.
  const raced = setup();
  raced.state.archiveRace = true;
  raced.state.failAudit = true;
  await assert.rejects(raced.management.archive(staff(), ACME, T.west, { reason: REASON }), /audit store down/);
});

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const codeOf = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("audit: no code path of the staff team service writes into the customer organization, and none of the customer-side team events is written for a staff actor", async () => {
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
  // The staff instance of the team rules has no writer for member events: one would fail the request.
  const composition = read("src/modules/staffAccess/composition.ts");
  assert.match(composition, /const staffTeamRules = createTeamAdministration\(\{\s+teams: mongoTeamRepository,\s+directory: mongoOrganizationMemberDirectory,\s+audit: \{\s+append: async \(\) => \{\s+throw new Error\(/);
  assert.match(composition, /teams: staffTeamRules,/);
  assert.match(composition, /memberTeams: \{ activeTeamIds: mongoTeamDirectory\.activeTeamIds, setMemberTeams: mongoStaffMemberTeams\.setMemberTeams \},/);
  assert.doesNotMatch(composition, /teams\/composition|organizationMembers\/composition/);
  // ...and the service never asks for one: in the real service, over every staff write, the member writer is never called.
  for (const [name, , run] of WRITES) {
    const { management, audit } = setup(); // its team rules throw if a member event is written
    await run(management, staff());
    assert.equal(audit.some((event) => CUSTOMER_TEAM_ACTIONS.includes(event.action) || event.organizationId === ACME), false, name);
  }
  const rules = codeOf(read("src/modules/teams/application/manageTeams.ts"));
  // One place writes the member event, behind the staff check; every other use goes through it.
  assert.equal((rules.match(/audit\.append\(/g) ?? []).length, 1);
  assert.match(rules, /const record = async \([^)]*\) => \{\s+if \(isStaffTeamActor\(actor\)\) return;\s+await audit\.append\(\{/);
  // The directory performs no write.
  const directory = read("src/modules/staffAccess/infrastructure/mongoStaffTeamDirectory.ts");
  assert.doesNotMatch(directory, /\.(create|insertMany|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|deleteOne|deleteMany|findOneAndDelete|replaceOne|bulkWrite|save)\(/);
  assert.doesNotMatch(directory, /securityAuditEventModel|SecurityAuditEvent/);
  assert.match(directory, /Team\.findOne\(\{ organizationId: organization, _id: oid\(teamId\) \}\)\.select\("name archived archivedAt createdAt"\)/);
  assert.match(directory, /TeamMembership\.find\(\{ organizationId: organization, teamId: team\._id \}\)\.select\("userId isManager"\)/);
  assert.match(directory, /TeamMembership\.countDocuments\(\{ organizationId: organization, teamId: team\._id \}\)/);
  assert.match(directory, /members\.member\(organizationId, String\(row\.userId\)\)/);
});

test("the Mongo team store writes a staff change's audit event inside the transaction of the change; without an event every write is what it was", () => {
  const source = read("src/modules/teams/infrastructure/mongoTeamRepository.ts");
  // The event is inserted by the membership store's helper, with the transaction's session.
  assert.match(source, /import \{ appendAudit \} from "\.\.\/\.\.\/organizationMembers\/infrastructure\/mongoMembershipStore";/);
  assert.match(read("src/modules/organizationMembers/infrastructure/mongoMembershipStore.ts"), /export const appendAudit = async \(audit: MemberChangeAudit \| undefined, session: ClientSession,[\s\S]*?await SecurityAuditEvent\.create\(\[\{\s+organizationId: objectId\(audit\.organizationId\),[\s\S]*?\}\], \{ session \}\);/);
  assert.match(source, /const inTransaction = async <T>\(work: \(session: ClientSession\) => Promise<T>\): Promise<T> => \{\s+const session = await mongoose\.startSession\(\);\s+try \{\s+let result = undefined as T;\s+await session\.withTransaction\(async \(\) => \{\s+result = await work\(session\);\s+\}\);\s+return result;\s+\} finally \{\s+await session\.endSession\(\);/);
  const uses = [...source.matchAll(/await appendAudit\((audit|\{ \.\.\.audit, targetId: created\.id \}), session[,)]/g)];
  assert.equal(uses.length, 6, "create, rename, archive, addMember, removeMember, setManager");
  assert.equal((source.match(/appendAudit\(/g) ?? []).length, 6, "no use outside those six");
  // Each write: with an event, everything happens inside `inTransaction` and every query carries its session.
  const methods = ["create", "rename", "archive", "addMember", "removeMember", "setManager"];
  for (const method of methods) {
    const start = source.indexOf(`  async ${method}(`);
    const body = source.slice(start, source.indexOf("\n  },", start));
    const staffStart = body.indexOf("if (audit) {");
    assert.ok(staffStart > 0, method);
    // The staff branch ends where the member path begins: it always returns or throws.
    const memberStart = body.search(/\n    (try \{\n      (return toRecord|const team|await TeamMembership)|const result = await)/);
    assert.ok(memberStart > staffStart, method);
    const staffBranch = body.slice(staffStart, memberStart);
    const memberPath = body.slice(memberStart);
    assert.match(staffBranch, /inTransaction\(async \(session\) => \{/, method);
    assert.equal((staffBranch.match(/appendAudit\(/g) ?? []).length, 1, method);
    for (const query of staffBranch.match(/(Team|TeamMembership)\.\w+\([^\n]*/g)) assert.match(query, /\{ session \}|new: (true|false),( runValidators: true,)? session \}|\.session\(session\)/, `${method}: ${query}`);
    assert.match(staffBranch.trimEnd(), /\}$/, method);
    // The member path: no session, no transaction, no event.
    assert.doesNotMatch(memberPath, /session|inTransaction|appendAudit|audit/, method);
  }
  // The member paths, as they were on main.
  assert.match(source, /return toRecord\(\(await Team\.create\(\{ organizationId, name, createdBy \}\)\)\.toObject\(\)\);/);
  assert.match(source, /const team = await Team\.findOneAndUpdate\(\{ _id: teamId, organizationId, archived: false \}, \{ \$set: \{ name \} \}, \{ new: true, runValidators: true \}\)\s+\.lean<TeamDocument \| null>\(\);/);
  assert.match(source, /const result = await Team\.updateOne\(\{ _id: teamId, organizationId, archived: false \}, \{ \$set: \{ archived: true, archivedAt: at \} \}\);\s+return result\.modifiedCount === 1;/);
  assert.match(source, /await TeamMembership\.create\(\{ organizationId, teamId, userId, isManager \}\);\s+return "added";/);
  assert.match(source, /const result = await TeamMembership\.deleteOne\(\{ organizationId, teamId, userId \}\);\s+return result\.deletedCount === 1;/);
  assert.match(source, /const result = await TeamMembership\.updateOne\(\{ organizationId, teamId, userId \}, \{ \$set: \{ isManager \} \}\);\s+return result\.matchedCount === 1;/);

  // "Set a member's teams": the version, the rows and the event in one transaction for staff; the member write as before.
  const directory = read("src/modules/organizationMembers/infrastructure/mongoTeamDirectory.ts");
  const setTeams = directory.slice(directory.indexOf("const setTeams = async ("), directory.indexOf("export const mongoTeamDirectory"));
  assert.match(setTeams, /await session\.withTransaction\(async \(\) => \{\s+if \(staff\) \{\s+version = await bumpVersionInTransaction\(\{ organizationId, userId, expectedVersion: staff\.expectedVersion \}, session\);\s+if \(version === null\) throw new Stale\(\);\s+\}/);
  assert.match(setTeams, /if \(staff\) \{\s+await appendAudit\(staff\.audit, session, \{/);
  assert.equal((directory.match(/appendAudit\(/g) ?? []).length, 1);
  assert.ok(setTeams.indexOf("await appendAudit(") < setTeams.indexOf("} catch (error) {"), "inside the transaction");
  assert.match(directory, /async setMemberTeams\(input\) \{\s+const result = await setTeams\(input\);/, "the member write passes no version and no event");
  assert.equal((directory.match(/setTeams\(/g) ?? []).length, 2, "the member write and the staff write");
  assert.match(read("src/modules/organizationMembers/infrastructure/mongoMembershipStore.ts"), /export const bumpVersionInTransaction = async \([^)]*, session: ClientSession\): Promise<number \| null> => \{\s+const row = await updateVersioned\(input, \{ status: \{ \$ne: "removed" \} \}, \{ \$set: \{ updatedAt: new Date\(\) \} \}, session\);/);
  // The customer's member composition still uses the member write.
  assert.match(read("src/modules/organizationMembers/composition.ts"), /teams: mongoTeamDirectory,/);
  assert.doesNotMatch(read("src/modules/organizationMembers/composition.ts"), /mongoStaffMemberTeams/);
});

test("a staff add or manager change is checked again inside its transaction: a team archived, or a member deactivated or demoted, after the service's check is refused with the customer's refusal, nothing applied and no change event", async () => {
  // The service: what the store found in the transaction becomes the refusal the first check gives.
  const customerRefusals = {
    team_not_found: (c, admin) => c.customerTeams.addMember(admin, "aaaa0000000000000000dead", { userId: ids.viewer }),
    team_archived: (c, admin) => c.customerTeams.addMember(admin, T.old, { userId: ids.viewer }),
    member_not_found: (c, admin) => c.customerTeams.addMember(admin, T.east, { userId: ids.suspended }),
    manager_role_required: (c, admin) => c.customerTeams.addMember(admin, T.east, { userId: ids.viewer, isManager: true }),
  };
  const ADMIN = { organizationId: ACME, userId: ids.admin, roles: ["organization_admin"], correlationId: "corr-admin" };
  const staffWrites = [
    ["addMember", STAFF_TEAM_AUDIT.memberAdded, (m) => m.addMember(staff(), ACME, T.east, { userId: ids.manager, isManager: true, reason: REASON })],
    ["setManager", STAFF_TEAM_AUDIT.managerChanged, (m) => m.setManager(staff(), ACME, T.west, ids.manager, { isManager: true, reason: REASON })],
  ];
  for (const [outcome, byAdmin] of Object.entries(customerRefusals)) {
    let customer;
    await assert.rejects(byAdmin(setup(), ADMIN), (error) => { customer = error; return error instanceof TeamError; });
    assert.equal(customer.code, outcome === "manager_role_required" ? "TEAM_MANAGER_ROLE_REQUIRED" : outcome.toUpperCase());
    for (const [name, action, run] of staffWrites) {
      const raced = setup();
      raced.state.storeRefusal = outcome; // every check of the service passes; the store refuses in its transaction
      const before = raced.world();
      await assert.rejects(run(raced.management), (error) => {
        assert.ok(error instanceof StaffMemberError, `${name} ${outcome}`);
        assert.deepEqual([error.status, error.code, error.message], [customer.status, customer.code, customer.message], `${name} ${outcome}`);
        return true;
      });
      assert.equal(raced.world(), before, `${name} ${outcome}: nothing applied`);
      assert.equal(raced.writes().length, 1, "the store was asked once, with the event");
      oneStaffEvent(raced.audit, { action, decision: "denied", reason: customer.code.toLowerCase(), metadata: { organizationId: ACME } });
      assert.equal(raced.audit.some((event) => event.organizationId === ACME || CUSTOMER_TEAM_ACTIONS.includes(event.action)), false);
    }
  }
  // "Not on the team" is still its own refusal, and a store answer that is none of the above is not a refusal.
  const absent = setup();
  await assert.rejects(absent.management.setManager(staff(), ACME, T.east, ids.manager, { isManager: true, reason: REASON }), refusedWith(404, "TEAM_MEMBER_NOT_FOUND"));

  // The Mongo store: the check runs inside the transaction of addMember and setManager, before the write, with the session.
  const source = read("src/modules/teams/infrastructure/mongoTeamRepository.ts");
  const check = source.slice(source.indexOf("const assertStaffWrite = async ("), source.indexOf("export const mongoTeamRepository"));
  assert.match(check, /const team = await Team\.updateOne\(\{ _id: teamId, organizationId, archived: false \}, \{ \$set: \{ updatedAt: new Date\(\) \} \}, \{ session, timestamps: false \}\);\s+if \(team\.matchedCount !== 1\) \{\s+const archived = await Team\.exists\(\{ _id: teamId, organizationId \}\)\.session\(session\);\s+throw new StaffWriteAborted\(archived \? "team_archived" : "team_not_found"\);/);
  assert.match(check, /const membership = await OrganizationMembership\.findOne\(\{ organizationId, userId: member\.userId, status: "active" \}\)\s+\.select\("roles"\)\.session\(session\)\.lean<[^\n]*\(\);\s+if \(!membership\) throw new StaffWriteAborted\("member_not_found"\);\s+if \(member\.isManager && !\(membership\.roles \?\? \[\]\)\.includes\(MANAGER_ROLE\)\) throw new StaffWriteAborted\("manager_role_required"\);/);
  assert.match(source, /const MANAGER_ROLE = "team_manager";/);
  // Every query of the check carries the session and names the organization; it writes nothing but the team's own timestamp.
  for (const query of check.match(/(Team|TeamMembership|OrganizationMembership)\.\w+\([^\n]*(\n\s+\.[^\n]*)?/g)) {
    assert.match(query, /\{ session, timestamps: false \}|\.session\(session\)/, query);
    assert.match(query, /organizationId/, query);
  }
  assert.doesNotMatch(check, /\.(create|insertMany|deleteOne|deleteMany|findOneAndUpdate|findOneAndDelete|save)\(|appendAudit/);
  const branch = (method) => {
    const start = source.indexOf(`  async ${method}(`);
    const body = source.slice(start, source.indexOf("\n  },", start));
    const memberStart = body.search(/\n    (try \{\n      await TeamMembership|const result = await)/);
    return [body.slice(0, memberStart), body.slice(memberStart)];
  };
  const [addStaff, addMember] = branch("addMember");
  assert.match(addStaff, /inTransaction\(async \(session\) => \{\s+await assertStaffWrite\(\{ organizationId, teamId, member: \{ userId, isManager \} \}, session\);\s+await TeamMembership\.create\(/);
  assert.match(addStaff, /if \(error instanceof StaffWriteAborted && error\.outcome !== false\) return error\.outcome;/);
  const [setStaff, setMember] = branch("setManager");
  assert.match(setStaff, /inTransaction\(async \(session\) => \{\s+(\/\/[^\n]*\s+)?await assertStaffWrite\(\{ organizationId, teamId, \.\.\.\(isManager \? \{ member: \{ userId, isManager \} \} : \{\}\) \}, session\);\s+const previous = await TeamMembership\.findOneAndUpdate\(/);
  // Not on the team: aborted too, so the team's timestamp written by the check is rolled back.
  assert.match(setStaff, /if \(!previous\) throw new StaffWriteAborted\(false\);/);
  assert.match(setStaff, /if \(error instanceof StaffWriteAborted\) return error\.outcome;/);
  // A refusal aborts: it is thrown out of the transaction, never returned from inside it.
  for (const staffBranch of [addStaff, setStaff]) assert.ok(staffBranch.indexOf("assertStaffWrite(") < staffBranch.indexOf("appendAudit("));
  assert.equal((check.match(/return [^;]/g) ?? []).length, 0, "the check throws or passes");
  // The member paths never run it.
  for (const memberPath of [addMember, setMember]) assert.doesNotMatch(memberPath, /assertStaffWrite|StaffWriteAborted|OrganizationMembership|session/);
  assert.equal((source.match(/assertStaffWrite\(/g) ?? []).length, 3, "its definition and the two staff branches");
});

// ── The customer path ────────────────────────────────────────────────────────────────────────

const fakeResponse = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test("the customer path cannot reach the staff branch: only `staffTeamActor` makes a staff actor, only the staff service calls it, and nothing a request carries is one", async () => {
  const real = staffTeamActor({ organizationId: ACME, committed: () => ({}), unchanged: async () => {} });
  assert.equal(isStaffTeamActor(real), true);
  assert.equal(Object.isFrozen(real), true);
  assert.deepEqual(Object.keys(real), ["staff", "organizationId", "committed", "unchanged"]);
  // Things that look like one are not: a copy, a member actor carrying `staff: true`, JSON, a prototype.
  const forged = [
    { ...real }, JSON.parse(JSON.stringify({ staff: true, organizationId: ACME })), Object.create(real),
    { staff: true, organizationId: ACME, userId: ids.viewer, roles: ["viewer"], correlationId: "c", committed: () => ({}), unchanged: async () => {} },
    { staff: true, organizationId: ACME, userId: ids.viewer, roles: [], correlationId: "c" }, { staff: "true", organizationId: ACME, roles: [] }, null, undefined, "staff", true,
  ];
  for (const actor of forged) assert.equal(isStaffTeamActor(actor), false, JSON.stringify(actor));
  // The team service treats each as the member it is (or fails): no role, no change.
  const viewer = { organizationId: ACME, userId: ids.viewer, roles: ["viewer"], correlationId: "c" };
  const attempts = [
    (s, a) => s.create(a, { name: "X" }), (s, a) => s.rename(a, T.west, { name: "X" }), (s, a) => s.archive(a, T.west), (s, a) => s.get(a, T.west),
    (s, a) => s.addMember(a, T.east, { userId: ids.viewer }), (s, a) => s.removeMember(a, T.west, ids.planner), (s, a) => s.setManager(a, T.west, ids.manager, { isManager: false }),
  ];
  for (const extra of [{ staff: true }, { staff: true, committed: () => ({}), unchanged: async () => {} }, { staff: { organizationId: ACME } }, { ...real }]) {
    for (const run of attempts) {
      const { customerTeams, world, audit, writes } = setup();
      const before = world();
      await assert.rejects(run(customerTeams, { ...viewer, ...extra }), (error) => error instanceof TeamError && error.code === "TEAM_ADMIN_REQUIRED" && error.status === 403);
      assert.deepEqual([world(), audit, writes()], [before, [], []]);
    }
  }
  // The customer controller builds its actor field by field from the session: nothing else of the request reaches the service.
  const seen = [];
  const controller = createTeamsController(new Proxy({}, { get: () => async (actor) => { seen.push(actor); return {}; } }));
  const request = { user: { userId: ids.viewer, organizationId: ACME, roles: ["viewer"], staff: true, committed: () => ({}), unchanged: async () => {} }, params: { teamId: T.west, userId: ids.planner }, body: { staff: true, name: "X", userId: ids.viewer, isManager: false, actor: real }, query: { staff: "true" }, correlationId: "c", staff: true };
  for (const handler of ["list", "get", "create", "rename", "archive", "addMember", "removeMember", "setManager"]) await controller[handler](request, fakeResponse());
  assert.equal(seen.length, 8);
  for (const actor of seen) {
    assert.deepEqual(Object.keys(actor).sort(), ["correlationId", "organizationId", "roles", "userId"]);
    assert.equal(isStaffTeamActor(actor), false);
  }
  // Who can make one: the staff team service, and nothing else in the application.
  const users = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(__dirname, "..", dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(file); continue; }
      if (/\.ts$/.test(entry.name) && /\bstaffTeamActor\b/.test(codeOf(read(file)))) users.push(file);
    }
  };
  for (const root of ["src", "controller", "routes", "middleware", "utils", "scripts"]) walk(root);
  assert.deepEqual(users.sort(), ["src/modules/staffAccess/application/manageOrganizationTeams.ts", "src/modules/teams/domain.ts"]);
  assert.match(read("src/modules/teams/domain.ts"), /const staffTeamActors = new WeakSet<object>\(\);/);
  assert.doesNotMatch(read("src/modules/teams/domain.ts"), /export const staffTeamActors/);
  // The staff service makes it only after the staff check, the validation and the organization check.
  const service = read("src/modules/staffAccess/application/manageOrganizationTeams.ts");
  assert.equal((service.match(/staffTeamActor\(/g) ?? []).length, 1);
  assert.match(service, /validate\(current, input, ids\);\s+check\?\.\(current\);\s+const organization = await organizationOf\(current\);\s+const team = await run\(actorOf\(current, organization, kind\), current\);/);
  assert.match(service, /\): Promise<T> => \{\s+assertStaff\(staff\);/);
  // The customer's members service has no staff path at all.
  assert.doesNotMatch(read("src/modules/organizationMembers/application/manageMembers.ts"), /staff/i);
  assert.doesNotMatch(read("controller/teamsController.ts"), /staff/i);
  assert.doesNotMatch(read("routes/teamsRoute.ts"), /staff/i);
});

test("every customer decision is unchanged: the organization's Admin gets the same outcome and refusal as before, with the member events, no transaction event and the Admin stored as creator", async () => {
  const ADMIN = { organizationId: ACME, userId: ids.admin, roles: ["organization_admin"], correlationId: "corr-admin" };
  // The same scenario by the Admin (customer service) and by staff (staff service): same world afterwards.
  const scenario = [
    ["create", (c) => c.customerTeams.create(ADMIN, { name: "South" }), (c) => c.management.create(staff(), ACME, { name: "South", reason: REASON }), "team.created", "created", { name: "South" }],
    ["rename", (c) => c.customerTeams.rename(ADMIN, T.west, { name: "West Coast" }), (c) => c.management.rename(staff(), ACME, T.west, { name: "West Coast", reason: REASON }), "team.renamed", "allowed", { name: "West Coast", previousName: "West" }],
    ["addMember", (c) => c.customerTeams.addMember(ADMIN, T.east, { userId: ids.manager, isManager: true }), (c) => c.management.addMember(staff(), ACME, T.east, { userId: ids.manager, isManager: true, reason: REASON }), "team.member_added", "created", { userId: ids.manager, isManager: true }],
    ["setManager", (c) => c.customerTeams.setManager(ADMIN, T.west, ids.manager, { isManager: false }), (c) => c.management.setManager(staff(), ACME, T.west, ids.manager, { isManager: false, reason: REASON }), "team.manager_changed", "revoked", { userId: ids.manager, isManager: false }],
    ["removeMember", (c) => c.customerTeams.removeMember(ADMIN, T.west, ids.planner), (c) => c.management.removeMember(staff(), ACME, T.west, ids.planner, { reason: REASON }), "team.member_removed", "revoked", { userId: ids.planner }],
    ["archive", (c) => c.customerTeams.archive(ADMIN, T.west), (c) => c.management.archive(staff(), ACME, T.west, { reason: REASON }), "team.archived", "revoked", {}],
    ["setMemberTeams", (c) => c.customerMembers.changeTeams(ADMIN, { userId: ids.planner, teamIds: [T.east], version: 1 }), (c) => c.management.setMemberTeams(staff(), ACME, ids.planner, { teamIds: [T.east], version: 1, reason: REASON }), "organization.member.teams_changed", "allowed", { previousTeamIds: [T.west], teamIds: [T.east], version: 2 }],
  ];
  for (const [name, byAdmin, byStaff, action, decision, metadata] of scenario) {
    const customer = setup();
    await byAdmin(customer);
    const staffed = setup();
    await byStaff(staffed);
    // The only difference in the data: who created a team.
    assert.equal(customer.world().replaceAll(`"createdBy":"${ids.admin}"`, `"createdBy":null`), staffed.world(), name);
    if (name === "create") assert.equal(customer.teamRows.at(-1).createdBy, ids.admin);
    // The Admin's event, in the customer organization, exactly as on main; no staff-side event.
    assert.equal(customer.audit.length, 1, name);
    const [event] = customer.audit;
    assert.deepEqual([event.organizationId, event.actorUserId, event.action, event.decision, event.correlationId, event.metadata], [ACME, ids.admin, action, decision, "corr-admin", metadata], name);
    assert.deepEqual([event.targetType, event.reason], name === "setMemberTeams" ? ["organization_membership", "teams_changed"] : ["team", action], name);
    // The store was given no event and no `audit` key at all: the member write is the one of main.
    for (const [write, input] of customer.writes()) assert.equal("audit" in input, false, `${name}: ${write}`);
    assert.equal(customer.writes().some(([write]) => write === "memberTeams.setMemberTeams"), false, "the staff write of a member's teams is never used by the customer");
    if (name === "setMemberTeams") assert.deepEqual(customer.calls.filter(([n]) => /bumpVersion|setMemberTeams/.test(n)).map(([n]) => n), ["members.bumpVersion", "memberTeams.setMemberTeams(member)"]);
    // Staff: no member event, one staff-side one.
    assert.equal(staffed.audit.some((e) => e.action === action || e.organizationId === ACME), false, name);
  }
  // Every refusal the customer gets, staff get with the same status, code and message.
  const refusals = [
    [(c) => c.customerTeams.create(ADMIN, { name: "west" }), (c) => c.management.create(staff(), ACME, { name: "west", reason: REASON })],
    [(c) => c.customerTeams.create(ADMIN, { name: " " }), (c) => c.management.create(staff(), ACME, { name: " ", reason: REASON })],
    [(c) => c.customerTeams.rename(ADMIN, T.old, { name: "X" }), (c) => c.management.rename(staff(), ACME, T.old, { name: "X", reason: REASON })],
    [(c) => c.customerTeams.rename(ADMIN, T.north, { name: "X" }), (c) => c.management.rename(staff(), ACME, T.north, { name: "X", reason: REASON })],
    [(c) => c.customerTeams.archive(ADMIN, T.old), (c) => c.management.archive(staff(), ACME, T.old, { reason: REASON })],
    [(c) => c.customerTeams.addMember(ADMIN, T.east, { userId: ids.planner, isManager: true }), (c) => c.management.addMember(staff(), ACME, T.east, { userId: ids.planner, isManager: true, reason: REASON })],
    [(c) => c.customerTeams.addMember(ADMIN, T.east, { userId: FOREIGN }), (c) => c.management.addMember(staff(), ACME, T.east, { userId: FOREIGN, reason: REASON })],
    [(c) => c.customerTeams.addMember(ADMIN, T.east, { userId: "not-an-id" }), (c) => c.management.addMember(staff(), ACME, T.east, { userId: "not-an-id", reason: REASON })],
    [(c) => c.customerTeams.addMember(ADMIN, T.west, { userId: ids.planner }), (c) => c.management.addMember(staff(), ACME, T.west, { userId: ids.planner, reason: REASON })],
    [(c) => c.customerTeams.removeMember(ADMIN, T.west, ids.viewer), (c) => c.management.removeMember(staff(), ACME, T.west, ids.viewer, { reason: REASON })],
    [(c) => c.customerTeams.setManager(ADMIN, T.west, ids.planner, { isManager: true }), (c) => c.management.setManager(staff(), ACME, T.west, ids.planner, { isManager: true, reason: REASON })],
    [(c) => c.customerTeams.setManager(ADMIN, T.west, ids.manager, { isManager: 1 }), (c) => c.management.setManager(staff(), ACME, T.west, ids.manager, { isManager: 1, reason: REASON })],
    [(c) => c.customerTeams.setManager(ADMIN, T.east, ids.manager, { isManager: false }), (c) => c.management.setManager(staff(), ACME, T.east, ids.manager, { isManager: false, reason: REASON })],
  ];
  for (const [byAdmin, byStaff] of refusals) {
    let customer;
    await assert.rejects(byAdmin(setup()), (error) => { customer = error; return error instanceof TeamError; });
    await assert.rejects(byStaff(setup()), (error) => {
      assert.deepEqual([error.status, error.code, error.message], [customer.status, customer.code, customer.message]);
      return error instanceof StaffMemberError;
    });
  }
  const memberRefusals = [
    { teamIds: "x", version: 1 }, { teamIds: [T.east] }, { teamIds: [T.east], version: 9 }, { teamIds: [T.old], version: 1 }, { teamIds: [T.north, T.east], version: 1 },
  ];
  for (const body of memberRefusals) {
    const customer = await setup().customerMembers.changeTeams(ADMIN, { userId: ids.planner, ...body });
    assert.equal(customer.ok, false);
    await assert.rejects(setup().management.setMemberTeams(staff(), ACME, ids.planner, { ...body, reason: REASON }), (error) => {
      assert.deepEqual([error.status, error.code, error.message, error.details], [customer.status, customer.code, customer.message, customer.details]);
      return true;
    });
  }
  for (const [userId, code] of [[ids.removed, "MEMBER_REMOVED"], [FOREIGN, "MEMBER_NOT_FOUND"]]) {
    const customer = await setup().customerMembers.changeTeams(ADMIN, { userId, teamIds: [T.east], version: 1 });
    assert.equal(customer.code, code);
    await assert.rejects(setup().management.setMemberTeams(staff(), ACME, userId, { teamIds: [T.east], version: 1, reason: REASON }), (error) => error.code === code && error.status === customer.status && error.message === customer.message);
  }
  // The shared selection rule is the one the customer route had inline.
  assert.deepEqual(policy.parseTeamSelection([T.east, T.east.toUpperCase(), T.east]), { ok: true, teamIds: [T.east, T.east.toUpperCase()] });
  assert.deepEqual(policy.parseTeamSelection([]), { ok: true, teamIds: [] });
  assert.deepEqual(policy.parseTeamSelection("x"), { ok: false, status: 400, code: "INVALID_TEAMS", message: "teamIds must be a list of up to 100 team ids." });
  assert.deepEqual(policy.unknownTeams(["a"]), { ok: false, status: 400, code: "UNKNOWN_TEAMS", message: "Some teams aren't active teams of this organization.", details: { unknownTeamIds: ["a"] } });
  assert.deepEqual(policy.teamsUnavailable(), { ok: false, status: 503, code: "TEAMS_UNAVAILABLE", message: "Teams aren't available yet." });
  assert.deepEqual(policy.decideTeamsChange({ target: { userId: "u", roles: [], status: "suspended" } }), { ok: true });
  assert.deepEqual(policy.decideTeamsChange({ target: { userId: "u", roles: [], status: "removed" } }), { ok: false, status: 409, code: "MEMBER_REMOVED", message: "This member has been removed." });
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
  assert.equal((source.match(/staffMemberView\(/g) ?? []).length, 2, "a team's members, and the member whose teams were set");
  assert.equal((source.match(/\.\.\.teamDetailView\(found\)/g) ?? []).length, 2, "the read and the write answers");
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
    if (name === "setMemberTeams") {
      assert.deepEqual(Object.keys(answer), ["organizationId", "changed", "member", "version"]);
      memberShaped(answer.member, name);
      continue;
    }
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
  params: { organizationId: ACME, teamId: T.west, userId: ids.planner }, query: {}, body: { reason: REASON }, correlationId: "corr-staff", ...overrides,
});

test("controller: the organization, team and member come from the path only; 201 where the customer route answers 201; refusals carry code, message and details; an unexpected error is a plain 500", async () => {
  const { management, audit, world, team, calls, teamMembers } = setup();
  const controller = createAdminOrganizationTeamsController(management);
  // A body or query that names another organization, team or member is ignored.
  const res = fakeResponse();
  await controller.removeMember(request({ body: { reason: REASON, organizationId: OTHER, teamId: T.north, userId: FOREIGN }, query: { organizationId: OTHER, teamId: T.north, userId: FOREIGN, reason: "a reason in the query string" } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual([res.body.success, res.body.data.organizationId, res.body.data.team.id, res.body.data.members.map((m) => m.member.userId)], [true, ACME, T.west, [ids.manager]]);
  assert.equal(teamMembers.some((m) => m.teamId === T.north && m.userId === FOREIGN), true);
  assert.equal(calls.some((call) => JSON.stringify(call).includes(OTHER) || JSON.stringify(call).includes(T.north)), false);
  assert.equal(audit.length, 1);
  // The reason is read from the body only: one in the query string is not a reason.
  const noBody = fakeResponse();
  await controller.removeMember(request({ body: undefined, query: { reason: REASON } }), noBody);
  assert.deepEqual([noBody.statusCode, noBody.body.code], [400, "INVALID_REASON"]);

  const statuses = [
    ["create", request({ body: { name: "South", reason: REASON } }), 201],
    ["addMember", request({ params: { organizationId: ACME, teamId: T.east }, body: { userId: ids.viewer, reason: REASON } }), 201],
    ["rename", request({ body: { name: "Renamed", reason: REASON } }), 200],
    ["setManager", request({ params: { organizationId: ACME, teamId: T.west, userId: ids.manager }, body: { isManager: false, reason: REASON } }), 200],
    ["setMemberTeams", request({ params: { organizationId: ACME, userId: ids.viewer }, body: { teamIds: [T.west], version: 1, reason: REASON, userId: FOREIGN } }), 200],
    ["team", request({ body: undefined }), 200],
    ["archive", request(), 200],
  ];
  for (const [handler, req, status] of statuses) {
    const response = fakeResponse();
    await controller[handler](req, response);
    assert.deepEqual([response.statusCode, response.body.success, response.body.data.organizationId], [status, true, ACME], `${handler}: ${JSON.stringify(response.body)}`);
  }
  assert.equal(team(ACME, T.west).archived, true);
  assert.equal(JSON.parse(world()).teamRows.filter((t) => t.organizationId === OTHER).length, 1);

  const cases = [
    ["create", request({ body: { name: "west", reason: REASON } }), 409, "TEAM_NAME_TAKEN"],
    ["rename", request({ params: { organizationId: ACME, teamId: T.old }, body: { name: "X", reason: REASON } }), 409, "TEAM_ARCHIVED"],
    ["rename", request({ params: { organizationId: ACME, teamId: T.north }, body: { name: "X", reason: REASON } }), 404, "TEAM_NOT_FOUND"],
    ["archive", request({ body: {} }), 400, "INVALID_REASON"],
    ["addMember", request({ params: { organizationId: ACME, teamId: T.east }, body: { userId: ids.planner, isManager: true, reason: REASON } }), 422, "TEAM_MANAGER_ROLE_REQUIRED"],
    ["setMemberTeams", request({ body: { teamIds: [T.north], version: 1, reason: REASON } }), 400, "UNKNOWN_TEAMS"],
    ["setMemberTeams", request({ body: { teamIds: [T.east], version: 9, reason: REASON } }), 409, "STALE_VERSION"],
    ["team", request({ params: { organizationId: HOLDING, teamId: T.west } }), 409, "ORGANIZATION_NOT_MANAGEABLE"],
    ["team", request({ params: { organizationId: ACME, teamId: "x" } }), 400, "INVALID_TEAM_ID"],
    ["team", request({ user: { userId: ids.owner, organizationId: ACME, role: "customer", accountType: "planner", roles: ["owner"] } }), 403, "STAFF_ACCESS_FORBIDDEN"],
    ["team", request({ user: undefined }), 401, "AUTHENTICATION_REQUIRED"],
    ["archive", request({ body: "not an object" }), 400, "INVALID_REASON"],
    ["archive", request({ body: [{ reason: REASON }] }), 400, "INVALID_REASON"],
  ];
  for (const [handler, req, status, code] of cases) {
    const response = fakeResponse();
    await createAdminOrganizationTeamsController(setup().management)[handler](req, response);
    assert.deepEqual([response.statusCode, response.body.success, response.body.code], [status, false, code], `${handler} ${code}`);
    assert.equal(typeof response.body.message, "string");
    assert.equal("data" in response.body, false);
    if (code === "UNKNOWN_TEAMS") assert.deepEqual(response.body.unknownTeamIds, [T.north]);
    if (code === "STALE_VERSION") assert.equal(response.body.currentVersion, 1);
    if (code === "INVALID_REASON") assert.deepEqual(response.body.fields, { reason: "Give a reason of 10 to 500 characters." });
  }

  const broken = createAdminOrganizationTeamsController({ archive: async () => { throw new Error("mongo exploded: secret detail"); } });
  const failed = fakeResponse();
  const original = console.error;
  console.error = () => {};
  try { await broken.archive(request(), failed); } finally { console.error = original; }
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

test("routes: every route sits behind authenticate, the staff role guard and a per-staff limit; every write carries the staff write limit; teams and a member's teams only", () => {
  const router = require("../routes/adminOrganizationTeamsRoute").default;
  const { staffMemberWrites } = require("../routes/adminOrganizationMembersRoute");
  const { staffContentReads } = require("../routes/adminOrganizationContentRoute");
  const { authenticate } = require("../middleware/auth");
  const { adminOrganizationTeamsController: controller } = require("../controller/adminOrganizationTeamsController");
  const routes = router.stack.filter((layer) => layer.route).map((layer) => layer.route);
  const describe = (route) => `${Object.keys(route.methods).join(",").toUpperCase()} ${route.path}`;
  assert.deepEqual(routes.map(describe), [
    "POST /admin/organizations/:organizationId/teams",
    "GET /admin/organizations/:organizationId/teams/:teamId",
    "PATCH /admin/organizations/:organizationId/teams/:teamId",
    "POST /admin/organizations/:organizationId/teams/:teamId/archive",
    "POST /admin/organizations/:organizationId/teams/:teamId/members",
    "PATCH /admin/organizations/:organizationId/teams/:teamId/members/:userId",
    "DELETE /admin/organizations/:organizationId/teams/:teamId/members/:userId",
    "PUT /admin/organizations/:organizationId/members/:userId/teams",
  ]);
  assert.equal(router.stack.every((layer) => layer.route), true, "no router-level middleware that could skip the guard");
  const handlers = [controller.create, controller.team, controller.rename, controller.archive, controller.addMember, controller.setManager, controller.removeMember, controller.setMemberTeams];
  routes.forEach((route, index) => {
    assert.equal(route.stack.length, 4, route.path);
    assert.equal(route.stack[0].handle, authenticate, route.path);
    guardRefusesCustomers(route.stack[1].handle, route.path);
    const isWrite = !route.methods.get;
    assert.equal(route.stack[2].handle, isWrite ? staffMemberWrites : staffContentReads, route.path);
    assert.equal(route.stack[3].handle, handlers[index], route.path);
  });
  assert.equal(routes.filter((route) => !route.methods.get).length, 7);

  const source = read("routes/adminOrganizationTeamsRoute.ts");
  // The write limit is the staff member routes' own (60 per 15 minutes per staff account): one budget, not a second one.
  assert.match(source, /import \{ staffMemberWrites \} from "\.\/adminOrganizationMembersRoute";/);
  assert.doesNotMatch(source, /securityRateLimit\(/);
  assert.match(source, /const staff = \[authenticate, authorize\("admin", "super_admin", "superadmin"\)\];\nconst write = \[\.\.\.staff, staffMemberWrites\];/);
  // This file holds team routes and "a member's teams" only: nothing on a proposal (not even its team), templates, vendors or invitations.
  const lines = source.split("\n").filter((line) => /^router\./.test(line));
  assert.equal(lines.length, 8);
  for (const line of lines) {
    assert.match(line, /^router\.(get|patch|post|delete|put)\("\/admin\/organizations\/:organizationId\/(teams(\/:teamId(\/(archive|members(\/:userId)?))?)?|members\/:userId\/teams)", \.\.\.(write|staff), /, line);
    assert.doesNotMatch(line, /proposals|rfps|templates|vendors|invitations|two-factor|block|role|deactivate|ownership/, line);
  }
  assert.doesNotMatch(source, /router\.(all|use)\(/);
  assert.equal(lines.filter((line) => /^router\.(delete|put)\(/.test(line)).length, 2, "one delete (a team member) and one put (a member's teams)");
  for (const file of ["routes/adminOrganizationTeamsRoute.ts", "controller/adminOrganizationTeamsController.ts", "src/modules/staffAccess/application/manageOrganizationTeams.ts", "src/modules/staffAccess/infrastructure/mongoStaffTeamDirectory.ts"]) {
    assert.doesNotMatch(read(file), /proposalTemplate|ProposalTemplate|organizationVendor|OrganizationVendor|proposalsModel|invitationModel|Invitation\b|teamId: .*Proposal/, file);
  }
  assert.match(read("server.ts"), /app\.use\("\/api\/v1", adminOrganizationTeamsRoutes\);/);
  // Linted, as CLAUDE.md asks of a new top-level controller and route.
  for (const file of ["controller/adminOrganizationTeamsController.ts", "routes/adminOrganizationTeamsRoute.ts"]) {
    assert.ok(JSON.parse(read("package.json")).scripts.lint.split(" ").includes(file), file);
    assert.ok(read("eslint.config.mjs").includes(`"${file}"`), file);
  }
});
