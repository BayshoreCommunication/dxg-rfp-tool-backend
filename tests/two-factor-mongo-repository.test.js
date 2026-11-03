require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");

const UserTwoFactor = require("../modal/userTwoFactorModel").default;
const { mongoTwoFactorRepository: repository } = require("../src/modules/twoFactor/infrastructure/mongo/mongoTwoFactorRepository");

const capture = (t, modifiedCount = 1) => {
  const calls = [];
  t.mock.method(UserTwoFactor, "updateOne", async (filter, update) => {
    calls.push({ filter, update });
    return { modifiedCount };
  });
  return calls;
};

test("an attempt is claimed only while unlocked and under the cap, in the same update that counts it", async (t) => {
  const calls = capture(t);
  const now = new Date("2026-11-03T00:00:00Z");
  assert.equal(await repository.claimAttempt({ userId: "u1", now, maxFailures: 10 }), true);
  assert.deepEqual(calls, [{
    filter: { userId: "u1", status: "enabled", failedAttempts: { $lt: 10 }, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
    update: { $inc: { failedAttempts: 1 } },
  }]);
});

test("a refused claim reports false", async (t) => {
  capture(t, 0);
  assert.equal(await repository.claimAttempt({ userId: "u1", now: new Date(), maxFailures: 10 }), false);
});

test("the lock is one pipeline update: matched only when the cap is spent, doubling per earlier lock, capped", async (t) => {
  const calls = capture(t);
  const now = new Date("2026-11-03T00:00:00Z");
  await repository.lockIfExhausted({ userId: "u1", now, maxFailures: 10, lockMs: 900_000, maxLockMs: 86_400_000 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].filter, { userId: "u1", failedAttempts: { $gte: 10 } });
  const lockCount = { $ifNull: ["$lockCount", 0] };
  assert.deepEqual(calls[0].update, [{
    $set: {
      lockedUntil: { $add: [now, { $min: [86_400_000, { $multiply: [900_000, { $pow: [2, lockCount] }] }] }] },
      lockCount: { $add: [lockCount, 1] },
      failedAttempts: 0,
    },
  }]);
});

test("a success clears the count, the lock and the escalation", async (t) => {
  const calls = capture(t);
  await repository.acceptStep({ userId: "u1", step: 5 });
  await repository.consumeRecoveryCode({ userId: "u1", hash: "h", now: new Date() });
  for (const { update } of calls) {
    assert.equal(update.$set.failedAttempts, 0);
    assert.equal(update.$set.lockedUntil, null);
    assert.equal(update.$set.lockCount, 0);
  }
});
