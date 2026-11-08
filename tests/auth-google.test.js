const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createAuthenticateGoogleIdentity,
} = require("../src/modules/auth/application/googleAuthentication");

const identity = {
  subject: "google-subject",
  email: "verified@example.com",
  name: "Verified User",
  avatar: "https://example.com/avatar.png",
};

test("Google authentication requires an ID token before provider work", async () => {
  let verifies = 0;
  const authenticate = createAuthenticateGoogleIdentity({
    verifier: { async verify() { verifies += 1; return identity; } },
    accounts: {}, secrets: {}, passwords: {}, tokens: {},
  });
  assert.deepEqual(await authenticate(" "), { kind: "validation" });
  assert.equal(verifies, 0);
});

test("Google authentication rejects failed provider verification without account access", async () => {
  let accountReads = 0;
  const authenticate = createAuthenticateGoogleIdentity({
    verifier: { async verify() { throw new Error("bad signature"); } },
    accounts: { async findAndLinkExisting() { accountReads += 1; return null; } },
    secrets: {}, passwords: {}, tokens: {},
  });
  assert.deepEqual(await authenticate("signed-token"), { kind: "invalid_identity" });
  assert.equal(accountReads, 0);
});

test("blocked linked Google account stops before secret, hash, or token creation", async () => {
  let sideEffects = 0;
  const authenticate = createAuthenticateGoogleIdentity({
    verifier: { async verify() { return identity; } },
    accounts: { async findAndLinkExisting(received) {
      assert.deepEqual(received, identity);
      return {
        user: { id: "u1", name: "User", email: identity.email, role: "customer" },
        isBlocked: true,
      };
    } },
    secrets: { generate() { sideEffects += 1; return "secret"; } },
    passwords: { async hash() { sideEffects += 1; return "hash"; } },
    tokens: { issue() { sideEffects += 1; } },
  });
  assert.deepEqual(await authenticate("signed-token"), { kind: "blocked" });
  assert.equal(sideEffects, 0);
});

test("existing Google account signs in without generating a fallback password", async () => {
  let fallbackWork = 0;
  let issued;
  const user = { id: "u1", name: "User", email: identity.email, role: "admin" };
  const authenticate = createAuthenticateGoogleIdentity({
    verifier: { async verify() { return identity; } },
    accounts: { async findAndLinkExisting() { return { user, isBlocked: false }; } },
    secrets: { generate() { fallbackWork += 1; return "secret"; } },
    passwords: { async hash() { fallbackWork += 1; return "hash"; } },
    tokens: { issue(input) { issued = input; return { accessToken: "t", expiresAt: 2, expiresIn: 1 }; } },
  });
  const result = await authenticate("signed-token");
  assert.equal(result.kind, "authenticated");
  assert.equal(result.isNewUser, false);
  assert.equal(fallbackWork, 0);
  assert.deepEqual(issued, { userId: "u1", email: identity.email, role: "admin" });
});

test("new verified Google identity creates one hashed fallback and issues token", async () => {
  const events = [];
  const authenticate = createAuthenticateGoogleIdentity({
    verifier: { async verify(token) { assert.equal(token, "signed-token"); return identity; } },
    accounts: {
      async findAndLinkExisting() { return null; },
      async createGoogleAccount(input) {
        events.push(["create", input]);
        return { id: "u2", name: identity.name, email: identity.email, role: "customer" };
      },
    },
    secrets: { generate() { events.push(["secret"]); return "random-secret"; } },
    passwords: { async hash(secret) { events.push(["hash", secret]); return "fallback-hash"; } },
    tokens: { issue(input) { events.push(["token", input]); return { accessToken: "t", expiresAt: 2, expiresIn: 1 }; } },
  });
  const result = await authenticate(" signed-token ");
  assert.equal(result.kind, "authenticated");
  assert.equal(result.isNewUser, true);
  assert.deepEqual(events, [
    ["secret"],
    ["hash", "random-secret"],
    ["create", { identity, fallbackPasswordHash: "fallback-hash" }],
    ["token", { userId: "u2", email: identity.email, role: "customer" }],
  ]);
});

test("a new Google account on a verified organization domain is offered Request access first (ORG-306)", async () => {
  let created = 0;
  const deps = {
    verifier: { async verify() { return identity; } },
    accounts: {
      async findAndLinkExisting() { return null; },
      async createGoogleAccount() { created += 1; return { id: "u2", name: "New", email: identity.email, role: "customer" }; },
    },
    secrets: { generate() { return "secret"; } },
    passwords: { async hash() { return "hash"; } },
    tokens: { issue() { return "token"; } },
    domainOrganizationFor: async (email) => (email === identity.email ? { name: "Example Org" } : null),
  };
  const authenticate = createAuthenticateGoogleIdentity(deps);
  assert.deepEqual(await authenticate("signed-token"), { kind: "domain_match", organizationName: "Example Org" });
  assert.equal(created, 0, "nothing is created before the person chooses");

  const separate = await authenticate("signed-token", { separateOrganization: true });
  assert.equal(separate.kind, "authenticated");
  assert.equal(created, 1);
});

test("an existing Google account signs in even on a matched domain (ORG-306)", async () => {
  const user = { id: "u1", name: "User", email: identity.email, role: "customer" };
  const authenticate = createAuthenticateGoogleIdentity({
    verifier: { async verify() { return identity; } },
    accounts: { async findAndLinkExisting() { return { user, isBlocked: false }; } },
    secrets: {}, passwords: {}, tokens: { issue() { return "token"; } },
    domainOrganizationFor: async () => { throw new Error("must not be asked for existing accounts"); },
  });
  assert.equal((await authenticate("signed-token")).kind, "authenticated");
});
