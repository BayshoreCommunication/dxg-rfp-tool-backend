require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { publicAccess } = require("../src/modules/publicAccess/composition");
const { requirePublicGrant } = require("../middleware/publicAccess");

const invoke = async ({ purpose = "vendor:submit", query = {}, body = {} } = {}) => {
  const response = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  let nextCalled = false;
  await requirePublicGrant(purpose)(
    {
      params: {},
      query: { proposalId: "proposal-1", accessGrant: "opaque-grant", ...query },
      body,
      headers: {},
    },
    response,
    () => { nextCalled = true; },
  );
  return { response, nextCalled };
};

test("dedicated vendor operations pass caller email and require recipient binding", async () => {
  const original = publicAccess.validateAndConsume;
  let captured;
  publicAccess.validateAndConsume = async (input) => {
    captured = input;
    return input.recipient === "vendor@example.com" ? { resourceId: "proposal-1" } : null;
  };

  try {
    const accepted = await invoke({ query: { email: "vendor@example.com" } });
    assert.equal(accepted.nextCalled, true);
    assert.equal(captured.recipient, "vendor@example.com");
    assert.equal(captured.allowRecipientlessVendorProposalRead, false);

    const rejected = await invoke({ query: { email: "attacker@example.com" } });
    assert.equal(rejected.nextCalled, false);
    assert.equal(rejected.response.statusCode, 403);
  } finally {
    publicAccess.validateAndConsume = original;
  }
});

test("read-only proposal route keeps vendor invites usable before email entry", async () => {
  const original = publicAccess.validateAndConsume;
  const calls = [];
  publicAccess.validateAndConsume = async (input) => {
    calls.push(input);
    return input.purpose === "vendor:submit" && input.allowRecipientlessVendorProposalRead === true
      ? { resourceId: "proposal-1" }
      : null;
  };

  try {
    const result = await invoke({ purpose: ["proposal:view", "vendor:submit"] });
    assert.equal(result.nextCalled, true);
    assert.deepEqual(calls.map(({ purpose, allowRecipientlessVendorProposalRead }) => ({ purpose, allowRecipientlessVendorProposalRead })), [
      { purpose: "proposal:view", allowRecipientlessVendorProposalRead: true },
      { purpose: "vendor:submit", allowRecipientlessVendorProposalRead: true },
    ]);
  } finally {
    publicAccess.validateAndConsume = original;
  }
});
