require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { Types } = require("mongoose");
const { RFP_ACTIONS, canAccessRfp, rfpListScope } = require("../src/modules/identity/domain/rfpAccessPolicy");
const { hasOrganizationAction } = require("../src/modules/identity/domain/authorizationPolicy");

const id = () => new Types.ObjectId().toHexString();
const ORG = id();
const FOREIGN_ORG = id();
const ME = id();
const SOMEONE = id();
const MY_TEAM = id();
const OTHER_TEAM = id();
const ARCHIVED_TEAM = id(); // the actor managed it, so ORG-103 leaves it out of managedTeamIds

const ALL = [...RFP_ACTIONS];
const NONE = [];
const TEAM = ["view", "edit", "viewResponses", "reassign", "archive", "delete", "share"];
const OWN = ["view", "edit", "viewResponses", "archive", "delete", "share"];
const EDIT_SHARE = ["view", "edit", "viewResponses"];
const VIEW_SHARE = ["view", "viewResponses"];

// One proposal per relationship to the actor, plus the share the actor holds on it.
const relationships = {
  own: { rfp: { ownerUserId: ME } },
  "shared-view": { rfp: { ownerUserId: SOMEONE }, share: "view" },
  "shared-edit": { rfp: { ownerUserId: SOMEONE }, share: "edit" },
  team: { rfp: { ownerUserId: SOMEONE, teamId: MY_TEAM } },
  "other-team": { rfp: { ownerUserId: SOMEONE, teamId: OTHER_TEAM } },
  "archived-team": { rfp: { ownerUserId: SOMEONE, teamId: ARCHIVED_TEAM } },
  unrelated: { rfp: { ownerUserId: SOMEONE } },
  "foreign-org": { rfp: { ownerUserId: ME, organizationId: FOREIGN_ORG, teamId: MY_TEAM }, share: "edit" },
};

// The source permissions matrix (spec §4 and §7), written out per cell rather than derived.
const expected = {
  owner: { own: ALL, "shared-view": ALL, "shared-edit": ALL, team: ALL, "other-team": ALL, "archived-team": ALL, unrelated: ALL },
  organization_admin: { own: ALL, "shared-view": ALL, "shared-edit": ALL, team: ALL, "other-team": ALL, "archived-team": ALL, unrelated: ALL },
  team_manager: { own: OWN, "shared-view": VIEW_SHARE, "shared-edit": EDIT_SHARE, team: TEAM, "other-team": NONE, "archived-team": NONE, unrelated: NONE },
  planner: { own: OWN, "shared-view": VIEW_SHARE, "shared-edit": EDIT_SHARE, team: NONE, "other-team": NONE, "archived-team": NONE, unrelated: NONE },
  viewer: { own: NONE, "shared-view": VIEW_SHARE, "shared-edit": VIEW_SHARE, team: NONE, "other-team": NONE, "archived-team": NONE, unrelated: NONE },
};

const actorFor = (role, { share, rfpId, status = "active", managedTeamIds = [MY_TEAM] } = {}) => ({
  organizationId: ORG,
  userId: ME,
  roles: [role],
  membershipStatus: status,
  managedTeamIds,
  shares: new Map(share ? [[rfpId, share]] : []),
});

const fixture = (relationship) => {
  const { rfp, share } = relationships[relationship];
  const rfpId = id();
  return { rfp: { id: rfpId, organizationId: ORG, teamId: null, ...rfp }, share, rfpId };
};

// Minimal evaluator for the operators rfpListScope emits (equality, $in, $or). The integration
// suite runs the same scopes against real Mongo.
const same = (a, b) => a != null && b != null && String(a) === String(b);
const matches = (doc, filter) =>
  Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") return condition.some((clause) => matches(doc, clause));
    if (condition && Array.isArray(condition.$in)) return condition.$in.some((value) => same(doc[key], value));
    return same(doc[key], condition);
  });
const asDoc = (rfp) => ({ _id: rfp.id, organizationId: rfp.organizationId, userId: rfp.ownerUserId, teamId: rfp.teamId });

for (const [role, cells] of Object.entries(expected)) {
  for (const relationship of Object.keys(relationships)) {
    test(`${role} × ${relationship}`, () => {
      const { rfp, share, rfpId } = fixture(relationship);
      const actor = actorFor(role, { share, rfpId });
      for (const action of RFP_ACTIONS) {
        const decision = canAccessRfp(actor, rfp, action);
        if (relationship === "foreign-org") {
          assert.deepEqual(decision, { allowed: false, reason: "not_found" }, action);
        } else if (cells[relationship].includes(action)) {
          assert.deepEqual(decision, { allowed: true }, action);
        } else {
          assert.deepEqual(decision, { allowed: false, reason: "forbidden" }, action);
        }
        assert.equal(matches(asDoc(rfp), rfpListScope(actor, action)), decision.allowed, `list scope disagrees for ${action}`);
      }
    });
  }
}

