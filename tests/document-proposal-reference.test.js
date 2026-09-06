const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createWithDocumentProposalReference,
} = require("../src/modules/documentIngestion/proposalReference");
const {
  DocumentIngestionError,
} = require("../src/modules/documentIngestion/domain");
const {
  ConversationError,
} = require("../src/modules/conversations/domain");

const proposalId = "6a58a2d07dac2b57c12d5247";
const ctx = {
  organizationMongoId: "6a58a2d07dac2b57c12d5240",
  userMongoId: "6a58a2d07dac2b57c12d5248",
  correlationId: "corr-document-reference",
};
const missingReference = () =>
  new DocumentIngestionError("PROPOSAL_NOT_FOUND", "Proposal reference is unavailable.", 404);

test("a missing proposal reference is repaired once and the upload session is retried", async () => {
  let attempts = 0;
  const repairs = [];
  const run = createWithDocumentProposalReference(async (received, proposalMongoId) => {
    repairs.push({ received, proposalMongoId });
  });

  const result = await run(ctx, proposalId, async () => {
    attempts += 1;
    if (attempts === 1) throw missingReference();
    return "session";
  });

  assert.equal(result, "session");
  assert.equal(attempts, 2);
  assert.equal(repairs.length, 1);
  // The repair runs as the requesting user so ownership is re-validated.
  assert.deepEqual(repairs[0].received, {
    organizationMongoId: ctx.organizationMongoId,
    actorUserMongoId: ctx.userMongoId,
    correlationId: ctx.correlationId,
  });
  assert.equal(repairs[0].proposalMongoId, proposalId);
});

test("other ingestion errors pass through without a repair or retry", async () => {
  let attempts = 0;
  let repairs = 0;
  const run = createWithDocumentProposalReference(async () => {
    repairs += 1;
  });
  const tooLarge = new DocumentIngestionError("FILE_SIZE_INVALID", "Too large.", 413);

  await assert.rejects(
    () =>
      run(ctx, proposalId, async () => {
        attempts += 1;
        throw tooLarge;
      }),
    tooLarge,
  );
  assert.equal(attempts, 1);
  assert.equal(repairs, 0);
});

test("a repair that cannot find the owned proposal keeps the original 404", async () => {
  let attempts = 0;
  const original = missingReference();
  const run = createWithDocumentProposalReference(async () => {
    throw new ConversationError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  });

  await assert.rejects(
    () =>
      run(ctx, proposalId, async () => {
        attempts += 1;
        throw original;
      }),
    original,
  );
  assert.equal(attempts, 1);
});

test("a repair blocked by the data foundation reports ORGANIZATION_NOT_READY as 503", async () => {
  let attempts = 0;
  const run = createWithDocumentProposalReference(async () => {
    throw new ConversationError("ORGANIZATION_NOT_READY", "Organization data foundation is unavailable.", 503);
  });

  await assert.rejects(
    () =>
      run(ctx, proposalId, async () => {
        attempts += 1;
        throw missingReference();
      }),
    error =>
      error instanceof DocumentIngestionError &&
      error.code === "ORGANIZATION_NOT_READY" &&
      error.status === 503,
  );
  assert.equal(attempts, 1);
});

test("a second failure after the repair is returned as-is", async () => {
  let attempts = 0;
  const run = createWithDocumentProposalReference(async () => {});

  await assert.rejects(
    () =>
      run(ctx, proposalId, async () => {
        attempts += 1;
        throw missingReference();
      }),
    error => error instanceof DocumentIngestionError && error.code === "PROPOSAL_NOT_FOUND",
  );
  assert.equal(attempts, 2);
});
