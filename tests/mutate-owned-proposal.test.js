const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createArchiveOwnedProposal,
  createPermanentlyDeleteOwnedProposal,
  createRestoreOwnedProposal,
  createUpdateOwnedProposalMeta,
  createUpdateOwnedProposalStatus,
} = require("../src/modules/proposals/application/mutateOwnedProposal");

const createDependencies = (overrides = {}) => ({
  proposals: {
    findOwnedLifecycleById: async () => ({ isCopy: false }),
    updateOwnedById: async ({ updates }) => ({
      _id: "proposal-001",
      ...updates,
    }),
    archiveOwnedById: async () => true,
    restoreOwnedById: async () => true,
    markOwnedArchivedPurgeStartedById: async () => true,
    findOwnedArchivedPurgeTargetById: async ({ proposalId }) => ({
      proposalMongoId: proposalId,
      organizationMongoId: "org-001",
    }),
    permanentlyDeleteOwnedArchivedById: async () => true,
  },
  settings: {
    findByUserId: async () => ({ branding: { brandName: "DXG" } }),
  },
  ...overrides,
});

test("invalid status is rejected before persistence", async () => {
  let writes = 0;
  const updateStatus = createUpdateOwnedProposalStatus(
    createDependencies({
      proposals: {
        ...createDependencies().proposals,
        updateOwnedById: async () => {
          writes += 1;
          return null;
        },
      },
    }),
  );

  const result = await updateStatus({
    proposalId: "proposal-001",
    ownerUserId: "user-001",
    status: "published",
  });

  assert.equal(result.kind, "invalid_status");
  assert.equal(writes, 0);
});

test("publishing applies lifecycle rules through an ownership-scoped write", async () => {
  let write;
  const dependencies = createDependencies();
  dependencies.proposals.updateOwnedById = async (input) => {
    write = input;
    return { _id: input.proposalId, ...input.updates };
  };
  const updateStatus = createUpdateOwnedProposalStatus(dependencies);

  const result = await updateStatus({
    proposalId: "proposal-001",
    ownerUserId: "user-001",
    status: "submitted",
  });

  assert.deepEqual(write, {
    proposalId: "proposal-001",
    ownerUserId: "user-001",
    updates: {
      status: "submitted",
      isDraft: false,
      isCopy: false,
      isActive: true,
      isOpen: true,
    },
  });
  assert.equal(result.kind, "updated");
  assert.equal(result.proposal.proposalSetting.branding.brandName, "DXG");
});

test("copy metadata restrictions cannot toggle active, favorite, or open", async () => {
  let writes = 0;
  const dependencies = createDependencies();
  dependencies.proposals.findOwnedLifecycleById = async () => ({ isCopy: true });
  dependencies.proposals.updateOwnedById = async () => {
    writes += 1;
    return null;
  };
  const updateMeta = createUpdateOwnedProposalMeta(dependencies);

  const result = await updateMeta({
    proposalId: "proposal-copy",
    ownerUserId: "user-001",
    metadata: { isActive: true, isFavorite: true, isOpen: true },
  });

  assert.deepEqual(result, { kind: "no_valid_fields", copyRestricted: true });
  assert.equal(writes, 0);
});

test("allowed metadata is validated and written with owner context", async () => {
  let write;
  const dependencies = createDependencies();
  dependencies.proposals.updateOwnedById = async (input) => {
    write = input;
    return { _id: input.proposalId, ...input.updates };
  };
  const updateMeta = createUpdateOwnedProposalMeta(dependencies);

  const result = await updateMeta({
    proposalId: "proposal-001",
    ownerUserId: "user-001",
    metadata: {
      isFavorite: true,
      viewsCount: 4,
      isAccepted: false,
      ignored: true,
    },
  });

  assert.deepEqual(write, {
    proposalId: "proposal-001",
    ownerUserId: "user-001",
    updates: { isFavorite: true, isAccepted: false, viewsCount: 4 },
    runValidators: true,
  });
  assert.equal(result.kind, "updated");
});

test("metadata lookup hides missing and differently owned proposals", async () => {
  const dependencies = createDependencies();
  dependencies.proposals.findOwnedLifecycleById = async () => null;
  const updateMeta = createUpdateOwnedProposalMeta(dependencies);

  const result = await updateMeta({
    proposalId: "proposal-other-owner",
    ownerUserId: "user-001",
    metadata: { isFavorite: true },
  });

  assert.deepEqual(result, { kind: "not_found" });
});

