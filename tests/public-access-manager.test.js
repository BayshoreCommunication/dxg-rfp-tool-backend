require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const PublicAccessGrant = require("../modal/publicAccessGrantModel").default;
const {
  createPublicAccessManager,
  hashPublicGrant,
} = require("../src/modules/publicAccess/application/managePublicAccess");
const {
  mongoPublicAccessRepository,
} = require("../src/modules/publicAccess/infrastructure/mongoPublicAccessRepository");

const recipientHash = (recipient) =>
  crypto.createHash("sha256").update(recipient.trim().toLowerCase()).digest("hex");

test("issued public grants expose opaque material but persist only its hash", async () => {
  let created;
  const manager = createPublicAccessManager({
    resourceOwned: async () => true,
    create: async (input) => { created = input; return { id: "grant-1" }; },
    consume: async () => null,
    revoke: async () => true,
  });
  const result = await manager.issue({ organizationId: "org", resourceId: "proposal", purpose: "proposal:view", createdByUserId: "user" });
  assert.ok(result.token.length >= 40);
  assert.equal(created.tokenHash, hashPublicGrant(result.token));
  assert.equal(JSON.stringify(created).includes(result.token), false);
});

test("cross-tenant or unowned proposals cannot receive grants", async () => {
  const manager = createPublicAccessManager({
    resourceOwned: async () => false,
    create: async () => { throw new Error("must not create"); },
    consume: async () => null,
    revoke: async () => false,
  });
  await assert.rejects(() => manager.issue({ organizationId: "wrong", resourceId: "proposal", purpose: "vendor:submit", createdByUserId: "user" }), /not found/);
});

test("vendor submission grants cannot be issued without a bound recipient", async () => {
  let createCalled = false;
  const manager = createPublicAccessManager({
    resourceOwned: async () => true,
    create: async () => { createCalled = true; return { id: "grant-1" }; },
    consume: async () => null,
    revoke: async () => true,
  });

  await assert.rejects(
    () => manager.issue({
      organizationId: "org",
      resourceId: "proposal",
      purpose: "vendor:submit",
      createdByUserId: "user",
    }),
    /recipient is required/i,
  );
  assert.equal(createCalled, false);
});

test("vendor grant consumption binds a normalized caller email to the stored recipient hash", async () => {
  const invitedHash = recipientHash("vendor@example.com");
  const consumedHashes = [];
  const manager = createPublicAccessManager({
    resourceOwned: async () => true,
    create: async () => ({ id: "grant-1" }),
    consume: async (_tokenHash, _purpose, _resourceId, _now, suppliedHash) => {
      consumedHashes.push(suppliedHash);
      return suppliedHash === invitedHash ? { resourceId: "proposal" } : null;
    },
    revoke: async () => true,
  });

  const accepted = await manager.validateAndConsume({
    token: "opaque-token",
    purpose: "vendor:submit",
    resourceId: "proposal",
    recipient: "  Vendor@Example.COM ",
  });
  const rejected = await manager.validateAndConsume({
    token: "opaque-token",
    purpose: "vendor:submit",
    resourceId: "proposal",
    recipient: "attacker@example.com",
  });

  assert.ok(accepted);
  assert.equal(rejected, null);
  assert.deepEqual(consumedHashes, [invitedHash, recipientHash("attacker@example.com")]);
});

test("vendor grant consumption fails closed when a recipient is required but missing", async () => {
  let consumeCalled = false;
  const manager = createPublicAccessManager({
    resourceOwned: async () => true,
    create: async () => ({ id: "grant-1" }),
    consume: async () => { consumeCalled = true; return { resourceId: "proposal" }; },
    revoke: async () => true,
  });

  const result = await manager.validateAndConsume({
    token: "opaque-token",
    purpose: "vendor:submit",
    resourceId: "proposal",
  });

  assert.equal(result, null);
  assert.equal(consumeCalled, false);
});

test("vendor grant can authorize an alternate response contact when the route opts in", async () => {
  const consumedHashes = [];
  const manager = createPublicAccessManager({
    resourceOwned: async () => true,
    create: async () => ({ id: "grant-1" }),
    consume: async (_tokenHash, _purpose, _resourceId, _now, suppliedHash) => {
      consumedHashes.push(suppliedHash);
      return suppliedHash === null ? { resourceId: "proposal" } : null;
    },
    revoke: async () => true,
  });

  const result = await manager.validateAndConsume({
    token: "opaque-token",
    purpose: "vendor:submit",
    resourceId: "proposal",
    recipient: "confirmation@example.com",
    allowAlternateVendorContact: true,
  });

  assert.ok(result);
  assert.deepEqual(consumedHashes, [null]);
});

test("read-only proposal rendering can consume a vendor invite before email entry", async () => {
  let consumeCalled = false;
  const manager = createPublicAccessManager({
    resourceOwned: async () => true,
    create: async () => ({ id: "grant-1" }),
    consume: async () => { consumeCalled = true; return { resourceId: "proposal" }; },
    revoke: async () => true,
  });

  const result = await manager.validateAndConsume({
    token: "opaque-token",
    purpose: "vendor:submit",
    resourceId: "proposal",
    allowRecipientlessVendorProposalRead: true,
  });

  assert.ok(result);
  assert.equal(consumeCalled, true);
});

test("mongo consumption checks recipient hash atomically for vendor grants", async () => {
  const original = PublicAccessGrant.findOneAndUpdate;
  let capturedFilter;
  PublicAccessGrant.findOneAndUpdate = (filter) => {
    capturedFilter = filter;
    return {
      select: () => ({
        lean: async () => null,
      }),
    };
  };

  try {
    await mongoPublicAccessRepository.consume(
      "token-hash",
      "vendor:submit",
      "proposal",
      new Date("2026-08-13T00:00:00.000Z"),
      recipientHash("vendor@example.com"),
    );
  } finally {
    PublicAccessGrant.findOneAndUpdate = original;
  }

  assert.equal(capturedFilter.recipientHash, recipientHash("vendor@example.com"));
});
