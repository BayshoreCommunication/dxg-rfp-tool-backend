const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createAuthenticateCredentials,
  createGetAuthenticatedUser,
  createRegisterAdmin,
} = require("../src/modules/auth/application/credentialAuthentication");

const credentialUser = (overrides = {}) => ({
  user: { id: "u1", name: "User", email: "user@example.com", role: "customer" },
  passwordHash: "stored-hash",
  isBlocked: false,
  ...overrides,
});

test("credential login normalizes email and reports missing accounts before password work", async () => {
  let received;
  let verifies = 0;
  const login = createAuthenticateCredentials({
    accounts: { async findCredentials(email) { received = email; return null; } },
    passwords: { async verify() { verifies += 1; return true; } },
    tokens: { issue() { throw new Error("must not issue"); } },
  });
  assert.deepEqual(await login({ email: " USER@Example.com ", password: "secret" }, "customer"), {
    kind: "not_found",
  });
  assert.equal(received, "user@example.com");
  assert.equal(verifies, 0);
});

test("credential login verifies password before issuing a token", async () => {
  let tokens = 0;
  const login = createAuthenticateCredentials({
    accounts: { async findCredentials() { return credentialUser(); } },
    passwords: { async verify(password, hash) {
      assert.equal(password, "wrong");
      assert.equal(hash, "stored-hash");
      return false;
    } },
    tokens: { issue() { tokens += 1; } },
  });
  assert.deepEqual(await login({ email: "user@example.com", password: "wrong" }, "customer"), {
    kind: "wrong_password",
  });
  assert.equal(tokens, 0);
});

test("admin login enforces role and block state after password verification", async () => {
  let credentials = credentialUser();
  const login = createAuthenticateCredentials({
    accounts: { async findCredentials() { return credentials; } },
    passwords: { async verify() { return true; } },
    tokens: { issue() { throw new Error("must not issue"); } },
  });
  assert.deepEqual(await login({ email: "u@e.com", password: "secret" }, "admin"), {
    kind: "not_admin",
  });
  credentials = credentialUser({
    user: { id: "a1", name: "Admin", email: "a@e.com", role: "super-admin" },
    isBlocked: true,
  });
  assert.deepEqual(await login({ email: "a@e.com", password: "secret" }, "admin"), {
    kind: "blocked",
  });
});

test("successful credential login issues the endpoint-specific role", async () => {
  const issued = [];
  const login = createAuthenticateCredentials({
    accounts: { async findCredentials() {
      return credentialUser({ user: { id: "a1", name: "Admin", email: "a@e.com", role: "super_admin" } });
    } },
    passwords: { async verify() { return true; } },
    tokens: { issue(input) { issued.push(input); return { accessToken: "t", expiresAt: 2, expiresIn: 1 }; } },
  });
  assert.equal((await login({ email: "a@e.com", password: "secret" }, "customer")).kind, "authenticated");
  assert.equal((await login({ email: "a@e.com", password: "secret" }, "admin")).kind, "authenticated");
  assert.deepEqual(issued, [
    { userId: "a1", email: "a@e.com", role: "customer" },
    { userId: "a1", email: "a@e.com", role: "super_admin" },
  ]);
});

test("admin signup validates secret and conflict before hashing", async () => {
  let hashes = 0;
  let lookups = 0;
  const signup = createRegisterAdmin({
    accounts: { async emailExists() { lookups += 1; return true; } },
    passwords: { async hash() { hashes += 1; return "hash"; } },
    tokens: { issue() { throw new Error("must not issue"); } },
  });
  assert.deepEqual(await signup({
    name: "Admin", email: "a@e.com", password: "secret", adminSecret: "bad",
  }, "required"), { kind: "invalid_secret" });
  assert.equal(lookups, 0);
  assert.deepEqual(await signup({
    name: "Admin", email: "a@e.com", password: "secret", adminSecret: "required",
  }, "required"), { kind: "email_conflict" });
  assert.equal(hashes, 0);
});

test("admin signup hashes once, creates admin, and issues admin token", async () => {
  let created;
  let issued;
  const signup = createRegisterAdmin({
    accounts: {
      async emailExists() { return false; },
      async createAdmin(input) {
        created = input;
        return { id: "a1", name: input.name, email: input.email, role: "admin" };
      },
    },
    passwords: { async hash(password) { assert.equal(password, "secret"); return "one-hash"; } },
    tokens: { issue(input) { issued = input; return { accessToken: "t", expiresAt: 2, expiresIn: 1 }; } },
  });
  assert.equal((await signup({
    name: " Admin ", email: " ADMIN@E.COM ", phone: " 123 ", password: "secret",
    adminSecret: "the-secret",
  }, "the-secret")).kind, "created");
  assert.deepEqual(created, {
    name: "Admin", email: "admin@e.com", phone: "123", passwordHash: "one-hash",
  });
  assert.deepEqual(issued, { userId: "a1", email: "admin@e.com", role: "admin" });
});

test("admin signup fails closed when no signup secret is configured", async () => {
  let createdCount = 0;
  const signup = createRegisterAdmin({
    accounts: {
      async emailExists() { return false; },
      async createAdmin() { createdCount += 1; return { id: "a1", name: "n", email: "e", role: "admin" }; },
    },
    passwords: { async hash() { return "h"; } },
    tokens: { issue() { return { accessToken: "t", expiresAt: 2, expiresIn: 1 }; } },
  });
  const attempt = { name: "Admin", email: "admin@e.com", password: "secret" };
  // Unset, empty, and whitespace-only configuration must all refuse. An
  // unconfigured secret previously skipped the check entirely, leaving admin
  // account creation open to anyone who could reach the endpoint — and the
  // variable was absent from .env.example, so unset was the documented setup.
  for (const configured of [undefined, "", "   "]) {
    assert.equal((await signup(attempt, configured)).kind, "invalid_secret");
  }
  // With a secret configured, a missing or wrong presented value still refuses.
  assert.equal((await signup(attempt, "the-secret")).kind, "invalid_secret");
  assert.equal((await signup({ ...attempt, adminSecret: "wrong" }, "the-secret")).kind, "invalid_secret");
  assert.equal(createdCount, 0);
});

test("authenticated-user lookup delegates only the authenticated identifier", async () => {
  let id;
  const get = createGetAuthenticatedUser({ async findSafeById(value) { id = value; return null; } });
  assert.equal(await get("u1"), null);
  assert.equal(id, "u1");
});
