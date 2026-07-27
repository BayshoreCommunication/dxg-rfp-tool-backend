require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MemoryAssistantLimitStore,
  assistantLimitKeys,
  createAssistantOperationalLimiter,
} = require("../src/modules/platformAssistant/operationalLimits");
const {
  PlatformAssistantError,
} = require("../src/modules/platformAssistant/domain");

const context = (actor = "bbbbbbbbbbbbbbbbbbbbbbbb") => ({
  organizationMongoId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  actorUserMongoId: actor,
  correlationId: "correlation-limit-test",
});

const baseConfig = {
  model: "test-model",
  maxInputTokens: 12000,
  maxOutputTokens: 1200,
  timeoutMs: 45000,
  heartbeatMs: 15000,
  providerMaxAttempts: 2,
  requestsPerWindow: 2,
  organizationRequestsPerWindow: 3,
  rateWindowMs: 15 * 60_000,
  maxActiveStreamsPerUser: 1,
  maxActiveStreamsPerOrganization: 2,
  activeLeaseMs: 120_000,
  reasoningEffort: "none",
  textVerbosity: "low",
};

test("limit keys contain only hashed user and organization identities", () => {
  const keys = assistantLimitKeys(context());
  for (const value of Object.values(keys)) {
    assert.doesNotMatch(value, /a{12}|b{12}/);
    assert.match(value, /^rfpilot:assistant:/);
  }
  assert.notEqual(keys.userRate, keys.organizationRate);
});

test("memory limiter enforces active user streams and releases idempotently", async () => {
  let now = 1_000;
  const limiter = createAssistantOperationalLimiter({
    redis: null,
    now: () => now,
    config: () => baseConfig,
  });
  const first = await limiter.acquire(context());
  await assert.rejects(
    limiter.acquire(context()),
    (error) =>
      error instanceof PlatformAssistantError &&
      error.code === "ASSISTANT_CONCURRENCY_LIMITED" &&
      error.status === 429 &&
      error.retryAfterSeconds === 120,
  );
  await first.release();
  await first.release();
  const second = await limiter.acquire(context());
  await second.release();
  now += 1;
});

test("successful acquisitions count against user and organization rate windows", async () => {
  const limiter = createAssistantOperationalLimiter({
    redis: null,
    now: () => 10_000,
    config: () => baseConfig,
  });
  const first = await limiter.acquire(context());
  await first.release();
  const second = await limiter.acquire(context());
  await second.release();
  await assert.rejects(
    limiter.acquire(context()),
    (error) =>
      error instanceof PlatformAssistantError &&
      error.code === "ASSISTANT_RATE_LIMITED" &&
      error.retryAfterSeconds === 900,
  );
});

test("organization concurrency is shared across different users", async () => {
  const limiter = createAssistantOperationalLimiter({
    redis: null,
    config: () => baseConfig,
  });
  const first = await limiter.acquire(context("bbbbbbbbbbbbbbbbbbbbbbbb"));
  const second = await limiter.acquire(context("cccccccccccccccccccccccc"));
  await assert.rejects(
    limiter.acquire(context("dddddddddddddddddddddddd")),
    (error) =>
      error instanceof PlatformAssistantError &&
      error.code === "ASSISTANT_CONCURRENCY_LIMITED",
  );
  await Promise.all([first.release(), second.release()]);
});

test("expired memory leases cannot block a later stream", async () => {
  let now = 1_000;
  const memory = new MemoryAssistantLimitStore();
  const limiter = createAssistantOperationalLimiter({
    redis: null,
    memory,
    now: () => now,
    config: () => ({ ...baseConfig, requestsPerWindow: 10 }),
  });
  await limiter.acquire(context());
  now += baseConfig.activeLeaseMs + 1;
  const replacement = await limiter.acquire(context());
  await replacement.release();
});

test("Redis path uses atomic scripts, opaque keys, and token-specific release", async () => {
  const calls = [];
  const redis = {
    status: "ready",
    async eval(...args) {
      calls.push(args);
      return calls.length === 1 ? ["ok", "0"] : 1;
    },
  };
  const limiter = createAssistantOperationalLimiter({
    redis,
    now: () => 2_000,
    config: () => baseConfig,
  });
  const lease = await limiter.acquire(context());
  await lease.release();
  await lease.release();

  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], 4);
  assert.ok(String(calls[0][0]).includes("ZREMRANGEBYSCORE"));
  assert.ok(String(calls[0][0]).includes("INCR"));
  assert.doesNotMatch(JSON.stringify(calls), /a{12}|b{12}/);
  assert.equal(calls[1][1], 2);
  assert.ok(String(calls[1][0]).includes("ZREM"));
  const acquireToken = calls[0].at(-1);
  const releaseToken = calls[1].at(-1);
  assert.equal(acquireToken, releaseToken);
});

test("Redis outage falls back to the bounded memory limiter", async () => {
  const limiter = createAssistantOperationalLimiter({
    redis: {
      status: "ready",
      async eval() {
        throw new Error("private Redis failure");
      },
    },
    config: () => baseConfig,
  });
  const lease = await limiter.acquire(context());
  await assert.rejects(
    limiter.acquire(context()),
    (error) =>
      error instanceof PlatformAssistantError &&
      error.code === "ASSISTANT_CONCURRENCY_LIMITED",
  );
  await lease.release();
});