test("a non-active membership is refused everything in its organization and lists nothing", () => {
  for (const status of ["invited", "suspended", "removed"]) {
    const { rfp } = fixture("own");
    const actor = actorFor("owner", { status });
    for (const action of RFP_ACTIONS) assert.deepEqual(canAccessRfp(actor, rfp, action), { allowed: false, reason: "forbidden" });
    assert.equal(matches(asDoc(rfp), rfpListScope(actor)), false);
  }
});

test("team rights need the team_manager role, not just a managed team id", () => {
  const { rfp } = fixture("team");
  for (const role of ["planner", "viewer", "knowledge_editor"]) {
    assert.equal(canAccessRfp(actorFor(role), rfp, "view").allowed, false, role);
  }
});

test("roles outside the customer set get no proposal access, even with a share", () => {
  const { rfp, rfpId } = fixture("shared-edit");
  for (const role of ["knowledge_editor", "knowledge_approver", "dxg_producer", "dxg_admin", "super_admin"]) {
    const actor = actorFor(role, { share: "edit", rfpId });
    for (const action of RFP_ACTIONS) assert.equal(canAccessRfp(actor, rfp, action).allowed, false, `${role} ${action}`);
  }
});

test("a proposal with no organization is never visible", () => {
  const rfp = { id: id(), organizationId: null, ownerUserId: ME };
  assert.deepEqual(canAccessRfp(actorFor("owner"), rfp, "view"), { allowed: false, reason: "not_found" });
});

test("ids compare by value whether they arrive as strings or ObjectIds", () => {
  const rfpId = id();
  const actor = { ...actorFor("planner", { share: "edit", rfpId }), organizationId: new Types.ObjectId(ORG), userId: new Types.ObjectId(ME) };
  const rfp = { id: new Types.ObjectId(rfpId), organizationId: new Types.ObjectId(ORG), ownerUserId: SOMEONE };
  assert.equal(canAccessRfp(actor, rfp, "edit").allowed, true);
});

test("the organization-wide scope is the organization filter alone", () => {
  const scope = rfpListScope(actorFor("organization_admin"));
  assert.deepEqual(Object.keys(scope), ["organizationId"]);
  assert.equal(String(scope.organizationId), ORG);
});

// Seeded PRNG so a failure reproduces.
const prng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

test("list scope and single-proposal decision agree on randomized fixtures", () => {
  const random = prng(20261101);
  const pick = (values) => values[Math.floor(random() * values.length)];
  const users = Array.from({ length: 6 }, id);
  const teams = Array.from({ length: 4 }, id);
  const roles = ["owner", "organization_admin", "team_manager", "planner", "viewer", "knowledge_editor"];
  let checks = 0;
  for (let round = 0; round < 300; round++) {
    const rfps = Array.from({ length: 12 }, () => ({
      id: id(),
      organizationId: random() < 0.85 ? ORG : FOREIGN_ORG,
      ownerUserId: random() < 0.95 ? pick(users) : null,
      teamId: random() < 0.6 ? pick(teams) : null,
    }));
    const actor = {
      organizationId: ORG,
      userId: pick(users),
      roles: roles.filter(() => random() < 0.3),
      membershipStatus: random() < 0.9 ? "active" : pick(["invited", "suspended", "removed"]),
      managedTeamIds: teams.filter(() => random() < 0.35),
      shares: new Map(rfps.filter(() => random() < 0.3).map((rfp) => [rfp.id, pick(["view", "edit"])])),
    };
    for (const action of RFP_ACTIONS) {
      const scope = rfpListScope(actor, action);
      for (const rfp of rfps) {
        assert.equal(matches(asDoc(rfp), scope), canAccessRfp(actor, rfp, action).allowed, JSON.stringify({ round, action, rfp, roles: actor.roles }));
        checks++;
      }
    }
  }
  assert.equal(checks, 300 * RFP_ACTIONS.length * 12);
});

test("new customer roles carry coarse capabilities; viewers stay read-only", () => {
  for (const role of ["owner", "team_manager"]) {
    assert.equal(hasOrganizationAction([role], "proposal:write"), true, role);
    assert.equal(hasOrganizationAction([role], "assistant:use"), true, role);
  }
  assert.equal(hasOrganizationAction(["owner"], "organization:manage"), true);
  assert.equal(hasOrganizationAction(["team_manager"], "organization:manage"), false);
  assert.equal(hasOrganizationAction(["viewer"], "proposal:read"), true);
  assert.equal(hasOrganizationAction(["viewer"], "vendor-response:read"), true);
  for (const action of ["proposal:write", "proposal:publish", "vendor-response:write", "assistant:use", "knowledge:write"]) {
    assert.equal(hasOrganizationAction(["viewer"], action), false, action);
  }
  for (const role of ["owner", "organization_admin", "team_manager", "planner", "viewer"]) {
    assert.equal(hasOrganizationAction([role], "security:admin"), false, role);
  }
});