test("archive, restore, and permanent delete preserve owner context", async () => {
  const calls = [];
  const proposals = {
    ...createDependencies().proposals,
    archiveOwnedById: async (input) => {
      calls.push({ action: "archive", input });
      return true;
    },
    restoreOwnedById: async (input) => {
      calls.push({ action: "restore", input });
      return true;
    },
    markOwnedArchivedPurgeStartedById: async () => true,
    findOwnedArchivedPurgeTargetById: async (input) => {
      calls.push({ action: "find-purge-target", input });
      return { proposalMongoId: input.proposalId, organizationMongoId: "org-001" };
    },
    permanentlyDeleteOwnedArchivedById: async (input) => {
      calls.push({ action: "delete", input });
      return true;
    },
  };
  const noopPurge = async () => {};
  const input = { proposalId: "proposal-001", ownerUserId: "user-001" };

  assert.equal((await createArchiveOwnedProposal(proposals)(input)).kind, "archived");
  assert.equal((await createRestoreOwnedProposal(proposals)(input)).kind, "restored");
  assert.equal(
    (await createPermanentlyDeleteOwnedProposal(proposals, noopPurge)(input)).kind,
    "deleted",
  );
  assert.deepEqual(
    calls.map(({ action, input: callInput }) => ({
      action,
      proposalId: callInput.proposalId,
      ownerUserId: callInput.ownerUserId,
    })),
    [
      { action: "archive", ...input },
      { action: "restore", ...input },
      { action: "find-purge-target", ...input },
      { action: "delete", ...input },
    ],
  );
  assert.ok(calls[0].input.archivedAt instanceof Date);
});

test("permanent delete purges cross-store artifacts before removing the proposal", async () => {
  // purgeProposalArtifacts used to be reachable only from the 30-day archive
  // sweep, so deleting through the product left private S3 objects and
  // Postgres rows with nothing left pointing at them.
  const order = [];
  const proposals = {
    markOwnedArchivedPurgeStartedById: async () => true,
    findOwnedArchivedPurgeTargetById: async () => ({
      proposalMongoId: "proposal-001",
      organizationMongoId: "org-001",
    }),
    permanentlyDeleteOwnedArchivedById: async () => {
      order.push("delete");
      return true;
    },
  };
  const purged = [];
  const purge = async (targets) => {
    order.push("purge");
    purged.push(...targets);
  };

  const result = await createPermanentlyDeleteOwnedProposal(proposals, purge)({
    proposalId: "proposal-001",
    ownerUserId: "user-001",
  });

  assert.equal(result.kind, "deleted");
  // Order matters: a failed purge must leave the record identifiable to retry.
  assert.deepEqual(order, ["purge", "delete"]);
  assert.deepEqual(purged, [{ proposalMongoId: "proposal-001", organizationMongoId: "org-001" }]);
});

test("a proposal that is not archived is neither purged nor deleted", async () => {
  let touched = false;
  const proposals = {
    markOwnedArchivedPurgeStartedById: async () => true,
    findOwnedArchivedPurgeTargetById: async () => null,
    permanentlyDeleteOwnedArchivedById: async () => {
      touched = true;
      return true;
    },
  };
  const result = await createPermanentlyDeleteOwnedProposal(proposals, async () => {
    touched = true;
  })({ proposalId: "proposal-001", ownerUserId: "user-001" });

  assert.equal(result.kind, "not_found");
  assert.equal(touched, false);
});

test("a proposal with no organization is still deleted, with nothing to purge", async () => {
  // The tenant GUC cannot be resolved without an organization, so the purge is
  // skipped rather than failing the delete — matching the archive sweep.
  const purgeCalls = [];
  const proposals = {
    markOwnedArchivedPurgeStartedById: async () => true,
    findOwnedArchivedPurgeTargetById: async () => ({
      proposalMongoId: "proposal-001",
      organizationMongoId: "",
    }),
    permanentlyDeleteOwnedArchivedById: async () => true,
  };
  const result = await createPermanentlyDeleteOwnedProposal(proposals, async (targets) => {
    purgeCalls.push(targets);
  })({ proposalId: "proposal-001", ownerUserId: "user-001" });

  assert.equal(result.kind, "deleted");
  assert.deepEqual(purgeCalls, [[]]);
});

test("permanent delete still removes the proposal when the purge did not finish, and says so", async () => {
  // A storage failure is not the planner's to retry: the proposal goes, the
  // response stays a success, and the unfinished purge is visible to a caller.
  const proposals = {
    markOwnedArchivedPurgeStartedById: async () => true,
    findOwnedArchivedPurgeTargetById: async () => ({
      proposalMongoId: "proposal-001",
      organizationMongoId: "org-001",
    }),
    permanentlyDeleteOwnedArchivedById: async () => true,
  };
  const input = { proposalId: "proposal-001", ownerUserId: "user-001" };

  const unfinished = await createPermanentlyDeleteOwnedProposal(proposals, async () => [{ complete: false }])(input);
  assert.deepEqual(unfinished, { kind: "deleted", artifactsPurged: false });

  const finished = await createPermanentlyDeleteOwnedProposal(proposals, async () => [{ complete: true }])(input);
  assert.deepEqual(finished, { kind: "deleted", artifactsPurged: true });
});

