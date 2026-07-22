const test = require("node:test"),
  assert = require("node:assert/strict");
const Proposal = require("../modal/proposalsModel").default;

test("unsubmitted drafts do not require contact details (lazy assisted creation)", () => {
  const draft = new Proposal({ event: { eventName: "Untitled proposal" }, status: "unsubmitted", isDraft: true });
  assert.equal(draft.validateSync(), undefined);
});

test("submitting still enforces the four contact fields", () => {
  const submitted = new Proposal({ event: { eventName: "X" }, status: "submitted", isDraft: false });
  const errors = submitted.validateSync();
  assert.ok(errors);
  assert.deepEqual(Object.keys(errors.errors).sort(), [
    "contact.contactEmail",
    "contact.contactFirstName",
    "contact.contactLastName",
    "contact.contactPhone",
  ]);
});

test("a non-draft unsubmitted proposal also requires contact details", () => {
  const proposal = new Proposal({ event: { eventName: "X" }, status: "unsubmitted", isDraft: false });
  assert.ok(proposal.validateSync());
});
