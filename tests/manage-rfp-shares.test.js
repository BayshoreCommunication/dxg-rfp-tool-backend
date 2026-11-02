require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRfpSharing } = require("../src/modules/rfpSharing/application/manageRfpShares");
const { ShareError } = require("../src/modules/rfpSharing/domain");

const hex = (c) => c.repeat(24);
const ORG = hex("a");
const FOREIGN_ORG = hex("9");
const OWNER = hex("1");
const MANAGER = hex("2");
const ADMIN = hex("3");
const PLANNER = hex("4");
const VIEWER = hex("5");
const DEACTIVATED = hex("6");
const FOREIGNER = hex("7");
const EDITOR = hex("8");
const TEAM = hex("e");
const PROPOSAL = hex("b");
const FOREIGN_PROPOSAL = hex("c");

const members = {
  [ORG]: {
    [OWNER]: { roles: ["planner"], status: "active" },
    [MANAGER]: { roles: ["team_manager"], status: "active" },
    [ADMIN]: { roles: ["organization_admin"], status: "active" },
    [PLANNER]: { roles: ["planner"], status: "active" },
    [EDITOR]: { roles: ["planner"], status: "active" },
    [VIEWER]: { roles: ["viewer"], status: "active" },
    [DEACTIVATED]: { roles: ["planner"], status: "suspended" },
  },
  [FOREIGN_ORG]: { [FOREIGNER]: { roles: ["planner"], status: "active" } },
};

const actor = (userId, { organizationId = ORG, managedTeamIds = [], shares = [] } = {}) => ({
  rfpActor: {
    organizationId,
    userId,
    roles: members[organizationId][userId].roles,
    membershipStatus: members[organizationId][userId].status,
    managedTeamIds,
    shares: new Map(shares),
  },
  correlationId: "corr-1",
});

const setup = () => {
  const rows = [];
  const audit = [];
  const proposals = {
    [PROPOSAL]: { id: PROPOSAL, organizationId: ORG, ownerUserId: OWNER, teamId: TEAM },
    [FOREIGN_PROPOSAL]: { id: FOREIGN_PROPOSAL, organizationId: FOREIGN_ORG, ownerUserId: FOREIGNER, teamId: null },
  };
  const service = createRfpSharing({
    shares: {
      async list(organizationId, proposalId) {
        return rows.filter((r) => r.organizationId === organizationId && r.proposalId === proposalId)
          .map(({ userId, permission, grantedBy }) => ({ userId, permission, grantedBy, createdAt: new Date(0), updatedAt: new Date(0) }));
      },
      async upsert(input) {
        const row = rows.find((r) => r.proposalId === input.proposalId && r.userId === input.userId);
        if (row) { const previous = row.permission; Object.assign(row, input); return previous; }
        rows.push({ ...input });
        return null;
      },
      async remove({ organizationId, proposalId, userId }) {
        const index = rows.findIndex((r) => r.organizationId === organizationId && r.proposalId === proposalId && r.userId === userId);
        if (index < 0) return null;
        return rows.splice(index, 1)[0].permission;
      },
    },
    proposals: { async find(organizationId, proposalId) { const p = proposals[proposalId]; return p && p.organizationId === organizationId ? p : null; } },
    directory: {
      async find(organizationId, userIds) {
        return new Map(userIds.filter((id) => members[organizationId]?.[id]).map((id) => [id, members[organizationId][id]]));
      },
    },
    audit: { append: async (event) => { audit.push(event); } },
    isValidId: (value) => /^[0-9a-f]{24}$/.test(value),
  });
  return { service, rows, audit };
};

const rejects = (promise, code, status) =>
  assert.rejects(promise, (error) => error instanceof ShareError && error.code === code && error.status === status);

test("the owner, the team's manager and an Admin can share; others can't", async () => {
  const { service } = setup();
  for (const who of [actor(OWNER), actor(MANAGER, { managedTeamIds: [TEAM] }), actor(ADMIN)]) {
    const shares = await service.grant(who, PROPOSAL, PLANNER, { permission: "view" });
    assert.deepEqual(shares.map((s) => [s.userId, s.permission, s.memberActive]), [[PLANNER, "view", true]]);
  }
  // A manager of another team, a planner with an edit share, a viewer with a view share: refused.
  for (const who of [actor(MANAGER, { managedTeamIds: [hex("f")] }), actor(EDITOR, { shares: [[PROPOSAL, "edit"]] }), actor(VIEWER, { shares: [[PROPOSAL, "view"]] })]) {
    await rejects(service.grant(who, PROPOSAL, PLANNER, { permission: "edit" }), "SHARE_NOT_ALLOWED", 403);
    await rejects(service.revoke(who, PROPOSAL, PLANNER), "SHARE_NOT_ALLOWED", 403);
    await rejects(service.list(who, PROPOSAL), "SHARE_NOT_ALLOWED", 403);
  }
});

