require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Types } = require("mongoose");
const Proposal = require("../modal/proposalsModel").default;
const User = require("../modal/userModel").default;
const Team = require("../modal/teamModel").default;
const { canAccessRfp } = require("../src/modules/identity/domain/rfpAccessPolicy");
const { hasOrganizationAction } = require("../src/modules/identity/domain/authorizationPolicy");
const { rfpRowPermissions } = require("../src/modules/identity/domain/rfpRowPermissions");
const { isProposalAccessDenied } = require("../src/modules/identity/application/proposalAccess");
const { runWithTenant } = require("../src/modules/shared/tenancy/tenantContext");
const { mongoProposalWriteRepository } = require("../src/modules/proposals/infrastructure/mongo/mongoProposalWriteRepository");
const { mongoProposalReadRepository } = require("../src/modules/proposals/infrastructure/mongo/mongoProposalReadRepository");
const { mongoRfpDashboardRepository } = require("../src/modules/rfpDashboard/mongoRfpDashboardRepository");

// The per-row permissions on GET /api/v1/rfps and GET /api/proposals. Three things are proved:
// the flags are the access policy's own decisions, they are what the mutation repository and
// routes really enforce, and both list repositories attach them without another query.

const id = () => new Types.ObjectId().toHexString();
const ORG = id();
const FOREIGN_ORG = id();
const ME = id();
const SOMEONE = id();
const MY_TEAM = id();
const OTHER_TEAM = id();

const relationships = {
  own: { rfp: { ownerUserId: ME } },
  "shared-view": { rfp: { ownerUserId: SOMEONE }, share: "view" },
  "shared-edit": { rfp: { ownerUserId: SOMEONE }, share: "edit" },
  "managed-team": { rfp: { ownerUserId: SOMEONE, teamId: MY_TEAM } },
  "other-team": { rfp: { ownerUserId: SOMEONE, teamId: OTHER_TEAM } },
  unrelated: { rfp: { ownerUserId: SOMEONE } },
  "foreign-org": { rfp: { ownerUserId: ME, organizationId: FOREIGN_ORG, teamId: MY_TEAM }, share: "edit" },
};

// [canEdit, canDuplicate, canArchive], written out per cell rather than derived.
const ALL = [true, true, true];
const NONE = [false, false, false];
const COPY_ONLY = [false, true, false]; // a view share: may read, so may save a copy of it
const EDIT_AND_COPY = [true, true, false]; // an edit share: never archive
const expected = {
  owner: { own: ALL, "shared-view": ALL, "shared-edit": ALL, "managed-team": ALL, "other-team": ALL, unrelated: ALL, "foreign-org": NONE },
  organization_admin: { own: ALL, "shared-view": ALL, "shared-edit": ALL, "managed-team": ALL, "other-team": ALL, unrelated: ALL, "foreign-org": NONE },
  team_manager: { own: ALL, "shared-view": COPY_ONLY, "shared-edit": EDIT_AND_COPY, "managed-team": ALL, "other-team": NONE, unrelated: NONE, "foreign-org": NONE },
  planner: { own: ALL, "shared-view": COPY_ONLY, "shared-edit": EDIT_AND_COPY, "managed-team": NONE, "other-team": NONE, unrelated: NONE, "foreign-org": NONE },
  // A Viewer reads what is shared with them and changes nothing, whatever the share says.
  viewer: { own: NONE, "shared-view": NONE, "shared-edit": NONE, "managed-team": NONE, "other-team": NONE, unrelated: NONE, "foreign-org": NONE },
  // Not a proposal role at all.
  knowledge_editor: { own: NONE, "shared-view": NONE, "shared-edit": NONE, "managed-team": NONE, "other-team": NONE, unrelated: NONE, "foreign-org": NONE },
};

const actorFor = (role, { share, rfpId, status = "active" } = {}) => ({
  organizationId: ORG,
  userId: ME,
  roles: [role],
  membershipStatus: status,
  managedTeamIds: [MY_TEAM],
  shares: new Map(share ? [[rfpId, share]] : []),
});

