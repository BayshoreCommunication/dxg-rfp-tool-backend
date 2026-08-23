const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createEnsureConversationProposalReference,
  createWithConversationProposalReference,
} = require("../src/modules/conversations/conversationProposalReference");
const {
  ConversationError,
} = require("../src/modules/conversations/domain");

const root = path.join(__dirname, "..");
const id = "6a58a2d07dac2b57c12d5247";
const ctx = {
  organizationMongoId: id,
  actorUserMongoId: "6a58a2d07dac2b57c12d5248",
  correlationId: "corr-reference",
};

test("missing conversation reference is repaired once before retrying the operation", async () => {
  let attempts = 0;
  let repairs = 0;
  const run = createWithConversationProposalReference(async (
    received,
    proposalMongoId,
  ) => {
    repairs += 1;
    assert.equal(received, ctx);
    assert.equal(proposalMongoId, id);
  });

  const result = await run(ctx, id, async () => {
    attempts += 1;
    if (attempts === 1)
      throw new ConversationError(
        "PROPOSAL_NOT_FOUND",
        "Proposal was not found.",
        404,
      );
    return "ready";
  });

  assert.equal(result, "ready");
  assert.equal(attempts, 2);
  assert.equal(repairs, 1);
});

test("non-reference errors are returned without a repair or retry", async () => {
  let attempts = 0;
  let repairs = 0;
  const run = createWithConversationProposalReference(async () => {
    repairs += 1;
  });
  const denied = new ConversationError(
    "AUTHORIZATION_DENIED",
    "Permission denied.",
    403,
  );

  await assert.rejects(
    () =>
      run(ctx, id, async () => {
        attempts += 1;
        throw denied;
      }),
    denied,
  );
  assert.equal(attempts, 1);
  assert.equal(repairs, 0);
});

test("reference repair revalidates ownership and synchronizes the active fingerprint", async () => {
  let synchronized;
  const updatedAt = new Date("2026-07-29T10:00:00.000Z");
  const ensure = createEnsureConversationProposalReference({
    findOwnedProposal: async (received, proposalMongoId) => {
      assert.equal(received, ctx);
      assert.equal(proposalMongoId, id);
      return { _id: id, version: 9, updatedAt };
    },
    synchronize: async input => {
      synchronized = input;
      return {
        kind: "synchronized",
        proposalReferenceId: "reference",
        outboxEventId: "event",
        referenceCreated: true,
        outboxCreated: true,
      };
    },
  });

  await ensure(ctx, id);
  assert.equal(synchronized.organizationMongoId, ctx.organizationMongoId);
  assert.equal(synchronized.ownerUserMongoId, ctx.actorUserMongoId);
  assert.equal(synchronized.proposalMongoId, id);
  assert.equal(synchronized.sourceVersion, synchronized.sourceChecksum);
  assert.match(synchronized.sourceChecksum, /^[0-9a-f]{64}$/);
  assert.equal(synchronized.sourceUpdatedAt, undefined);
  assert.equal(synchronized.correlationId, ctx.correlationId);
  assert.equal(synchronized.eventType, "proposal.reference.backfilled");
  assert.equal(JSON.stringify(synchronized).includes("proposal content"), false);
});

test("reference repair ignores dormant writes but detects room recording changes", async () => {
  let proposal = {
    _id: id,
    __v: 1,
    updatedAt: new Date("2026-01-01"),
    status: "unsubmitted",
    event: { eventName: "Summit" },
    videoRecordingStep: { numberOfCameras: "3" },
    roomByRoom: [{ videoRecording: { videoRecording: "No" } }],
  };
  const synchronized = [];
  const ensure = createEnsureConversationProposalReference({
    findOwnedProposal: async () => proposal,
    synchronize: async input => {
      synchronized.push(input);
      return {
        kind: "synchronized",
        proposalReferenceId: "reference",
        outboxEventId: "event",
        referenceCreated: false,
        outboxCreated: false,
      };
    },
  });

  await ensure(ctx, id);
  proposal = {
    ...proposal,
    __v: 2,
    updatedAt: new Date("2026-02-01"),
    videoRecordingStep: { numberOfCameras: "99" },
  };
  await ensure(ctx, id);
  proposal = {
    ...proposal,
    roomByRoom: [{ videoRecording: { videoRecording: "Yes" } }],
  };
  await ensure(ctx, id);

  assert.equal(synchronized[0].sourceChecksum, synchronized[1].sourceChecksum);
  assert.notEqual(synchronized[1].sourceChecksum, synchronized[2].sourceChecksum);
  assert.equal(synchronized.every(input => input.sourceVersion === input.sourceChecksum), true);
});

test("missing or differently owned Mongo proposal remains not found", async () => {
  let synchronized = false;
  const ensure = createEnsureConversationProposalReference({
    findOwnedProposal: async () => null,
    synchronize: async () => {
      synchronized = true;
      throw new Error("must not synchronize");
    },
  });

  await assert.rejects(
    () => ensure(ctx, id),
    error =>
      error instanceof ConversationError &&
      error.code === "PROPOSAL_NOT_FOUND" &&
      error.status === 404,
  );
  assert.equal(synchronized, false);
});

test("conversation endpoints use the lazy repair wrapper", () => {
  const source = fs.readFileSync(
    path.join(root, "controller/conversationsController.ts"),
    "utf8",
  );
  assert.ok(source.includes("withConversationProposalReference"));
  assert.ok(
    source.match(/withConversationProposalReference/g).length >= 6,
    "read, send intents, question operations, and SSE must be repairable",
  );
  const repair = fs.readFileSync(
    path.join(
      root,
      "src/modules/conversations/conversationProposalReference.ts",
    ),
    "utf8",
  );
  for (const guard of [
    "userId: ctx.actorUserMongoId",
    "organizationId: ctx.organizationMongoId",
    "isArchived: { $ne: true }",
    "activeProposalWorkflowFingerprintContent(proposal)",
  ])
    assert.ok(repair.includes(guard), guard);
  assert.equal(
    repair.includes("isActive: { $ne: false }"),
    false,
    "unsubmitted offline drafts must remain available to their owner",
  );
  assert.equal(repair.includes("sourceVersion: checksum"), true);
  assert.equal(repair.includes("sourceChecksum: checksum"), true);
  assert.equal(repair.includes("sourceUpdatedAt:"), false);
});