test("shares stay in the organization and another organization's proposal is not found", async () => {
  const { service } = setup();
  await rejects(service.grant(actor(OWNER), PROPOSAL, FOREIGNER, { permission: "view" }), "MEMBER_NOT_FOUND", 404);
  await rejects(service.grant(actor(OWNER), PROPOSAL, "nope", { permission: "view" }), "MEMBER_NOT_FOUND", 404);
  await rejects(service.grant(actor(ADMIN), FOREIGN_PROPOSAL, PLANNER, { permission: "view" }), "PROPOSAL_NOT_FOUND", 404);
  await rejects(service.list(actor(FOREIGNER, { organizationId: FOREIGN_ORG }), PROPOSAL), "PROPOSAL_NOT_FOUND", 404);
  await rejects(service.list(actor(ADMIN), "not-an-id"), "PROPOSAL_NOT_FOUND", 404);
});

test("viewers get view only; deactivated members, the owner and bad permissions are refused", async () => {
  const { service } = setup();
  await rejects(service.grant(actor(OWNER), PROPOSAL, VIEWER, { permission: "edit" }), "VIEWER_VIEW_ONLY", 422);
  assert.equal((await service.grant(actor(OWNER), PROPOSAL, VIEWER, { permission: "view" }))[0].permission, "view");
  await rejects(service.grant(actor(OWNER), PROPOSAL, DEACTIVATED, { permission: "view" }), "MEMBER_INACTIVE", 409);
  await rejects(service.grant(actor(ADMIN), PROPOSAL, OWNER, { permission: "edit" }), "SHARE_TARGET_IS_OWNER", 409);
  for (const permission of ["admin", undefined, ["edit"]]) {
    await rejects(service.grant(actor(OWNER), PROPOSAL, PLANNER, { permission }), "INVALID_SHARE_PERMISSION", 400);
  }
});

test("grant, change and revoke are audited; an unchanged grant writes nothing", async () => {
  const { service, audit } = setup();
  await service.grant(actor(OWNER), PROPOSAL, PLANNER, { permission: "view" });
  await service.grant(actor(OWNER), PROPOSAL, PLANNER, { permission: "view" });
  await service.grant(actor(ADMIN), PROPOSAL, PLANNER, { permission: "edit" });
  assert.deepEqual(await service.revoke(actor(OWNER), PROPOSAL, PLANNER), []);
  await rejects(service.revoke(actor(OWNER), PROPOSAL, PLANNER), "SHARE_NOT_FOUND", 404);
  assert.deepEqual(audit.map((e) => [e.action, e.decision, e.actorUserId, e.metadata]), [
    ["proposal.share_granted", "created", OWNER, { userId: PLANNER, permission: "view", previousPermission: null }],
    ["proposal.share_granted", "created", ADMIN, { userId: PLANNER, permission: "edit", previousPermission: "view" }],
    ["proposal.share_revoked", "revoked", OWNER, { userId: PLANNER, permission: "edit" }],
  ]);
  assert.ok(audit.every((e) => e.organizationId === ORG && e.targetType === "proposal" && e.targetId === PROPOSAL && e.correlationId === "corr-1"));
});

test("a deactivated member's share is kept, listed as inactive, and can still be revoked", async () => {
  const { service, rows } = setup();
  await service.grant(actor(OWNER), PROPOSAL, EDITOR, { permission: "edit" });
  members[ORG][EDITOR].status = "suspended";
  try {
    const listed = await service.list(actor(OWNER), PROPOSAL);
    assert.deepEqual(listed.map((s) => [s.userId, s.memberActive]), [[EDITOR, false]]);
    assert.equal(rows.length, 1);
    await service.revoke(actor(OWNER), PROPOSAL, EDITOR);
    assert.equal(rows.length, 0);
  } finally {
    members[ORG][EDITOR].status = "active";
  }
});