const fixture = (relationship) => {
  const { rfp, share } = relationships[relationship];
  const rfpId = id();
  return { rfp: { id: rfpId, organizationId: ORG, teamId: null, ...rfp }, share, rfpId };
};

const flags = (permissions) => [permissions.canEdit, permissions.canDuplicate, permissions.canArchive];

for (const [role, cells] of Object.entries(expected)) {
  for (const relationship of Object.keys(relationships)) {
    test(`row permissions: ${role} × ${relationship}`, () => {
      const { rfp, share, rfpId } = fixture(relationship);
      const actor = actorFor(role, { share, rfpId });
      const permissions = rfpRowPermissions(actor, rfp);
      assert.deepEqual(Object.keys(permissions).sort(), ["canArchive", "canDuplicate", "canEdit"]);
      assert.deepEqual(flags(permissions), cells[relationship]);

      // Each flag is the policy's decision for its action, together with the route's capability.
      const mayWrite = hasOrganizationAction(actor.roles, "proposal:write");
      assert.equal(permissions.canEdit, mayWrite && canAccessRfp(actor, rfp, "edit").allowed);
      assert.equal(permissions.canDuplicate, mayWrite && canAccessRfp(actor, rfp, "view").allowed);
      assert.equal(permissions.canArchive, mayWrite && canAccessRfp(actor, rfp, "archive").allowed);
      // For every role that can change proposals the capability adds nothing: the flag is the
      // policy decision alone.
      if (["owner", "organization_admin", "team_manager", "planner"].includes(role)) {
        assert.equal(permissions.canEdit, canAccessRfp(actor, rfp, "edit").allowed);
        assert.equal(permissions.canArchive, canAccessRfp(actor, rfp, "archive").allowed);
        assert.equal(permissions.canDuplicate, canAccessRfp(actor, rfp, "view").allowed);
      }
    });
  }
}

test("a member who is no longer active gets no row permissions", () => {
  for (const status of ["invited", "suspended", "removed"]) {
    const { rfp } = fixture("own");
    assert.deepEqual(flags(rfpRowPermissions(actorFor("owner", { status }), rfp)), NONE, status);
  }
});

// ---- Agreement with the mutation endpoints ----------------------------------------------------

// Evaluates the Mongo filters the proposal repositories build ($and, $or, $in, $ne, equality).
const same = (a, b) => a != null && b != null && String(a) === String(b);
const matches = (doc, filter) =>
  Object.entries(filter).every(([key, condition]) => {
    if (key === "$and") return condition.every((clause) => matches(doc, clause));
    if (key === "$or") return condition.some((clause) => matches(doc, clause));
    if (condition && typeof condition === "object" && Array.isArray(condition.$in)) return condition.$in.some((value) => same(doc[key], value));
    if (condition && typeof condition === "object" && "$ne" in condition) return doc[key] !== condition.$ne;
    if (typeof condition === "boolean") return doc[key] === condition;
    return same(doc[key], condition);
  });

