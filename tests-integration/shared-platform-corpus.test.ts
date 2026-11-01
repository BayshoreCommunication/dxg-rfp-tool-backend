// Migration 064: DXG's pricing corpus, expert rules and knowledge base are read by every customer
// organization once the platform organization is marked, and customer data stays isolated.
import { TEST_APP_ROLE_URL } from './env';
import { connectMongo, createMongoProposal, disconnectMongo, ensureAppRole, ensureMigrated, ensureServices, seedTenant, setTenantGuc, type Tenant } from './setup';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import { Pool, type PoolClient } from 'pg';
import Proposal from '../modal/proposalsModel';
import { closePostgres, postgresPool } from '../config/postgres';
import { investmentRepository } from '../src/modules/investment/postgresInvestmentRepository';

let platform: Tenant;
let customer: Tenant;
let otherCustomer: Tenant;
let appPool: Pool;
const pricing: Record<string, string> = {};

const insertPricing = async (tenant: Tenant, label: string) => {
  const id = crypto.randomUUID();
  // status approved: the governed-asset trigger registers it as approved and active.
  await postgresPool().query(
    `INSERT INTO rfpilot.pricing_records(id,organization_id,category,item_label,unit,amount_low_minor,amount_mid_minor,amount_high_minor,currency,status,created_by_external_user_id)
     VALUES($1,$2,'audio',$3,'per_day',10000,20000,30000,'USD','approved',$4)`,
    [id, tenant.organizationId, label, tenant.actorUserMongoId],
  );
  return id;
};
const asApp = async <T>(tenant: Tenant, work: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await setTenantGuc(client, tenant.organizationId, tenant.organizationMongoId);
    return await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
};
const visiblePricing = (tenant: Tenant) =>
  asApp(tenant, async (c) => (await c.query<{ id: string }>('SELECT id FROM rfpilot.pricing_records')).rows.map((r) => r.id));
const markPlatform = (tenant: Tenant | null) =>
  postgresPool().query('UPDATE rfpilot.organizations SET is_platform = coalesce(id = $1, false)', [tenant?.organizationId ?? null]);
const pricingVersion = async (tenant: Tenant) =>
  (await investmentRepository.generate({
    organizationMongoId: tenant.organizationMongoId,
    actorUserMongoId: tenant.actorUserMongoId,
    proposalMongoId: tenant.proposalMongoId,
    correlationId: crypto.randomUUID(),
  })).pricingReleaseVersion;

before(async () => {
  await ensureServices();
  ensureMigrated();
  await ensureAppRole();
  await connectMongo();
  appPool = new Pool({ connectionString: TEST_APP_ROLE_URL, max: 2 });
  await markPlatform(null);
  platform = await seedTenant('Platform');
  customer = await seedTenant('Customer');
  otherCustomer = await seedTenant('Other customer');
  for (const tenant of [platform, customer]) await createMongoProposal(tenant);
  pricing.platform = await insertPricing(platform, 'Platform corpus line');
  pricing.otherCustomer = await insertPricing(otherCustomer, 'Other customer private line');
});

after(async () => {
  await markPlatform(null).catch(() => undefined);
  await appPool?.end();
  if (mongoose.connection.readyState === 1) {
    await Proposal.deleteMany({ _id: { $in: [platform, customer].map((t) => new mongoose.Types.ObjectId(t.proposalMongoId)) } });
  }
  await disconnectMongo();
  await closePostgres();
});

test('nothing is shared until a platform organization is marked', async () => {
  assert.equal(await asApp(customer, async (c) => (await c.query('SELECT rfpilot.platform_organization_id() id')).rows[0].id), null);
  assert.deepEqual(await visiblePricing(customer), []);
});

test('a customer reads the platform corpus but never another customer\'s pricing', async () => {
  await markPlatform(platform);
  assert.equal(await asApp(customer, async (c) => (await c.query('SELECT rfpilot.platform_organization_id() id')).rows[0].id), platform.organizationId);
  assert.deepEqual(await visiblePricing(customer), [pricing.platform]);
  assert.deepEqual((await visiblePricing(otherCustomer)).sort(), [pricing.otherCustomer, pricing.platform].sort());
  const governed = await asApp(customer, async (c) =>
    (await c.query<{ asset_id: string }>("SELECT asset_id FROM rfpilot.governed_assets WHERE asset_type='pricing_record'")).rows.map((r) => r.asset_id));
  assert.deepEqual(governed, [pricing.platform]);
});

test('customers cannot change or delete the platform corpus', async () => {
  await markPlatform(platform);
  const updated = await asApp(customer, (c) => c.query("UPDATE rfpilot.pricing_records SET item_label='tampered' WHERE id=$1", [pricing.platform]));
  assert.equal(updated.rowCount, 0);
  const deleted = await asApp(customer, (c) => c.query('DELETE FROM rfpilot.pricing_records WHERE id=$1', [pricing.platform]));
  assert.equal(deleted.rowCount, 0);
  await assert.rejects(asApp(customer, (c) => c.query(
    `INSERT INTO rfpilot.pricing_records(id,organization_id,category,item_label,unit,amount_low_minor,amount_mid_minor,amount_high_minor,currency,created_by_external_user_id)
     VALUES($1,$2,'audio','forged','per_day',1,2,3,'USD',$3)`,
    [crypto.randomUUID(), platform.organizationId, customer.actorUserMongoId],
  )), /row-level security/);
});

test('only one organization can be the platform', async () => {
  await markPlatform(platform);
  await assert.rejects(
    postgresPool().query('UPDATE rfpilot.organizations SET is_platform = true WHERE id = $1', [customer.organizationId]),
    /organizations_single_platform/,
  );
});

test('investment guidance for a customer is priced from the platform corpus', async () => {
  await markPlatform(null);
  const unshared = await pricingVersion(customer);
  await markPlatform(platform);
  const shared = await pricingVersion(customer);
  const platformOwn = await pricingVersion(platform);
  assert.notEqual(shared, unshared, 'the customer now sees pricing records');
  assert.equal(shared, platformOwn, 'the customer sees exactly the platform corpus');
});
