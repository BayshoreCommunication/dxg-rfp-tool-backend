require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPublicAccessManager, hashPublicGrant } = require("../src/modules/publicAccess/application/managePublicAccess");

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
