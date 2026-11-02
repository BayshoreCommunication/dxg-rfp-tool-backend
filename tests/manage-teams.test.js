require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTeamAdministration } = require("../src/modules/teams/application/manageTeams");
const { TeamError } = require("../src/modules/teams/domain");

const ORG = "a".repeat(24);
const ADMIN = { organizationId: ORG, userId: "b".repeat(24), roles: ["organization_admin"], correlationId: "c1" };
const OWNER = { ...ADMIN, roles: ["owner"] };
const MANAGER_ID = "d".repeat(24);
const PLANNER_ID = "e".repeat(24);
const OUTSIDER_ID = "f".repeat(24);

// In-memory repository with the same contract as the Mongo one, including case-insensitive
// active-name uniqueness.
const fakeTeams = () => {
  const teams = [];
  const members = [];
  let next = 1;
  const nameTaken = (organizationId, name, exceptId) =>
    teams.some((t) => t.organizationId === organizationId && !t.archived && t.id !== exceptId && t.name.toLowerCase() === name.toLowerCase());
  const view = ({ organizationId, ...team }) => ({ ...team });
  return {
    teams,
    members,
    async list(organizationId) { return teams.filter((t) => t.organizationId === organizationId).map(view); },
    async findById(organizationId, teamId) { const t = teams.find((x) => x.id === teamId && x.organizationId === organizationId); return t ? view(t) : null; },
    async create({ organizationId, name }) {
      if (nameTaken(organizationId, name)) return "duplicate";
      const team = { id: String(next++).padStart(24, "0"), organizationId, name, archived: false, archivedAt: null, createdAt: new Date() };
      teams.push(team);
      return view(team);
    },
    async rename({ organizationId, teamId, name }) {
      const t = teams.find((x) => x.id === teamId && x.organizationId === organizationId && !x.archived);
      if (!t) return null;
      if (nameTaken(organizationId, name, teamId)) return "duplicate";
      t.name = name;
      return view(t);
    },
    async archive({ organizationId, teamId, at }) {
      const t = teams.find((x) => x.id === teamId && x.organizationId === organizationId && !x.archived);
      if (!t) return false;
      Object.assign(t, { archived: true, archivedAt: at });
      return true;
    },
    async members(organizationId, teamIds) { return members.filter((m) => m.organizationId === organizationId && teamIds.includes(m.teamId)).map(({ organizationId: _o, ...m }) => m); },
    async addMember({ organizationId, teamId, userId, isManager }) {
      if (members.some((m) => m.teamId === teamId && m.userId === userId)) return "exists";
      members.push({ organizationId, teamId, userId, isManager });
      return "added";
    },
    async removeMember({ organizationId, teamId, userId }) {
      const index = members.findIndex((m) => m.organizationId === organizationId && m.teamId === teamId && m.userId === userId);
      if (index < 0) return false;
      members.splice(index, 1);
      return true;
    },
    async setManager({ organizationId, teamId, userId, isManager }) {
      const m = members.find((x) => x.organizationId === organizationId && x.teamId === teamId && x.userId === userId);
      if (!m) return false;
      m.isManager = isManager;
      return true;
    },
  };
};

const setup = () => {
  const teams = fakeTeams();
  const audit = [];
  const directory = {
    async find(organizationId, userId) {
      if (organizationId !== ORG) return null;
      return { [MANAGER_ID]: { roles: ["team_manager"], status: "active" }, [PLANNER_ID]: { roles: ["planner"], status: "active" } }[userId] ?? null;
    },
  };
  const service = createTeamAdministration({
    teams,
    directory,
    audit: { append: async (event) => { audit.push(event); } },
    isValidId: (value) => /^[0-9a-f]{24}$/.test(value),
    now: () => new Date("2026-11-02T00:00:00Z"),
  });
  return { service, teams, audit };
};

const rejects = (promise, code, status) =>
  assert.rejects(promise, (error) => error instanceof TeamError && error.code === code && error.status === status);

test("only Owners and Admins manage teams", async () => {
  const { service } = setup();
  const { id } = await service.create(OWNER, { name: "Events" });
  for (const roles of [["team_manager"], ["planner"], ["viewer"]]) {
    const actor = { ...ADMIN, roles };
    await rejects(service.create(actor, { name: "X" }), "TEAM_ADMIN_REQUIRED", 403);
    await rejects(service.rename(actor, id, { name: "X" }), "TEAM_ADMIN_REQUIRED", 403);
    await rejects(service.archive(actor, id), "TEAM_ADMIN_REQUIRED", 403);
    await rejects(service.addMember(actor, id, { userId: PLANNER_ID }), "TEAM_ADMIN_REQUIRED", 403);
    await rejects(service.removeMember(actor, id, PLANNER_ID), "TEAM_ADMIN_REQUIRED", 403);
    await rejects(service.setManager(actor, id, MANAGER_ID, { isManager: true }), "TEAM_ADMIN_REQUIRED", 403);
    await rejects(service.get(actor, id), "TEAM_ADMIN_REQUIRED", 403);
  }
});

