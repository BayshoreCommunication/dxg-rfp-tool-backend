const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  approvalInput,
  decisionInput,
  independentApprovalRequired,
  KnowledgeReviewError,
  reviewDates,
  submissionDecision,
} = require("../src/modules/knowledgeReview/domain");
test("accepted fragments need no reason", () =>
  assert.deepEqual(decisionInput({ decision: "accepted" }), {
    decision: "accepted",
    reason: null,
  }));
test("unreviewed fragments default to accepted when the review is submitted", () => {
  assert.equal(submissionDecision(null), "accepted");
  assert.equal(submissionDecision("rejected"), "rejected");
  assert.equal(submissionDecision("flagged"), "flagged");
});
test("rejected and flagged fragments require a bounded reason", () => {
  for (const decision of ["rejected", "flagged"]) {
    assert.throws(
      () => decisionInput({ decision, reason: "" }),
      KnowledgeReviewError,
    );
    assert.deepEqual(
      decisionInput({ decision, reason: " source is obsolete " }),
      { decision, reason: "source is obsolete" },
    );
  }
});
test("approval rejection requires a reason", () => {
  assert.throws(() => approvalInput({}, "rejected"), KnowledgeReviewError);
  assert.deepEqual(
    approvalInput({ reason: "Incorrect effective dates" }, "rejected"),
    { reason: "Incorrect effective dates" },
  );
});
test("review expiry must follow effective time", () => {
  assert.throws(
    () => reviewDates({ effectiveAt: "2026-08-02", expiresAt: "2026-08-01" }),
    KnowledgeReviewError,
  );
  const dates = reviewDates({
    effectiveAt: "2026-08-01",
    expiresAt: "2027-08-01",
  });
  assert.ok(dates.effectiveAt instanceof Date);
  assert.ok(dates.expiresAt instanceof Date);
});
test("same-admin approval is the interim default and independent approval can be enabled later", () => {
  const previous = process.env.KNOWLEDGE_INDEPENDENT_APPROVAL_REQUIRED;
  delete process.env.KNOWLEDGE_INDEPENDENT_APPROVAL_REQUIRED;
  assert.equal(independentApprovalRequired(), false);
  process.env.KNOWLEDGE_INDEPENDENT_APPROVAL_REQUIRED = "true";
  assert.equal(independentApprovalRequired(), true);
  if (previous === undefined)
    delete process.env.KNOWLEDGE_INDEPENDENT_APPROVAL_REQUIRED;
  else process.env.KNOWLEDGE_INDEPENDENT_APPROVAL_REQUIRED = previous;
});
