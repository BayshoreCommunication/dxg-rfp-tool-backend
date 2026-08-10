require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createEnsureIdentityProjection } = require("../src/modules/dataFoundation/application/ensureIdentityProjection");

const organizationMongoId = "6a58a2d07dac2b57c12d5247";
const userMongoId = "6b71c3e18ebd3c68d23e6358";
const input = { organizationMongoId, userMongoId, correlationId: "corr-1" };
const projection = {
  organizationId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  organizationCreated: false,
  userCreated: true,
};
const enabled = () => true;

test("identity projection is skipped when PostgreSQL is not configured", async () => {
  let called = false;
  const ensure = createEnsureIdentityProjection(
    { ensure: async () => { called = true; return projection; } },
    { enabled: () => false },
  );
  assert.deepEqual(await ensure(input), { kind: "skipped" });
  assert.equal(called, false);
});

test("identity projection rejects malformed external identifiers before touching the database", async () => {
  let called = false;
  const ensure = createEnsureIdentityProjection(
    { ensure: async () => { called = true; return projection; } },
    { enabled },
  );
  assert.deepEqual(
    await ensure({ ...input, organizationMongoId: "not-an-object-id" }),
    { kind: "invalid_external_id" },
  );
  assert.deepEqual(
    await ensure({ ...input, userMongoId: "AB58A2D07DAC2B57C12D5247" }),
    { kind: "invalid_external_id" },
  );
  assert.equal(called, false);
});

test("identity projection reports the rows it provisioned", async () => {
  let received;
  const ensure = createEnsureIdentityProjection(
    { ensure: async (value) => { received = value; return projection; } },
    { enabled },
  );
  assert.deepEqual(await ensure(input), { kind: "ensured", ...projection });
  assert.equal(received, input);
});

test("identity projection never throws, so a data-foundation outage cannot block sign-in", async () => {
  const unavailable = createEnsureIdentityProjection(
    { ensure: async () => { throw Object.assign(new Error("pool down"), { code: "ORGANIZATION_NOT_READY" }); } },
    { enabled },
  );
  assert.deepEqual(await unavailable(input), { kind: "failed", code: "ORGANIZATION_NOT_READY" });

  const unlabelled = createEnsureIdentityProjection(
    { ensure: async () => { throw new Error("connection terminated unexpectedly"); } },
    { enabled },
  );
  assert.deepEqual(await unlabelled(input), { kind: "failed", code: "IDENTITY_PROJECTION_FAILED" });
});

test("identity projection failure codes stay label-shaped so telemetry cannot leak a message", async () => {
  const ensure = createEnsureIdentityProjection(
    { ensure: async () => { throw Object.assign(new Error("x"), { code: "user 6a58a2d0 not found" }); } },
    { enabled },
  );
  assert.deepEqual(await ensure(input), { kind: "failed", code: "IDENTITY_PROJECTION_FAILED" });
});