test("create, rename and archive are audited; active names are unique ignoring case", async () => {
  const { service, audit } = setup();
  const team = await service.create(ADMIN, { name: "  Corporate Events " });
  assert.equal(team.name, "Corporate Events");
  await rejects(service.create(ADMIN, { name: "corporate events" }), "TEAM_NAME_TAKEN", 409);
  await rejects(service.create(ADMIN, { name: "   " }), "INVALID_TEAM_NAME", 400);
  await rejects(service.create(ADMIN, { name: "x".repeat(121) }), "INVALID_TEAM_NAME", 400);
  const renamed = await service.rename(ADMIN, team.id, { name: "Galas" });
  assert.equal(renamed.name, "Galas");
  const archived = await service.archive(ADMIN, team.id);
  assert.equal(archived.archived, true);
  // The archived name is free again.
  await service.create(ADMIN, { name: "Galas" });
  assert.deepEqual(audit.map((e) => [e.action, e.decision]), [
    ["team.created", "created"],
    ["team.renamed", "allowed"],
    ["team.archived", "revoked"],
    ["team.created", "created"],
  ]);
  assert.deepEqual(audit[1].metadata, { name: "Galas", previousName: "Corporate Events" });
  assert.ok(audit.every((e) => e.organizationId === ORG && e.actorUserId === ADMIN.userId && e.targetType === "team" && e.correlationId === "c1"));
});

test("archived teams can't be renamed, re-archived or have their members changed", async () => {
  const { service } = setup();
  const { id } = await service.create(ADMIN, { name: "Old" });
  await service.addMember(ADMIN, id, { userId: PLANNER_ID });
  await service.archive(ADMIN, id);
  await rejects(service.rename(ADMIN, id, { name: "New" }), "TEAM_ARCHIVED", 409);
  await rejects(service.archive(ADMIN, id), "TEAM_ARCHIVED", 409);
  await rejects(service.addMember(ADMIN, id, { userId: MANAGER_ID }), "TEAM_ARCHIVED", 409);
  await rejects(service.removeMember(ADMIN, id, PLANNER_ID), "TEAM_ARCHIVED", 409);
  // Memberships are kept for the record.
  assert.equal((await service.get(ADMIN, id)).members.length, 1);
});

test("members: add, set manager, remove; each audited", async () => {
  const { service, audit } = setup();
  const { id } = await service.create(ADMIN, { name: "Sales" });
  await service.addMember(ADMIN, id, { userId: PLANNER_ID });
  await service.addMember(ADMIN, id, { userId: MANAGER_ID, isManager: true });
  await rejects(service.addMember(ADMIN, id, { userId: PLANNER_ID }), "TEAM_MEMBER_EXISTS", 409);
  await service.setManager(ADMIN, id, MANAGER_ID, { isManager: false });
  const afterRemove = await service.removeMember(ADMIN, id, PLANNER_ID);
  assert.deepEqual(afterRemove.members, [{ userId: MANAGER_ID, isManager: false }]);
  await rejects(service.removeMember(ADMIN, id, PLANNER_ID), "TEAM_MEMBER_NOT_FOUND", 404);
  assert.deepEqual(audit.slice(1).map((e) => [e.action, e.decision, e.metadata]), [
    ["team.member_added", "created", { userId: PLANNER_ID, isManager: false }],
    ["team.member_added", "created", { userId: MANAGER_ID, isManager: true }],
    ["team.manager_changed", "revoked", { userId: MANAGER_ID, isManager: false }],
    ["team.member_removed", "revoked", { userId: PLANNER_ID }],
  ]);
});

test("a manager must hold the Team Manager role; members must be active in the organization", async () => {
  const { service } = setup();
  const { id } = await service.create(ADMIN, { name: "Ops" });
  await rejects(service.addMember(ADMIN, id, { userId: PLANNER_ID, isManager: true }), "TEAM_MANAGER_ROLE_REQUIRED", 422);
  await service.addMember(ADMIN, id, { userId: PLANNER_ID });
  await rejects(service.setManager(ADMIN, id, PLANNER_ID, { isManager: true }), "TEAM_MANAGER_ROLE_REQUIRED", 422);
  await rejects(service.setManager(ADMIN, id, PLANNER_ID, { isManager: "yes" }), "INVALID_TEAM_MANAGER", 400);
  await rejects(service.addMember(ADMIN, id, { userId: OUTSIDER_ID }), "MEMBER_NOT_FOUND", 404);
  await rejects(service.addMember(ADMIN, id, { userId: "not-an-id" }), "MEMBER_NOT_FOUND", 404);
});

test("teams of another organization are not found", async () => {
  const { service } = setup();
  const { id } = await service.create(ADMIN, { name: "Mine" });
  const foreign = { ...ADMIN, organizationId: "9".repeat(24) };
  await rejects(service.get(foreign, id), "TEAM_NOT_FOUND", 404);
  await rejects(service.rename(foreign, id, { name: "Theirs" }), "TEAM_NOT_FOUND", 404);
  await rejects(service.archive(foreign, id), "TEAM_NOT_FOUND", 404);
  await rejects(service.get(ADMIN, "not-an-id"), "TEAM_NOT_FOUND", 404);
  assert.deepEqual(await service.list(foreign), []);
});

test("Admins list every team with members; other members see active team names only", async () => {
  const { service } = setup();
  const kept = await service.create(ADMIN, { name: "Kept" });
  const gone = await service.create(ADMIN, { name: "Gone" });
  await service.addMember(ADMIN, kept.id, { userId: PLANNER_ID });
  await service.archive(ADMIN, gone.id);
  const full = await service.list(ADMIN);
  assert.equal(full.length, 2);
  assert.deepEqual(full.find((t) => t.id === kept.id).members, [{ userId: PLANNER_ID, isManager: false }]);
  assert.deepEqual(await service.list({ ...ADMIN, roles: ["planner"] }), [{ id: kept.id, name: "Kept" }]);
});