test("permanent delete marks the proposal before anything is purged, and stops if it is no longer archived", async () => {
  // Marking source documents for deletion cannot be undone, so the proposal is
  // marked first; restore and edit refuse it from then on.
  const order = [];
  const proposals = (marked) => ({
    findOwnedArchivedPurgeTargetById: async () => ({ proposalMongoId: "proposal-001", organizationMongoId: "org-001" }),
    markOwnedArchivedPurgeStartedById: async (input) => {
      order.push(`mark:${input.proposalId}:${input.ownerUserId}`);
      return marked;
    },
    permanentlyDeleteOwnedArchivedById: async () => {
      order.push("delete");
      return true;
    },
  });
  const purge = async () => {
    order.push("purge");
    return [{ complete: true }];
  };
  const input = { proposalId: "proposal-001", ownerUserId: "user-001" };

  assert.deepEqual(await createPermanentlyDeleteOwnedProposal(proposals(true), purge)(input), { kind: "deleted", artifactsPurged: true });
  assert.deepEqual(order, ["mark:proposal-001:user-001", "purge", "delete"]);

  // A restore won the race: nothing is archived any more, so nothing is purged or deleted.
  order.length = 0;
  assert.deepEqual(await createPermanentlyDeleteOwnedProposal(proposals(false), purge)(input), { kind: "not_found" });
  assert.deepEqual(order, ["mark:proposal-001:user-001"]);
});

test("restore refuses a proposal whose permanent delete has started", async () => {
  const recorded = [];
  const lifecycle = { recordChange: async (change) => recorded.push(change) };
  const input = { proposalId: "proposal-001", ownerUserId: "user-001" };

  const refused = await createRestoreOwnedProposal({ restoreOwnedById: async () => "being_deleted" }, lifecycle)(input);
  assert.deepEqual(refused, { kind: "being_deleted" });
  assert.deepEqual(recorded, [], "nothing is recorded as restored");

  assert.deepEqual(await createRestoreOwnedProposal({ restoreOwnedById: async () => false }, lifecycle)(input), { kind: "not_found" });
  assert.deepEqual(await createRestoreOwnedProposal({ restoreOwnedById: async () => true }, lifecycle)(input), { kind: "restored" });
  assert.equal(recorded.length, 1);
});

test("the marker is written and read where the access policy scopes it, and never copied", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const repository = read("src/modules/proposals/infrastructure/mongo/mongoProposalWriteRepository.ts");
  const method = (name, next) => repository.slice(repository.indexOf(`async ${name}(`), repository.indexOf(`async ${next}(`));

  // Set under the same policy action as the delete itself, on an archived proposal only.
  const mark = method("markOwnedArchivedPurgeStartedById", "permanentlyDeleteOwnedArchivedById");
  assert.match(mark, /scoped\(ownerUserId, "delete", \{ _id: proposalId, isArchived: true, \.\.\.extra \}\)/);
  assert.match(mark, /\$set: \{ purgeStartedAt: new Date\(\) \}/);
  // Restore and edit both carry the condition in the same atomic update as their write.
  const restore = method("restoreOwnedById", "findOwnedArchivedPurgeTargetById");
  assert.match(restore, /scoped\(ownerUserId, "archive", \{ _id: proposalId, isArchived: true, purgeStartedAt: null \}\)/);
  assert.match(restore, /return "being_deleted";/);
  const update = method("updateOwnedById", "incrementOwnedViews");
  assert.match(update, /scoped\(ownerUserId, "edit", \{ _id: proposalId, purgeStartedAt: null \}\)/);
  // Nothing else in the application writes or clears it.
  assert.equal((repository.match(/purgeStartedAt: new Date\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(repository, /\$unset: \{[^}]*purgeStartedAt/);
  // A copy and a client payload cannot carry it.
  assert.match(read("src/modules/proposals/application/authorOwnedProposal.ts"), /delete proposal\.purgeStartedAt;/);
  // The archive list still shows the proposal: no read filters on the marker.
  assert.doesNotMatch(read("src/modules/proposals/infrastructure/mongo/mongoProposalReadRepository.ts"), /purgeStartedAt/);
  // The refusal the planner sees.
  const controller = read("controller/proposalsController.ts");
  assert.match(controller, /res\.status\(409\)\.json\(\{\s+success: false,\s+code: "PROPOSAL_BEING_DELETED",\s+message: "This Proposal is being permanently deleted and can no longer be restored\.",/);
});
