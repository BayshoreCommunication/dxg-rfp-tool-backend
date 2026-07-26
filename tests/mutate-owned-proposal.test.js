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
    permanentlyDeleteOwnedArchivedById: async (input) => {
      calls.push({ action: "delete", input });
      return true;
    },
  };
  const input = { proposalId: "proposal-001", ownerUserId: "user-001" };

  assert.equal((await createArchiveOwnedProposal(proposals)(input)).kind, "archived");
  assert.equal((await createRestoreOwnedProposal(proposals)(input)).kind, "restored");
  assert.equal(
    (await createPermanentlyDeleteOwnedProposal(proposals)(input)).kind,
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
      { action: "delete", ...input },
    ],
  );
  assert.ok(calls[0].input.archivedAt instanceof Date);
});
