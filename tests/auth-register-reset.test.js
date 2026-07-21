const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createRegisterCustomer,
  createResetPassword,
} = require("../src/modules/auth/application/registerAndReset");

test("registration requires verified signup OTP before account lookup", async () => {
  let accountReads = 0;
  let hashes = 0;
  const register = createRegisterCustomer({
    otps: { async hasVerified(email, purpose) {
      assert.equal(email, "new@example.com");
      assert.equal(purpose, "signup");
      return false;
    } },
    accounts: { async emailExists() { accountReads += 1; return false; } },
    passwordHasher: { async hash() { hashes += 1; return "hash"; } },
    tokens: { issue() { throw new Error("must not issue"); } },
  });
  assert.deepEqual(await register({
    name: "New", email: " NEW@example.com ", password: "secret-01",
  }), { kind: "unverified" });
  assert.equal(accountReads, 0);
  assert.equal(hashes, 0);
});

test("registration detects normalized email conflict before password hashing", async () => {
  let hashes = 0;
  const register = createRegisterCustomer({
    otps: { async hasVerified() { return true; } },
    accounts: { async emailExists(email) { assert.equal(email, "used@example.com"); return true; } },
    passwordHasher: { async hash() { hashes += 1; return "hash"; } },
    tokens: { issue() { throw new Error("must not issue"); } },
  });
  assert.deepEqual(await register({ name: "New", email: "USED@EXAMPLE.COM", password: "secret-01" }), {
    kind: "email_conflict",
  });
  assert.equal(hashes, 0);
});

test("registration hashes once, creates a customer, consumes OTP, then issues token", async () => {
  const events = [];
  const register = createRegisterCustomer({
    otps: {
      async hasVerified() { return true; },
      async consumeVerified(email, purpose) { events.push(["consume", email, purpose]); },
    },
    accounts: {
      async emailExists() { return false; },
      async createCustomer(input) {
        events.push(["create", input]);
        return { id: "u1", name: input.name, email: input.email, role: "customer" };
      },
    },
    passwordHasher: { async hash(password) { events.push(["hash", password]); return "one-hash"; } },
    tokens: { issue(input) { events.push(["token", input]); return { accessToken: "t", expiresAt: 2, expiresIn: 1 }; } },
  });
  const result = await register({
    name: "  New User ", email: " NEW@example.com ", phone: "123", password: "secret-01",
  });
  assert.equal(result.kind, "created");
  assert.deepEqual(events, [
    ["hash", "secret-01"],
    ["create", { name: "New User", email: "new@example.com", phone: "123", company: undefined, passwordHash: "one-hash" }],
    ["consume", "new@example.com", "signup"],
    ["token", { userId: "u1", email: "new@example.com", role: "customer" }],
  ]);
});

test("password reset requires verified authorization before account or hash work", async () => {
  let sideEffects = 0;
  const reset = createResetPassword({
    otps: { async hasVerified() { return false; } },
    accounts: {
      async emailExists() { sideEffects += 1; return true; },
      async replacePassword() { sideEffects += 1; return true; },
    },
    passwordHasher: { async hash() { sideEffects += 1; return "hash"; } },
  });
  assert.deepEqual(await reset({ email: "a@b.com", newPassword: "secret-01" }), {
    kind: "unauthorized",
  });
  assert.equal(sideEffects, 0);
});

test("password reset hashes once and consumes authorization only after persistence", async () => {
  const events = [];
  const reset = createResetPassword({
    otps: {
      async hasVerified() { return true; },
      async consumeVerified(email, purpose) { events.push(["consume", email, purpose]); },
    },
    accounts: {
      async emailExists() { return true; },
      async replacePassword(email, hash) { events.push(["replace", email, hash]); return true; },
    },
    passwordHasher: { async hash(password) { events.push(["hash", password]); return "one-hash"; } },
  });
  assert.deepEqual(await reset({ email: " USER@example.com ", newPassword: "secret-01" }), {
    kind: "reset",
  });
  assert.deepEqual(events, [
    ["hash", "secret-01"],
    ["replace", "user@example.com", "one-hash"],
    ["consume", "user@example.com", "forgot-password"],
  ]);
});

test("short registration and reset passwords fail before authorization checks", async () => {
  let reads = 0;
  const dependencies = {
    otps: { async hasVerified() { reads += 1; return true; } },
    accounts: {},
    passwordHasher: {},
    tokens: {},
  };
  assert.deepEqual(await createRegisterCustomer(dependencies)({
    name: "User", email: "a@b.com", password: "123",
  }), { kind: "invalid_password" });
  assert.deepEqual(await createResetPassword(dependencies)({
    email: "a@b.com", newPassword: "123",
  }), { kind: "invalid_password" });
  assert.equal(reads, 0);
});
