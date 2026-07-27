require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ASSISTANT_MESSAGE_MAX_LENGTH,
  PlatformAssistantError,
  assertPlatformAssistantAvailable,
  assertPlatformAssistantEnabled,
  assertPlatformAssistantOrganizationAvailable,
  assertPlatformAssistantOrganizationEnabled,
  canTransitionAssistantMessage,
  parseAssistantBeforeOrdinal,
  parseAssistantIdempotencyKey,
  parseAssistantListLimit,
  parseAssistantMessageInput,
  parseAssistantThreadId,
  parseCreateAssistantThreadInput,
  platformAssistantEnabled,
  platformAssistantEnabledForOrganization,
  platformAssistantKilled,
} = require("../src/modules/platformAssistant/domain");

const withEnv = (overrides, fn) => {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("assistant flags deny by default and require an authorized AI environment", () => {
  withEnv({
    NODE_ENV: "production",
    AI_ENVIRONMENT: undefined,
    AI_ASSISTANT_ENABLED: "true",
    AI_ASSISTANT_KILL_SWITCH: "false",
    LIVE_AI_KILL_SWITCH: "false",
  }, () => {
    assert.equal(platformAssistantEnabled(), false);
  });

  withEnv({
    NODE_ENV: "production",
    AI_ENVIRONMENT: "staging",
    AI_ASSISTANT_ENABLED: "true",
    AI_ASSISTANT_KILL_SWITCH: "false",
    LIVE_AI_KILL_SWITCH: "false",
  }, () => {
    assert.equal(platformAssistantEnabled(), true);
    assert.equal(platformAssistantKilled(), false);
    assert.doesNotThrow(assertPlatformAssistantAvailable);
  });
});

test("assistant-specific and global kill switches fail closed", () => {
  for (const overrides of [
    { AI_ASSISTANT_KILL_SWITCH: undefined, LIVE_AI_KILL_SWITCH: "false" },
    { AI_ASSISTANT_KILL_SWITCH: "true", LIVE_AI_KILL_SWITCH: "false" },
    { AI_ASSISTANT_KILL_SWITCH: "false", LIVE_AI_KILL_SWITCH: "true" },
  ]) {
    withEnv({
      NODE_ENV: "production",
      AI_ENVIRONMENT: "staging",
      AI_ASSISTANT_ENABLED: "true",
      ...overrides,
    }, () => {
      assert.equal(platformAssistantKilled(), true);
      assert.throws(
        assertPlatformAssistantAvailable,
        (error) => error instanceof PlatformAssistantError && error.code === "AI_ASSISTANT_KILLED",
      );
    });
  }
});

test("provider kill switches preserve enabled read-only access", () => {
  withEnv({
    NODE_ENV: "production",
    AI_ENVIRONMENT: "staging",
    AI_ASSISTANT_ENABLED: "true",
    AI_ASSISTANT_KILL_SWITCH: "true",
    LIVE_AI_KILL_SWITCH: "false",
  }, () => {
    assert.equal(platformAssistantEnabled(), true);
    assert.doesNotThrow(assertPlatformAssistantEnabled);
    assert.throws(
      assertPlatformAssistantAvailable,
      (error) => error instanceof PlatformAssistantError && error.code === "AI_ASSISTANT_KILLED",
    );
  });
});

test("production organization access is deny-by-default and supports explicit cohorts", () => {
  const base = {
    NODE_ENV: "production",
    AI_ENVIRONMENT: "production",
    AI_ASSISTANT_ENABLED: "true",
    AI_ASSISTANT_KILL_SWITCH: "false",
    LIVE_AI_KILL_SWITCH: "false",
  };
  const allowedOrganization = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const otherOrganization = "bbbbbbbbbbbbbbbbbbbbbbbb";

  withEnv({
    ...base,
    AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS: undefined,
  }, () => {
    assert.equal(
      platformAssistantEnabledForOrganization(allowedOrganization),
      false,
    );
    assert.throws(
      () => assertPlatformAssistantOrganizationEnabled(allowedOrganization),
      (error) =>
        error instanceof PlatformAssistantError &&
        error.code === "AI_ASSISTANT_ORGANIZATION_NOT_ENABLED" &&
        error.status === 403,
    );
  });

  withEnv({
    ...base,
    AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS:
      ` ${allowedOrganization.toUpperCase()} `,
  }, () => {
    assert.equal(
      platformAssistantEnabledForOrganization(allowedOrganization),
      true,
    );
    assert.equal(
      platformAssistantEnabledForOrganization(otherOrganization),
      false,
    );
    assert.doesNotThrow(() =>
      assertPlatformAssistantOrganizationAvailable(allowedOrganization));
  });

  withEnv({
    ...base,
    AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS: "*",
  }, () => {
    assert.equal(
      platformAssistantEnabledForOrganization(otherOrganization),
      true,
    );
  });
});

test("invalid or ambiguous production organization allowlists fail closed", () => {
  const organizationId = "aaaaaaaaaaaaaaaaaaaaaaaa";
  for (const configured of [
    "not-an-organization",
    `*,${organizationId}`,
    `${organizationId},broken`,
  ]) {
    withEnv({
      NODE_ENV: "production",
      AI_ENVIRONMENT: "production",
      AI_ASSISTANT_ENABLED: "true",
      AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS: configured,
      AI_ASSISTANT_KILL_SWITCH: "false",
      LIVE_AI_KILL_SWITCH: "false",
    }, () => {
      assert.equal(
        platformAssistantEnabledForOrganization(organizationId),
        false,
      );
    });
  }
});

test("non-production environments preserve global test and staging access unless a cohort is configured", () => {
  const organizationId = "aaaaaaaaaaaaaaaaaaaaaaaa";
  withEnv({
    NODE_ENV: "production",
    AI_ENVIRONMENT: "staging",
    AI_ASSISTANT_ENABLED: "true",
    AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS: undefined,
    AI_ASSISTANT_KILL_SWITCH: "false",
    LIVE_AI_KILL_SWITCH: "false",
  }, () => {
    assert.equal(
      platformAssistantEnabledForOrganization(organizationId),
      true,
    );
  });

  withEnv({
    NODE_ENV: "production",
    AI_ENVIRONMENT: "staging",
    AI_ASSISTANT_ENABLED: "true",
    AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS: "bbbbbbbbbbbbbbbbbbbbbbbb",
    AI_ASSISTANT_KILL_SWITCH: "false",
    LIVE_AI_KILL_SWITCH: "false",
  }, () => {
    assert.equal(
      platformAssistantEnabledForOrganization(organizationId),
      false,
    );
  });
});

test("thread and message input contracts normalize safe values and enforce bounds", () => {
  assert.deepEqual(parseCreateAssistantThreadInput({}), { title: "New conversation" });
  assert.deepEqual(
    parseCreateAssistantThreadInput({ title: "  Event   workflow help  " }),
    { title: "Event workflow help" },
  );
  assert.throws(
    () => parseCreateAssistantThreadInput({ title: "x".repeat(201) }),
    (error) => error.code === "INVALID_ASSISTANT_THREAD",
  );

  assert.deepEqual(
    parseAssistantMessageInput({ content: "  How do proposals work?  " }),
    { content: "How do proposals work?" },
  );
  assert.throws(
    () => parseAssistantMessageInput({ content: "   " }),
    (error) => error.code === "INVALID_ASSISTANT_MESSAGE",
  );
  assert.throws(
    () => parseAssistantMessageInput({ content: "x".repeat(ASSISTANT_MESSAGE_MAX_LENGTH + 1) }),
    (error) => error.code === "ASSISTANT_MESSAGE_TOO_LARGE" && error.status === 413,
  );
});

test("IDs, idempotency keys, and pagination are bounded", () => {
  const id = "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e6f";
  assert.equal(parseAssistantThreadId(id), id);
  assert.throws(
    () => parseAssistantThreadId("not-a-thread"),
    (error) => error.code === "ASSISTANT_THREAD_NOT_FOUND" && error.status === 404,
  );
  assert.equal(parseAssistantIdempotencyKey(" request-1 "), "request-1");
  assert.throws(
    () => parseAssistantIdempotencyKey(""),
    (error) => error.code === "ASSISTANT_IDEMPOTENCY_KEY_REQUIRED",
  );
  assert.equal(parseAssistantListLimit(undefined, 100, 25), 25);
  assert.equal(parseAssistantListLimit("50", 100, 25), 50);
  assert.throws(
    () => parseAssistantListLimit(101, 100, 25),
    (error) => error.code === "INVALID_ASSISTANT_PAGINATION",
  );
  assert.equal(parseAssistantBeforeOrdinal(undefined), null);
  assert.equal(parseAssistantBeforeOrdinal("12"), 12);
  assert.throws(
    () => parseAssistantBeforeOrdinal(1),
    (error) => error.code === "INVALID_ASSISTANT_PAGINATION",
  );
});

test("assistant message lifecycle permits only forward terminal transitions", () => {
  assert.equal(canTransitionAssistantMessage("pending", "streaming"), true);
  assert.equal(canTransitionAssistantMessage("pending", "complete"), true);
  assert.equal(canTransitionAssistantMessage("streaming", "failed"), true);
  assert.equal(canTransitionAssistantMessage("streaming", "streaming"), true);
  assert.equal(canTransitionAssistantMessage("complete", "complete"), false);
  assert.equal(canTransitionAssistantMessage("complete", "streaming"), false);
  assert.equal(canTransitionAssistantMessage("failed", "pending"), false);
  assert.equal(canTransitionAssistantMessage("aborted", "complete"), false);
});
