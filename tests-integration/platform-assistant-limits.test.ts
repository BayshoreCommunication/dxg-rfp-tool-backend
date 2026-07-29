import { TEST_REDIS_URL } from "./env";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import Redis from "ioredis";
import {
  assistantLimitKeys,
  createAssistantOperationalLimiter,
} from "../src/modules/platformAssistant/operationalLimits";
import { PlatformAssistantError } from "../src/modules/platformAssistant/domain";
import type { AssistantRuntimeConfig } from "../src/modules/platformAssistant/config";

const assistantTestRedisUrl =
  process.env.ASSISTANT_TEST_REDIS_URL ?? TEST_REDIS_URL;
const redis = new Redis(assistantTestRedisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  lazyConnect: true,
});
redis.on("error", () => undefined);

const adapter = {
  get status() {
    return redis.status;
  },
  connect: () => redis.connect(),
  eval(
    script: string,
    keyCount: number,
    ...arguments_: Array<string | number>
  ) {
    return redis.eval(script, keyCount, ...arguments_);
  },
};

const config: AssistantRuntimeConfig = {
  model: "integration-model",
  maxInputTokens: 12_000,
  maxOutputTokens: 1_200,
  timeoutMs: 45_000,
  heartbeatMs: 15_000,
  providerMaxAttempts: 2,
  requestsPerWindow: 2,
  organizationRequestsPerWindow: 4,
  rateWindowMs: 60_000,
  maxActiveStreamsPerUser: 1,
  maxActiveStreamsPerOrganization: 2,
  activeLeaseMs: 30_000,
  reasoningEffort: "none",
  textVerbosity: "low",
};

const context = (
  organizationMongoId = crypto.randomBytes(12).toString("hex"),
  actorUserMongoId = crypto.randomBytes(12).toString("hex"),
) => ({
  organizationMongoId,
  actorUserMongoId,
  correlationId: crypto.randomUUID(),
});
const keysToDelete = new Set<string>();
const track = (value: ReturnType<typeof assistantLimitKeys>) => {
  for (const key of Object.values(value)) keysToDelete.add(key);
};

before(async () => {
  if (redis.status === "wait") await redis.connect();
  assert.equal(await redis.ping(), "PONG");
});

after(async () => {
  if (keysToDelete.size) await redis.del(...keysToDelete);
  await redis.quit();
});

test("real Redis enforces and releases a user concurrency lease", async () => {
  const ctx = context();
  track(assistantLimitKeys(ctx));
  const limiter = createAssistantOperationalLimiter({
    redis: adapter,
    config: () => config,
  });
  const first = await limiter.acquire(ctx);
  await assert.rejects(
    limiter.acquire(ctx),
    (error: unknown) =>
      error instanceof PlatformAssistantError &&
      error.code === "ASSISTANT_CONCURRENCY_LIMITED" &&
      error.retryAfterSeconds === 30,
  );
  await first.release();
  const second = await limiter.acquire(ctx);
  await second.release();
  assert.equal(await redis.zcard(assistantLimitKeys(ctx).userActive), 0);
});

test("real Redis rate window survives lease release", async () => {
  const ctx = context();
  track(assistantLimitKeys(ctx));
  const limiter = createAssistantOperationalLimiter({
    redis: adapter,
    config: () => config,
  });
  const first = await limiter.acquire(ctx);
  await first.release();
  const second = await limiter.acquire(ctx);
  await second.release();
  await assert.rejects(
    limiter.acquire(ctx),
    (error: unknown) =>
      error instanceof PlatformAssistantError &&
      error.code === "ASSISTANT_RATE_LIMITED" &&
      (error.retryAfterSeconds ?? 0) > 0,
  );
  assert.equal(await redis.get(assistantLimitKeys(ctx).userRate), "2");
});

test("real Redis organization concurrency is shared across users", async () => {
  const organizationMongoId = crypto.randomBytes(12).toString("hex");
  const firstContext = context(organizationMongoId);
  const secondContext = context(organizationMongoId);
  const thirdContext = context(organizationMongoId);
  for (const value of [firstContext, secondContext, thirdContext]) {
    track(assistantLimitKeys(value));
  }
  const limiter = createAssistantOperationalLimiter({
    redis: adapter,
    config: () => ({ ...config, requestsPerWindow: 10 }),
  });
  const first = await limiter.acquire(firstContext);
  const second = await limiter.acquire(secondContext);
  await assert.rejects(
    limiter.acquire(thirdContext),
    (error: unknown) =>
      error instanceof PlatformAssistantError &&
      error.code === "ASSISTANT_CONCURRENCY_LIMITED",
  );
  await Promise.all([first.release(), second.release()]);
  assert.equal(
    await redis.zcard(
      assistantLimitKeys(firstContext).organizationActive,
    ),
    0,
  );
});
