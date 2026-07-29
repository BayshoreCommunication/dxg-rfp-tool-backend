const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Proposal = require("../modal/proposalsModel").default;

const CONTACT_PATHS = [
  "contact.contactFirstName",
  "contact.contactLastName",
  "contact.contactEmail",
  "contact.contactPhone",
];

// Runs the schema's own conditional-required validator with an explicit `this`,
// mirroring how Mongoose binds document context (save) and query context
// (findOneAndUpdate with runValidators + context:"query").
const validateWithScope = (schemaPath, scope) =>
  new Promise((resolve) => {
    Proposal.schema.path(schemaPath).doValidate("", (error) => resolve(error ?? null), scope);
  });

test("draft saves do not require contact details in query context", async () => {
  for (const schemaPath of CONTACT_PATHS) {
    // A draft save sends status/isDraft but must stay writable without contact.
    const draftUpdate = { getUpdate: () => ({ $set: { status: "unsubmitted", isDraft: true } }) };
    assert.equal(await validateWithScope(schemaPath, draftUpdate), null, `${schemaPath} blocked a draft save`);

    // A partial field update carries no lifecycle change and must not block.
    const partialUpdate = { getUpdate: () => ({ $set: { event: { eventName: "Momentum" } } }) };
    assert.equal(await validateWithScope(schemaPath, partialUpdate), null, `${schemaPath} blocked a partial update`);
  }
});

test("submitting through an update still requires contact details", async () => {
  for (const schemaPath of CONTACT_PATHS) {
    const submitUpdate = { getUpdate: () => ({ $set: { status: "submitted", isDraft: false } }) };
    assert.notEqual(await validateWithScope(schemaPath, submitUpdate), null, `${schemaPath} skipped submit validation`);
  }
});

test("document context keeps the original draft rule", async () => {
  for (const schemaPath of CONTACT_PATHS) {
    assert.equal(
      await validateWithScope(schemaPath, { isDraft: true, status: "unsubmitted" }),
      null,
      `${schemaPath} blocked a contactless draft document`,
    );
    assert.notEqual(
      await validateWithScope(schemaPath, { isDraft: false, status: "submitted" }),
      null,
      `${schemaPath} skipped a submitted document`,
    );
  }
});

test("owned proposal updates opt into query-context validators", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "src/modules/proposals/infrastructure/mongo/mongoProposalWriteRepository.ts"),
    "utf8",
  );
  const updateBlock = source.slice(source.indexOf("async updateOwnedById"), source.indexOf("async incrementOwnedViews"));
  assert.match(updateBlock, /runValidators:\s*true/, "updateOwnedById no longer runs validators");
  assert.match(updateBlock, /context:\s*"query"/, "runValidators without context:\"query\" hides the pending update");
});
