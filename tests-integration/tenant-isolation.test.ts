// Row-level security isolation against the real database, exercised through a
// dedicated non-superuser role (rfpilot_app).
//
// Why a separate role: migrations FORCE ROW LEVEL SECURITY, which subjects
// even the table owner to the tenant policies — but PostgreSQL superusers
// always bypass RLS, and the Docker stack's default `postgres` login is a
// superuser (the last test documents that bypass explicitly). The application
// policies key off the `app.organization_id` GUC set per transaction by every
// repository's tenant() helper.
import { TEST_APP_ROLE_URL } from "./env";
import {
  ensureAppRole,
  ensureMigrated,
  ensureServices,
  seedTenant,
  setTenantGuc,
  type Tenant,
} from "./setup";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { closePostgres, postgresPool } from "../config/postgres";

let tenantA: Tenant;
let tenantB: Tenant;
let appPool: Pool;
const seeded: Record<string, { conversationId: string; pricingRecordId: string; guidanceReportId: string }> = {};

const seedTenantRows = async (tenant: Tenant) => {
  const pool = postgresPool();
  const conversationId = crypto.randomUUID();
  const pricingRecordId = crypto.randomUUID();
  const guidanceReportId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO rfpilot.conversations(id,organization_id,proposal_reference_id,owner_external_user_id) VALUES($1,$2,$3,$4)",
    [conversationId, tenant.organizationId, tenant.proposalReferenceId, tenant.actorUserMongoId],
  );
  await pool.query(
    `INSERT INTO rfpilot.pricing_records(id,organization_id,category,item_label,unit,amount_low_minor,amount_mid_minor,amount_high_minor,currency,created_by_external_user_id)
     VALUES($1,$2,'audio',$3,'per_day',10000,20000,30000,'USD',$4)`,
    [pricingRecordId, tenant.organizationId, `RLS fixture ${tenant.organizationMongoId.slice(0, 8)}`, tenant.actorUserMongoId],
  );
  await pool.query(
    `INSERT INTO rfpilot.guidance_reports(id,organization_id,proposal_reference_id,actor_external_user_id,proposal_version,overall_completeness,correlation_id)
     VALUES($1,$2,$3,$4,1,0.5,$5)`,
    [guidanceReportId, tenant.organizationId, tenant.proposalReferenceId, tenant.actorUserMongoId, crypto.randomUUID()],
  );
  return { conversationId, pricingRecordId, guidanceReportId };
};

const withAppClient = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

before(async () => {
  await ensureServices();
  ensureMigrated();
  await ensureAppRole();
  tenantA = await seedTenant("RLS Org A");
  tenantB = await seedTenant("RLS Org B");
  seeded.a = await seedTenantRows(tenantA);
  seeded.b = await seedTenantRows(tenantB);
  appPool = new Pool({ connectionString: TEST_APP_ROLE_URL, max: 2, connectionTimeoutMillis: 5_000 });
});

after(async () => {
  if (appPool) await appPool.end();
  await closePostgres();
});

test("with org A's GUC set, SELECTs only return org A rows", async () => {
  await withAppClient(async (client) => {
    await setTenantGuc(client, tenantA.organizationId, tenantA.organizationMongoId);
    const conversations = await client.query<{ id: string }>("SELECT id FROM rfpilot.conversations ORDER BY id");
    assert.deepEqual(conversations.rows.map((row) => row.id), [seeded.a.conversationId]);
    const pricing = await client.query<{ id: string }>("SELECT id FROM rfpilot.pricing_records ORDER BY id");
    assert.deepEqual(pricing.rows.map((row) => row.id), [seeded.a.pricingRecordId]);
    const guidance = await client.query<{ id: string }>("SELECT id FROM rfpilot.guidance_reports ORDER BY id");
    assert.deepEqual(guidance.rows.map((row) => row.id), [seeded.a.guidanceReportId]);
  });
});

test("without a tenant GUC, the app role sees no rows at all", async () => {
  await withAppClient(async (client) => {
    for (const table of ["conversations", "pricing_records", "guidance_reports"]) {
      const result = await client.query<{ n: string }>(`SELECT count(*) n FROM rfpilot.${table}`);
      assert.equal(Number(result.rows[0].n), 0, `expected zero visible rows in rfpilot.${table}`);
    }
  });
});

test("INSERT with a mismatched organization_id is rejected by RLS", async () => {
  await withAppClient(async (client) => {
    await setTenantGuc(client, tenantA.organizationId, tenantA.organizationMongoId);
    await assert.rejects(
      client.query(
        `INSERT INTO rfpilot.pricing_records(id,organization_id,category,item_label,unit,amount_low_minor,amount_mid_minor,amount_high_minor,currency,created_by_external_user_id)
         VALUES($1,$2,'audio','Cross-tenant write attempt','per_day',1,2,3,'USD',$3)`,
        [crypto.randomUUID(), tenantB.organizationId, tenantA.actorUserMongoId],
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "42501", "expected an RLS with-check violation (42501)");
        return true;
      },
    );
  });
});

test("INSERT matching the tenant GUC passes the RLS WITH CHECK", async () => {
  await withAppClient(async (client) => {
    await setTenantGuc(client, tenantA.organizationId, tenantA.organizationMongoId);
    const inserted = await client.query(
      `INSERT INTO rfpilot.pricing_records(id,organization_id,category,item_label,unit,amount_low_minor,amount_mid_minor,amount_high_minor,currency,created_by_external_user_id)
       VALUES($1,$2,'audio','Same-tenant write','per_day',1,2,3,'USD',$3) RETURNING id`,
      [crypto.randomUUID(), tenantA.organizationId, tenantA.actorUserMongoId],
    );
    assert.equal(inserted.rowCount, 1);
    // Rolled back by withAppClient, so nothing leaks into other tests.
  });
});

test("documented: the default superuser connection bypasses RLS", async () => {
  // The app's runtime pool (POSTGRES_URL) must be able to scan cross-tenant
  // tables like outbox_events without a GUC (dispatcher/reconciler). In this
  // stack that connection is the `postgres` superuser, so RLS never filters it.
  const result = await postgresPool().query<{ n: string }>(
    "SELECT count(*) n FROM rfpilot.pricing_records WHERE id = ANY($1::uuid[])",
    [[seeded.a.pricingRecordId, seeded.b.pricingRecordId]],
  );
  assert.equal(Number(result.rows[0].n), 2, "superuser should see both tenants' rows without any GUC");
});
