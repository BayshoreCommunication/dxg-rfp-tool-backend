const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createGetOwnedProposal,
} = require("../src/modules/proposals/application/getOwnedProposal");

const createDependencies = (overrides = {}) => ({
  proposals: {
    findOwnedById: async () => ({
      _id: "proposal-001",
      createdAt: "2026-01-01T00:00:00.000Z",
      isActive: true,
      status: "submitted",
    }),
  },
  settings: {
    findByUserId: async () => ({
      branding: { brandName: "DXG" },
      proposals: { expiryDate: "30 days", defaultCurrency: "USD" },
    }),
  },
  ...overrides,
});

test("owned proposal lookup always carries proposal and owner identifiers", async () => {
  let receivedInput;
  const getOwnedProposal = createGetOwnedProposal(
    createDependencies({
      proposals: {
        findOwnedById: async (input) => {
          receivedInput = input;
          return { _id: input.proposalId, isActive: true };
        },
      },
    }),
  );

  await getOwnedProposal({
    proposalId: "proposal-123",
    ownerUserId: "user-456",
  });

  assert.deepEqual(receivedInput, {
    proposalId: "proposal-123",
    ownerUserId: "user-456",
  });
});

test("missing or differently owned proposal is returned as not found", async () => {
  const getOwnedProposal = createGetOwnedProposal(
    createDependencies({
      proposals: { findOwnedById: async () => null },
    }),
  );

  const result = await getOwnedProposal({
    proposalId: "proposal-404",
    ownerUserId: "user-001",
  });

  assert.deepEqual(result, { kind: "not_found" });
});

test("expired proposal is derived as inactive without mutating persistence", async () => {
  const storedProposal = {
    _id: "proposal-old",
    createdAt: "2026-01-01T00:00:00.000Z",
    isActive: true,
    isOpen: true,
    status: "submitted",
  };
  const getOwnedProposal = createGetOwnedProposal(
    createDependencies({
      proposals: { findOwnedById: async () => storedProposal },
    }),
  );

  const result = await getOwnedProposal({
    proposalId: "proposal-old",
    ownerUserId: "user-001",
  });

  assert.equal(result.kind, "found");
  assert.equal(result.proposal.isActive, false);
  assert.equal(result.proposal.isOpen, false);
  assert.equal(result.proposal.status, "unsubmitted");
  assert.equal(storedProposal.isActive, true);
  assert.equal(storedProposal.status, "submitted");
});

test("response receives a stable settings snapshot", async () => {
  const getOwnedProposal = createGetOwnedProposal(createDependencies());
  const result = await getOwnedProposal({
    proposalId: "proposal-001",
    ownerUserId: "user-001",
  });

  assert.equal(result.kind, "found");
  assert.equal(result.proposal.proposalSetting.branding.brandName, "DXG");
  assert.equal(
    result.proposal.proposalSetting.proposals.defaultCurrency,
    "USD",
  );
  assert.equal(result.proposal.proposalSetting.proposals.contacts.email.enabled, false);
});
