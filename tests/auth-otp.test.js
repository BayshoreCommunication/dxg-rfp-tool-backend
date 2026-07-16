const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createRequestOtp,
  createVerifyOtp,
} = require("../src/modules/auth/application/manageOtp");

test("signup OTP rejects an existing account before generating or storing a code", async () => {
  let generated = 0;
  let writes = 0;
  const request = createRequestOtp({
    users: { async emailExists() { return true; } },
    otps: { async replace() { writes += 1; } },
    delivery: { async send() {} },
    generator: { generate() { generated += 1; return "123456"; } },
  });
  assert.deepEqual(await request("used@example.com", "signup"), { kind: "account_exists" });
  assert.equal(generated, 0);
  assert.equal(writes, 0);
});

test("forgot-password OTP conceals a missing account without side effects", async () => {
  let sideEffects = 0;
  const request = createRequestOtp({
    users: { async emailExists() { return false; } },
    otps: { async replace() { sideEffects += 1; } },
    delivery: { async send() { sideEffects += 1; } },
    generator: { generate() { sideEffects += 1; return "123456"; } },
  });
  assert.deepEqual(await request("missing@example.com", "forgot-password"), {
    kind: "concealed_missing",
  });
  assert.equal(sideEffects, 0);
});

test("OTP request replaces the challenge before delivery", async () => {
  const events = [];
  const request = createRequestOtp({
    users: { async emailExists() { return false; } },
    otps: {
      async replace(email, purpose, code) { events.push(["replace", email, purpose, code]); },
      async deleteFor() {},
    },
    delivery: { async send(email, code, purpose) { events.push(["send", email, purpose, code]); } },
    generator: { generate() { return "654321"; } },
  });
  assert.deepEqual(await request("new@example.com", "signup"), { kind: "sent" });
  assert.deepEqual(events, [
    ["replace", "new@example.com", "signup", "654321"],
    ["send", "new@example.com", "signup", "654321"],
  ]);
});

test("failed OTP delivery removes the undelivered challenge", async () => {
  let removed;
  const request = createRequestOtp({
    users: { async emailExists() { return false; } },
    otps: {
      async replace() {},
      async deleteFor(email, purpose) { removed = { email, purpose }; },
    },
    delivery: { async send() { throw new Error("provider down"); } },
    generator: { generate() { return "123456"; } },
  });
  await assert.rejects(request("new@example.com", "signup"), /provider down/);
  assert.deepEqual(removed, { email: "new@example.com", purpose: "signup" });
});

test("expired OTP is deleted and never marked verified", async () => {
  let deleted;
  let verified = false;
  const verify = createVerifyOtp({
    async findPending() {
      return { id: "otp-1", code: "123456", expiresAt: new Date("2026-01-01T00:00:00Z") };
    },
    async deleteById(id) { deleted = id; },
    async markVerified() { verified = true; },
  }, { now: () => new Date("2026-01-01T00:00:01Z") });
  assert.deepEqual(await verify("a@b.com", "123456", "signup"), { kind: "expired" });
  assert.equal(deleted, "otp-1");
  assert.equal(verified, false);
});

test("invalid OTP does not mutate and valid OTP is marked verified", async () => {
  let marked = 0;
  const repository = {
    async findPending() {
      return { id: "otp-2", code: "123456", expiresAt: new Date("2026-01-01T00:10:00Z") };
    },
    async markVerified(id) { assert.equal(id, "otp-2"); marked += 1; },
  };
  const verify = createVerifyOtp(repository, { now: () => new Date("2026-01-01T00:00:00Z") });
  assert.deepEqual(await verify("a@b.com", "000000", "forgot-password"), { kind: "invalid" });
  assert.equal(marked, 0);
  assert.deepEqual(await verify("a@b.com", " 123456 ", "forgot-password"), { kind: "verified" });
  assert.equal(marked, 1);
});
