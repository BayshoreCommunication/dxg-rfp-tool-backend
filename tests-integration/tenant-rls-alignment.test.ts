// ORG-105: with one organization per customer, Postgres row-level security is a real tenant
// boundary. Every check enumerates tables from the catalog, so a new table is covered (or fails)
// without editing this file. Behaviour is checked through the non-superuser app role, because
// superusers ignore row-level security.
import { TEST_APP_ROLE_URL } from './env';
import { ensureAppRole, ensureMigrated, ensureServices, seedTenant, setTenantGuc, type Tenant } from './setup';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { closePostgres, postgresPool } from '../config/postgres';

// Migration 064: DXG's corpus, readable by every organization once a platform is marked.
const PLATFORM_READ_TABLES = [
  'expert_rules', 'governed_assets', 'knowledge_fragment_embeddings', 'knowledge_import_batches',
  'knowledge_import_documents', 'knowledge_release_fragments', 'knowledge_releases', 'knowledge_source_fragments',
  'pricing_confidence_rules', 'pricing_modifiers', 'pricing_records', 'pricing_regional_factors',
];
// Global configuration rows (organization_id NULL) every organization reads; only migrations write them.
const GLOBAL_READ_TABLES = ['ai_kill_switches', 'ai_provider_policies'];

const TENANT = '(organization_id = rfpilot.current_organization_id())';
const TENANT_OR_GLOBAL = '((organization_id IS NULL) OR (organization_id = rfpilot.current_organization_id()))';
const PLATFORM = '(organization_id = rfpilot.platform_organization_id())';

let appPool: Pool;
let a: Tenant;
let b: Tenant;
let tenantTables: string[];

const asTenant = async <T>(tenant: Tenant, work: (client: PoolClient) => Promise<T>): Promise<T> => {
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

const seedRows = async (tenant: Tenant) => {
  const pool = postgresPool();
  const conversation = crypto.randomUUID();
  await pool.query('INSERT INTO rfpilot.conversations(id,organization_id,proposal_reference_id,owner_external_user_id) VALUES($1,$2,$3,$4)',
    [conversation, tenant.organizationId, tenant.proposalReferenceId, tenant.actorUserMongoId]);
  await pool.query("INSERT INTO rfpilot.conversation_messages(id,organization_id,conversation_id,ordinal,role,kind,content) VALUES($1,$2,$3,1,'user','note','private')",
    [crypto.randomUUID(), tenant.organizationId, conversation]);
  await pool.query('INSERT INTO rfpilot.guidance_reports(id,organization_id,proposal_reference_id,actor_external_user_id,proposal_version,overall_completeness,correlation_id) VALUES($1,$2,$3,$4,1,0.5,$5)',
    [crypto.randomUUID(), tenant.organizationId, tenant.proposalReferenceId, tenant.actorUserMongoId, crypto.randomUUID()]);
  await pool.query(`INSERT INTO rfpilot.pricing_records(id,organization_id,category,item_label,unit,amount_low_minor,amount_mid_minor,amount_high_minor,currency,status,created_by_external_user_id)
    VALUES($1,$2,'audio','Private line','per_day',1,2,3,'USD','approved',$3)`, [crypto.randomUUID(), tenant.organizationId, tenant.actorUserMongoId]);
  await pool.query("INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,decision,correlation_id) VALUES($1,$2,$3,'rls_fixture','proposal','allowed',$4)",
    [crypto.randomUUID(), tenant.organizationId, tenant.actorUserMongoId, crypto.randomUUID()]);
  await pool.query(`INSERT INTO rfpilot.source_extraction_runs(id,organization_id,proposal_reference_id,vendor_submission_mongo_id,vendor_submission_version_mongo_id,source_kind,source_label,mime_type,source_checksum,policy_version,idempotency_key)
    VALUES($1,$2,$3,$4,$5,'cover_message','cover','text/plain',$6,'v1',$7)`,
    [crypto.randomUUID(), tenant.organizationId, tenant.proposalReferenceId, tenant.organizationMongoId, tenant.actorUserMongoId,
      crypto.randomBytes(32).toString('hex'), `rls-${crypto.randomUUID()}`]);
};

before(async () => {
  await ensureServices();
  ensureMigrated();
  await ensureAppRole();
  appPool = new Pool({ connectionString: TEST_APP_ROLE_URL, max: 2 });
  a = await seedTenant('RLS A');
  b = await seedTenant('RLS B');
  await seedRows(a);
  await seedRows(b);
  tenantTables = (await postgresPool().query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute att ON att.attrelid = c.oid AND att.attname = 'organization_id' AND NOT att.attisdropped
      WHERE n.nspname = 'rfpilot' AND c.relkind = 'r' ORDER BY 1`,
  )).rows.map((r) => r.name);
});

after(async () => {
  await appPool?.end();
  await closePostgres();
});

test('the app role is subject to row-level security', async () => {
  const role = (await appPool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
});

test('every table with an organization forces row-level security', async () => {
  assert.ok(tenantTables.length > 100, `found ${tenantTables.length} tenant tables`);
  const unforced = (await postgresPool().query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'rfpilot' AND c.relname = ANY($1) AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`, [tenantTables],
  )).rows.map((r) => r.name);
  assert.deepEqual(unforced, []);
});

