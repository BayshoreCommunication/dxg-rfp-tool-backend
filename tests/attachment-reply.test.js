const test = require("node:test");
const assert = require("node:assert/strict");
const { attachmentReceiptReply } = require("../src/modules/conversations/attachmentReply");

test("ordinary conversation still uses the normal AI reply", () => {
  assert.equal(attachmentReceiptReply([]), null);
});

test("a brief gets a conversational acknowledgement without invented extraction or a premature question", () => {
  for (const sourceStatus of ["uploaded", "scanning", "ready", null]) {
    const reply = attachmentReceiptReply([{ sourceStatus }]);
    assert.match(reply, /received your brief/);
    assert.match(reply, /review what I found/);
    assert.doesNotMatch(reply, /underway|Untitled|next question|read your brief|extraction succeeded|readiness check/i);
  }
});

test("failed and blocked file checks never claim their contents are being read", () => {
  assert.match(attachmentReceiptReply([{ sourceStatus: "scan_failed" }]), /haven’t read its contents/);
  assert.match(attachmentReceiptReply([{ sourceStatus: "failed" }]), /recovery options/);
  assert.match(attachmentReceiptReply([{ sourceStatus: "ready" }, { sourceStatus: "blocked" }]), /security checks/);
});