// A query object as the repositories use it: chainable, awaitable.
const query = (value) => {
  const chain = { then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
  for (const method of ["select", "sort", "skip", "limit", "lean"]) chain[method] = () => chain;
  return chain;
};

// Replaces model statics for one test and restores them, counting the calls made.
const withModels = async (stubs, run) => {
  const originals = [];
  const calls = [];
  for (const [model, methods] of stubs) {
    for (const [name, implementation] of Object.entries(methods)) {
      originals.push([model, name, Object.getOwnPropertyDescriptor(model, name)]);
      model[name] = (...args) => {
        calls.push(`${model.modelName}.${name}`);
        return implementation(...args);
      };
    }
  }
  try {
    await run(calls);
  } finally {
    for (const [model, name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(model, name, descriptor);
      else delete model[name];
    }
  }
};

const asDoc = (rfp, extra = {}) => ({ _id: rfp.id, organizationId: rfp.organizationId, userId: rfp.ownerUserId, teamId: rfp.teamId, ...extra });
const oneProposalStore = (doc) => {
  const find = (filter) => query(matches(doc, filter) ? { ...doc } : null);
  return [[Proposal, { findOne: find, findOneAndUpdate: find, findOneAndDelete: find }]];
};
const inRequest = (actor, run) => new Promise((resolve, reject) => {
  runWithTenant({ organizationId: String(actor.organizationId), userId: String(actor.userId), rfpActor: actor }, () => {
    Promise.resolve().then(run).then(resolve, reject);
  });
});
// Whether the repository call behind a mutation goes through: a refusal is a 403
// (ProposalAccessDeniedError), a proposal outside the organization is a plain miss.
const goesThrough = async (call) => {
  try {
    return Boolean(await call());
  } catch (error) {
    if (isProposalAccessDenied(error)) return false;
    throw error;
  }
};

for (const role of Object.keys(expected)) {
  test(`${role}: each flag is what the mutation's own query allows`, async () => {
    for (const relationship of Object.keys(relationships)) {
      const { rfp, share, rfpId } = fixture(relationship);
      const actor = actorFor(role, { share, rfpId });
      const permissions = rfpRowPermissions(actor, rfp);
      // Every proposal mutation route first requires proposal:write (asserted on the routes below).
      const mayWrite = hasOrganizationAction(actor.roles, "proposal:write");
      const input = { proposalId: rfpId, ownerUserId: ME };
      const attempt = async (doc, call) => {
        let result;
        await withModels(oneProposalStore(doc), async () => {
          result = await inRequest(actor, () => goesThrough(call));
        });
        return result;
      };

      const edit = await attempt(asDoc(rfp), () => mongoProposalWriteRepository.updateOwnedById({ ...input, updates: { status: "submitted" } }));
      const copy = await attempt(asDoc(rfp), () => mongoProposalWriteRepository.findOwnedCopySourceById(input));
      const archive = await attempt(asDoc(rfp, { isArchived: false }), () => mongoProposalWriteRepository.archiveOwnedById({ ...input, archivedAt: new Date() }));
      const restore = await attempt(asDoc(rfp, { isArchived: true }), () => mongoProposalWriteRepository.restoreOwnedById(input));

      assert.equal(permissions.canEdit, mayWrite && edit, `${relationship}: edit`);
      assert.equal(permissions.canDuplicate, mayWrite && copy, `${relationship}: copy`);
      assert.equal(permissions.canArchive, mayWrite && archive, `${relationship}: archive`);
      assert.equal(permissions.canArchive, mayWrite && restore, `${relationship}: restore`);
    }
  });
}

test("the mutation routes behind the flags all require proposal:write", () => {
  const routes = fs.readFileSync(path.join(__dirname, "..", "routes", "proposalsRoute.ts"), "utf8");
  const guarded = [
    ['router.put("/:id"', "updateProposal"],
    ['router.post("/:id/copy"', "copyProposal"],
    ['router.delete("/:id"', "deleteProposal"],
    ['router.patch("/:id/restore"', "restoreProposal"],
  ];
  for (const [route, handler] of guarded) {
    const line = routes.split("\n").find((candidate) => candidate.startsWith(`${route},`));
    assert.ok(line, `${route} is still declared`);
    assert.match(line, /authenticate, authorizeAction\("proposal:write"\)/, route);
    assert.ok(line.trimEnd().endsWith(`${handler});`), `${route} -> ${handler}`);
  }
});

// ---- The lists carry them, without another query ----------------------------------------------

const listRows = (actorRole) => {
  const rows = Object.keys(relationships).filter((relationship) => relationship !== "foreign-org").map((relationship) => ({ relationship, ...fixture(relationship) }));
  const shares = new Map(rows.filter((row) => row.share).map((row) => [row.rfpId, row.share]));
  return { rows, actor: { ...actorFor(actorRole), shares } };
};

for (const role of ["owner", "organization_admin", "team_manager", "planner", "viewer"]) {
  test(`GET /api/v1/rfps rows carry the policy's decisions for a ${role}, in one list query`, async () => {
    const { rows, actor } = listRows(role);
    const stored = rows.map(({ rfp }) => ({
      _id: new Types.ObjectId(rfp.id),
      effectiveStage: "sent",
      organizationId: new Types.ObjectId(rfp.organizationId),
      userId: new Types.ObjectId(rfp.ownerUserId),
      teamId: rfp.teamId ? new Types.ObjectId(rfp.teamId) : null,
      event: { eventName: "Annual Summit" },
    }));
    let projection = {};
    await withModels(
      [
        // Like Mongo, hand back only what the pipeline's own $project asks for (plus _id), so a
        // field the policy needs but the projection drops is missing here too.
        [Proposal, {
          aggregate: async (pipeline) => {
            projection = pipeline.find((stage) => stage.$facet).$facet.items.find((stage) => stage.$project).$project;
            const kept = new Set(["_id", ...Object.keys(projection).map((field) => field.split(".")[0])]);
            const items = stored.map((row) => Object.fromEntries(Object.entries(row).filter(([field]) => kept.has(field))));
            return [{ items, total: [{ count: stored.length }] }];
          },
        }],
        [User, { find: () => query([]) }],
        [Team, { find: () => query([]) }],
      ],
      async (calls) => {
        const { items } = await mongoRfpDashboardRepository.list(actor, { stages: [], page: 1, limit: 25, sortBy: "updatedAt", sortOrder: "desc" });
        assert.equal(items.length, rows.length);
        for (const [index, { rfp, relationship }] of rows.entries()) {
          assert.equal(items[index].id, rfp.id);
          assert.deepEqual(flags(items[index].permissions), expected[role][relationship], relationship);
          assert.deepEqual(items[index].permissions, rfpRowPermissions(actor, rfp), relationship);
        }
        // Everything the policy decides from is read by the list query itself.
        for (const field of ["organizationId", "userId", "teamId"]) assert.equal(projection[field], 1, `$project keeps ${field}`);
        // The same three queries as before this field existed, whatever the page size.
        assert.deepEqual(calls.sort(), ["Proposal.aggregate", "Team.find", "User.find"]);
      },
    );
  });

  test(`GET /api/proposals rows carry the policy's decisions for a ${role}, in one list query`, async () => {
    const { rows, actor } = listRows(role);
    const stored = rows.map(({ rfp }) => ({
      _id: new Types.ObjectId(rfp.id),
      status: "submitted",
      organizationId: new Types.ObjectId(rfp.organizationId),
      userId: new Types.ObjectId(rfp.ownerUserId),
      teamId: rfp.teamId ? new Types.ObjectId(rfp.teamId) : null,
      event: { eventName: "Annual Summit" },
    }));
    let selected = "";
    await withModels(
      [[Proposal, {
        find: () => {
          const chain = query(stored.map((row) => ({ ...row })));
          chain.select = (fields) => {
            selected = fields;
            return chain;
          };
          return chain;
        },
        countDocuments: async () => stored.length,
      }]],
      async (calls) => {
        const result = await inRequest(actor, () => mongoProposalReadRepository.listOwned({
          ownerUserId: ME, archived: false, isCopy: false, includeCounts: false, page: 1, limit: 20, sortBy: "createdAt", sortOrder: "desc", expiryDays: null,
        }));
        assert.equal(result.proposals.length, rows.length);
        for (const [index, { rfp, relationship }] of rows.entries()) {
          const proposal = result.proposals[index];
          assert.equal(String(proposal._id), rfp.id);
          assert.deepEqual(flags(proposal.permissions), expected[role][relationship], relationship);
          // The fields read to decide them stay out of the response, as before.
          for (const field of ["organizationId", "userId", "teamId"]) assert.equal(field in proposal, false, field);
          assert.equal(proposal.status, "submitted");
        }
        for (const field of ["organizationId", "userId", "teamId"]) assert.match(selected, new RegExp(`\\b${field}\\b`));
        assert.deepEqual(calls.sort(), ["Proposal.countDocuments", "Proposal.find"]);
      },
    );
  });
}