test('every policy is the tenant policy, the platform corpus read, or a global configuration read', async () => {
  const policies = (await postgresPool().query<{ table: string; name: string; cmd: string; qual: string; check: string | null }>(
    "SELECT tablename AS table, policyname AS name, cmd, qual, with_check AS check FROM pg_policies WHERE schemaname = 'rfpilot' ORDER BY 1, 2",
  )).rows;
  const unexpected = policies.filter((p) => {
    if (p.table === 'organizations') return !(
      (p.cmd === 'ALL' && p.qual === '((external_mongo_id)::text = (rfpilot.current_organization_mongo_id())::text)' && p.check === p.qual) ||
      (p.cmd === 'SELECT' && p.qual === 'is_platform'));
    if (p.cmd === 'ALL' && p.qual === TENANT && p.check === TENANT) return false;
    if (p.cmd === 'SELECT' && p.qual === PLATFORM && p.check === null && PLATFORM_READ_TABLES.includes(p.table)) return false;
    // Global rows are readable; writes stay with the tenant's own rows (migration 065).
    if (p.cmd === 'ALL' && p.qual === TENANT_OR_GLOBAL && p.check === TENANT && GLOBAL_READ_TABLES.includes(p.table)) return false;
    return true;
  });
  assert.deepEqual(unexpected, [], 'a policy outside the approved shapes widens what a tenant can read or write');
  const covered = new Set(policies.filter((p) => p.cmd === 'ALL').map((p) => p.table));
  assert.deepEqual(tenantTables.filter((t) => !covered.has(t)), [], 'every tenant table has a tenant policy');
  assert.deepEqual(policies.filter((p) => p.qual === PLATFORM).map((p) => p.table).sort(), [...PLATFORM_READ_TABLES].sort());
});

test('a tenant sees no row of another organization in any table', async () => {
  const foreignRows = (orgA: string) => `organization_id IS DISTINCT FROM '${orgA}'::uuid`;
  const leaks: Record<string, number> = {};
  let exercised = 0;
  for (const [self, other] of [[a, b], [b, a]] as const) {
    for (const table of tenantTables) {
      // Rows that exist for someone else, counted as superuser; if none, this table proves nothing here.
      const present = Number((await postgresPool().query(`SELECT count(*) FROM rfpilot."${table}" WHERE ${foreignRows(self.organizationId)}`)).rows[0].count);
      if (!present) continue;
      if (self === a) exercised++;
      const allowed = GLOBAL_READ_TABLES.includes(table) ? ' AND organization_id IS NOT NULL' : '';
      const visible = await asTenant(self, async (c) =>
        Number((await c.query(`SELECT count(*) FROM rfpilot."${table}" WHERE ${foreignRows(self.organizationId)}${allowed}`)).rows[0].count));
      if (visible) leaks[`${table} (as ${self === a ? 'A' : 'B'})`] = visible;
    }
    void other;
  }
  assert.deepEqual(leaks, {});
  // The seeded fixture alone covers these; run inside the suite, earlier tests' rows cover far more.
  assert.ok(exercised >= 9, `exercised ${exercised} of ${tenantTables.length} tables`);
  console.log(`# tenant RLS isolation exercised on ${exercised} of ${tenantTables.length} tables`);
});

test('a tenant cannot write a row into another organization or a global row', async () => {
  for (const [label, sql, params] of [
    ['users', 'INSERT INTO rfpilot.users(organization_id,external_mongo_id) VALUES($1,$2)', () => [b.organizationId, crypto.randomBytes(12).toString('hex')]],
    ['audit_events', "INSERT INTO rfpilot.audit_events(id,organization_id,action,target_type,decision,correlation_id) VALUES($1,$2,'forged','proposal','allowed',$3)", () => [crypto.randomUUID(), b.organizationId, crypto.randomUUID()]],
    ['guidance_reports', 'UPDATE rfpilot.guidance_reports SET organization_id=$1 WHERE organization_id=$2', () => [b.organizationId, a.organizationId]],
  ] as const) {
    await assert.rejects(asTenant(a, (c) => c.query(sql, params())), /row-level security/, label);
  }
  await assert.rejects(asTenant(a, (c) => c.query(
    "UPDATE rfpilot.ai_provider_policies SET model = 'tampered' WHERE organization_id IS NULL RETURNING id",
  ).then((r) => { if (r.rowCount === 0) throw new Error('no global policy to test against'); return r; })), /row-level security/, 'global AI policy');
});
