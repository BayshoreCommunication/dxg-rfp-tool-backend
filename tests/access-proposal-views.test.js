const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createGetProposalByLegacyPublicId,
  createIncrementLegacyPublicProposalViews,
  createIncrementOwnedProposalViews,
} = require("../src/modules/proposals/application/accessProposalViews");

const proposal = {
  _id: "proposal-001",
  event: { eventName: "  DXG Summit  " },
  viewsCount: 7,
  createdAt: "2026-07-15T00:00:00.000Z",
  isActive: true,
};

const settings = {
  findByUserId: async () => ({
    branding: { brandName: "DXG" },
    proposals: { expiryDate: "30 days" },
  }),
};

test("legacy public lookup is isolated behind its compatibility port", async () => {
  let lookupId;
  const getPublic = createGetProposalByLegacyPublicId({
    publicAccess: {
      findByLegacyPublicId: async (id) => {
        lookupId = id;
        return { ownerUserId: "user-001", proposal };
      },
      incrementViewsByLegacyPublicId: async () => null,
    },
    settings,
  });

  const result = await getPublic("proposal-001");

  assert.equal(lookupId, "proposal-001");
  assert.equal(result.kind, "found");
  assert.equal(result.proposal.proposalSetting.branding.brandName, "DXG");
});

test("legacy public lookup returns not found without loading settings", async () => {
  let settingsReads = 0;
  const getPublic = createGetProposalByLegacyPublicId({
    publicAccess: {
      findByLegacyPublicId: async () => null,
      incrementViewsByLegacyPublicId: async () => null,
    },
    settings: {
      findByUserId: async () => {
        settingsReads += 1;
        return null;
      },
    },
  });

  assert.deepEqual(await getPublic("missing"), { kind: "not_found" });
  assert.equal(settingsReads, 0);
});

test("public view increment notifies the actual proposal owner", async () => {
  let notification;
  const increment = createIncrementLegacyPublicProposalViews({
    publicAccess: {
      findByLegacyPublicId: async () => null,
      incrementViewsByLegacyPublicId: async () => ({
        ownerUserId: "user-owner",
        proposal,
      }),
    },
    settings,
    notifications: {
      notifyProposalViewed: async (input) => {
        notification = input;
      },
    },
  });

  const result = await increment("proposal-001");

  assert.equal(result.kind, "incremented");
  assert.deepEqual(notification, {
    ownerUserId: "user-owner",
    proposalId: "proposal-001",
    proposalTitle: "DXG Summit",
    viewsCount: 7,
  });
});

test("ownerless legacy record neither queries settings nor sends notification", async () => {
  let sideEffects = 0;
  const increment = createIncrementLegacyPublicProposalViews({
    publicAccess: {
      findByLegacyPublicId: async () => null,
      incrementViewsByLegacyPublicId: async () => ({
        ownerUserId: "",
        proposal,
      }),
    },
    settings: {
      findByUserId: async () => {
        sideEffects += 1;
        return null;
      },
    },
    notifications: {
      notifyProposalViewed: async () => {
        sideEffects += 1;
      },
    },
  });

  const result = await increment("proposal-001");

  assert.equal(result.kind, "incremented");
  assert.equal(sideEffects, 0);
});

test("authenticated view increment preserves ownership in persistence", async () => {
  let writeInput;
  let notification;
  const increment = createIncrementOwnedProposalViews({
    proposals: {
      incrementOwnedViews: async (input) => {
        writeInput = input;
        return proposal;
      },
    },
    settings,
    notifications: {
      notifyProposalViewed: async (input) => {
        notification = input;
      },
    },
  });
  const input = { proposalId: "proposal-001", ownerUserId: "user-001" };

  const result = await increment(input);

  assert.deepEqual(writeInput, input);
  assert.equal(result.kind, "incremented");
  assert.equal(notification.ownerUserId, "user-001");
});
