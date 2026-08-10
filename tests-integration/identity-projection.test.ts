// Identity projection against the real database.
//
// The unit suite covers the outcome contract with a fake repository, which
// cannot catch the two things that actually break here: the SQL itself, and
// row-level security. rfpilot.users is FORCE ROW LEVEL SECURITY, so the insert
// only succeeds when app.organization_id is set first — a superuser connection
// would hide that, so the RLS assertions run through the non-superuser
// rfpilot_app role exactly as production does.
import { TEST_APP_ROLE_URL } from "./env";
import {
  ensureAppRole,
  ensureMigrated,
  ensureServices,
  randomMongoId,
  seedTenant,
  type Tenant,
} from "./setup";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { closePostgres, postgresPool } from "../config/postgres";
import { postgresIdentityProjectionRepository } from "../src/modules/dataFoundation/infrastructure/postgresIdentityProjectionRepository";

let tenant: Tenant;
let appPool: Pool;

before(async () => {
  await ensureServices();
  ensureMigrated();
  await ensureAppRole();
  tenant = await seedTenant("Identity Projection Org");
  appPool = new Pool({ connectionString: TEST_APP_ROLE_URL, max: 2 });
});

after(async () => {
  await appPool?.end();
  await closePostgres();
});

const countUsers = async (organizationId: string, userMongoId: string) => {
  const result = await postgresPool().query<{ count: string }>(
    "SELECT count(*)::text AS count FROM rfpilot.users WHERE organization_id=$1 AND external_mongo_id=$2",
    [organizationId, userMongoId],
  );
  return Number(result.rows[0].count);
};

test("a user missing from the data foundation is provisioned and audited", async () => {
  const userMongoId = randomMongoId();
  assert.equal(await countUsers(tenant.organizationId, userMongoId), 0);

  const result = await postgresIdentityProjectionRepository.ensure({
    organizationMongoId: tenant.organizationMongoId,
    userMongoId,
    correlationId: "integration-provision",
  });

  assert.equal(result.organizationId, tenant.organizationId);
  assert.equal(result.organizationCreated, false);
  assert.equal(result.userCreated, true);
  assert.equal(await countUsers(tenant.organizationId, userMongoId), 1);

  const audit = await postgresPool().query<{ action: string; target_id: string; decision: string }>(
    `SELECT action, target_id, decision FROM rfpilot.audit_events
     WHERE organization_id=$1 AND correlation_id='integration-provision'`,
    [tenant.organizationId],
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].action, "identity.projection.created");
  assert.equal(audit.rows[0].target_id, result.userId);
  assert.equal(audit.rows[0].decision, "allowed");
});

test("replaying the projection is idempotent and writes no second audit event", async () => {
  const userMongoId = randomMongoId();
  const input = {
    organizationMongoId: tenant.organizationMongoId,
    userMongoId,
    correlationId: "integration-replay",
  };
  const first = await postgresIdentityProjectionRepository.ensure(input);
  const second = await postgresIdentityProjectionRepository.ensure(input);

  assert.equal(first.userCreated, true);
  assert.equal(second.userCreated, false);
  assert.equal(second.userId, first.userId, "the same row must be returned, not a duplicate");
  assert.equal(await countUsers(tenant.organizationId, userMongoId), 1);

  const audit = await postgresPool().query(
    "SELECT 1 FROM rfpilot.audit_events WHERE organization_id=$1 AND correlation_id='integration-replay'",
    [tenant.organizationId],
  );
  assert.equal(audit.rowCount, 1, "an unchanged replay must not append another audit event");
});

test("an unknown organization is reported rather than invented", async () => {
  await assert.rejects(
    postgresIdentityProjectionRepository.ensure({
      organizationMongoId: randomMongoId(),
      userMongoId: randomMongoId(),
      correlationId: "integration-missing-org",
    }),
    (error: Error & { code?: string }) => error.code === "ORGANIZATION_NOT_READY",
  );
});

test("a removed user is not silently reactivated by signing in again", async () => {
  const userMongoId = randomMongoId();
  await postgresIdentityProjectionRepository.ensure({
    organizationMongoId: tenant.organizationMongoId,
    userMongoId,
    correlationId: "integration-removed",
  });
  await postgresPool().query(
    "UPDATE rfpilot.users SET status='removed' WHERE organization_id=$1 AND external_mongo_id=$2",
    [tenant.organizationId, userMongoId],
  );

  await assert.rejects(
    postgresIdentityProjectionRepository.ensure({
      organizationMongoId: tenant.organizationMongoId,
      userMongoId,
      correlationId: "integration-removed-retry",
    }),
    (error: Error & { code?: string }) => error.code === "ASSISTANT_ACTOR_NOT_ACTIVE",
  );

  const status = await postgresPool().query<{ status: string }>(
    "SELECT status FROM rfpilot.users WHERE organization_id=$1 AND external_mongo_id=$2",
    [tenant.organizationId, userMongoId],
  );
  assert.equal(status.rows[0].status, "removed", "revoked access must stay revoked");
});

test("the insert satisfies row-level security under the non-superuser application role", async () => {
  const userMongoId = randomMongoId();
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [tenant.organizationId]);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO rfpilot.users(organization_id, external_mongo_id)
       VALUES ($1,$2)
       ON CONFLICT (organization_id, external_mongo_id) DO NOTHING
       RETURNING id`,
      [tenant.organizationId, userMongoId],
    );
    assert.equal(inserted.rowCount, 1, "the tenant GUC must let the WITH CHECK clause pass");
    await client.query("COMMIT");
  } finally {
    client.release();
  }

  // Without the GUC the same statement must be refused, proving the ordering in
  // the adapter is load-bearing rather than incidental.
  const bare = await appPool.connect();
  try {
    await bare.query("BEGIN");
    await assert.rejects(
      bare.query(
        "INSERT INTO rfpilot.users(organization_id, external_mongo_id) VALUES ($1,$2)",
        [tenant.organizationId, randomMongoId()],
      ),
      /row-level security/i,
    );
    await bare.query("ROLLBACK");
  } finally {
    bare.release();
  }
});
