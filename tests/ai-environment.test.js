const test = require("node:test"),
  assert = require("node:assert/strict");
const { aiEnvironment, aiRuntimeAuthorized } = require("../config/aiEnvironment");
const { contextEnabled } = require("../src/modules/proposalContext/domain");

const withEnv = (overrides, fn) => {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
};

test("unset AI_ENVIRONMENT preserves the historical NODE_ENV test fallback", () => {
  withEnv({ AI_ENVIRONMENT: undefined, NODE_ENV: "test" }, () => {
    assert.equal(aiEnvironment(), "test");
    assert.equal(aiRuntimeAuthorized(), true);
  });
  withEnv({ AI_ENVIRONMENT: undefined, NODE_ENV: "production" }, () => {
    assert.equal(aiEnvironment(), "");
    assert.equal(aiRuntimeAuthorized(), false);
  });
});

test("AI_ENVIRONMENT authorizes the governed surface outside NODE_ENV test", () => {
  withEnv({ AI_ENVIRONMENT: "staging", NODE_ENV: "production", PROPOSAL_CONTEXT_ENABLED: "true" }, () => {
    assert.equal(aiEnvironment(), "staging");
    assert.equal(contextEnabled(), true);
  });
  withEnv({ AI_ENVIRONMENT: "production", NODE_ENV: "production", PROPOSAL_CONTEXT_ENABLED: "true" }, () => {
    assert.equal(contextEnabled(), true);
  });
});

test("invalid AI_ENVIRONMENT values fail closed", () => {
  withEnv({ AI_ENVIRONMENT: "prod", NODE_ENV: "production", PROPOSAL_CONTEXT_ENABLED: "true" }, () => {
    assert.equal(aiEnvironment(), "");
    assert.equal(contextEnabled(), false);
  });
});

test("feature flags still gate on top of environment authorization", () => {
  withEnv({ AI_ENVIRONMENT: "staging", NODE_ENV: "production", PROPOSAL_CONTEXT_ENABLED: undefined }, () => {
    assert.equal(contextEnabled(), false);
  });
});
