require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSynchronizeProposalReference } = require("../src/modules/dataFoundation/application/synchronizeProposalReference");

const id = "6a58a2d07dac2b57c12d5247";
test("proposal synchronization validates external identifiers before persistence", async () => {
  let called = false;
  const sync = createSynchronizeProposalReference({ upsertWithOutbox: async () => { called = true; return {}; } });
  assert.equal((await sync({ organizationMongoId: "bad", ownerUserMongoId: id, proposalMongoId: id })).kind, "invalid_external_id");
  assert.equal(called, false);
});

test("proposal synchronization delegates one atomic reference and outbox operation", async () => {
  let received;
  const sync = createSynchronizeProposalReference({ upsertWithOutbox: async (input) => { received = input; return { proposalReferenceId: "ref", outboxEventId: "event", referenceCreated: true, outboxCreated: true }; } });
  const input = { organizationMongoId: id, ownerUserMongoId: id, proposalMongoId: id, sourceChecksum: "a".repeat(64), correlationId: "c", eventType: "proposal.reference.updated" };
  assert.deepEqual(await sync(input), { kind: "synchronized", proposalReferenceId: "ref", outboxEventId: "event", referenceCreated: true, outboxCreated: true });
  assert.equal(received, input);
});
