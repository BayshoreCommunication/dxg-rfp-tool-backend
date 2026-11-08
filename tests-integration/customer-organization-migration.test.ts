// ORG-107: moving every customer out of the shared organization into a legacy holding tenant of
// their own, end to end on real MongoDB (transactions) and Postgres. The migration connects as a
// non-superuser table owner, as the production migration role does, never as a superuser.
import { TEST_MONGODB_DB_NAME } from './env';
import { connectMongo, disconnectMongo, ensureMigrated, ensureServices, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import mongoose from 'mongoose';
import { Pool } from 'pg';
import app from '../server';
import Organization from '../modal/organizationModel';
import OrganizationMembership from '../modal/organizationMembershipModel';
import Proposal from '../modal/proposalsModel';
import User from '../modal/userModel';
import { beginAuthenticatedSession } from '../src/modules/auth/composition';
import { closePostgres, postgresPool } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';
import { migrateCustomerOrganizations, rollbackCustomerOrganizations } from '../src/modules/tenancy/customerOrganizationMigration';
import { MOVABLE_COLLECTIONS } from '../src/modules/tenancy/mongoTenantMove';
import { findIntegrityViolations, loadTenantSchema, withRowMovesAllowed } from '../src/modules/tenancy/postgresTenantMove';

const OWNER_ROLE = 'rfpilot_migration_owner_probe';
const OWNER_PASSWORD = crypto.randomBytes(12).toString('hex');
const tag = randomMongoId().slice(0, 10);
const runId = `intg-customer-orgs-${tag}`;
const fromSlug = `intg-shared-${tag}`;
const oid = () => new mongoose.Types.ObjectId();

let ownerPool: Pool;
let server: http.Server;
let baseUrl: string;
let ownedTables: string[] = [];
const ids = {
  shared: oid(), a: oid(), b: oid(), staff: oid(),
  aProposals: [oid(), oid()], bProposal: oid(), ticket: oid(),
};
const pg: { shared?: string; a?: string; b?: string; aRefs: string[]; bRef?: string } = { aRefs: [] };

const db = () => mongoose.connection.db!;
const mongoCounts = async (organizationId: mongoose.Types.ObjectId) => {
  const counts: Record<string, number> = {};
  for (const name of [...MOVABLE_COLLECTIONS, 'organizationmemberships']) counts[name] = await db().collection(name).countDocuments({ organizationId });
  return counts;
};
const pgCounts = async (organizationId: string) => {
  const client = await postgresPool().connect();
  try {
    const schema = await loadTenantSchema(client);
    const counts: Record<string, number> = {};
    for (const name of schema.tables) {
      const n = Number((await client.query(`SELECT count(*) FROM rfpilot."${name}" WHERE organization_id=$1`, [organizationId])).rows[0].count);
      if (n) counts[name] = n;
    }
    return counts;
  } finally {
    client.release();
  }
};
const pgOrganization = async (mongoId: string) =>
  (await postgresPool().query<{ id: string }>('SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1', [mongoId])).rows[0]?.id ?? null;

const seedMongo = async () => {
  await Organization.collection.insertOne({ _id: ids.shared, name: 'Shared', slug: fromSlug, status: 'active', kind: 'customer', plan: 'free_trial' });
  const user = (id: mongoose.Types.ObjectId, name: string, role: string, company?: string) => ({
    _id: id, organizationId: ids.shared, name, email: `${name.toLowerCase()}-${tag}@example.test`, password: 'not-a-real-hash', role, company, isBlocked: false,
  });
  await User.collection.insertMany([user(ids.a, 'Ana', 'customer', 'Ace Events'), user(ids.b, 'Ben', 'customer'), user(ids.staff, 'Staff', 'admin')]);
  // Raw inserts: legacy memberships still carry DXG roles, which today's validator refuses.
  await OrganizationMembership.collection.insertMany([
    { organizationId: ids.shared, userId: ids.a, roles: ['planner', 'organization_admin', 'dxg_producer'], status: 'active', version: 3 },
    { organizationId: ids.shared, userId: ids.b, roles: ['planner'], status: 'active', version: 1 },
    { organizationId: ids.shared, userId: ids.staff, roles: ['dxg_admin'], status: 'active', version: 1 },
  ]);
  for (const [i, id] of ids.aProposals.entries()) await Proposal.create({ _id: id, organizationId: ids.shared, userId: ids.a, event: { eventName: `Ana event ${i}` } });
  await Proposal.create({ _id: ids.bProposal, organizationId: ids.shared, userId: ids.b, event: { eventName: 'Ben event' } });
  await db().collection('vendorresponses').insertOne({ organizationId: ids.shared, proposalId: ids.aProposals[0], proposalOwnerId: ids.a, vendorName: 'AV', submittedBy: 'V', email: 'v@example.test', emailTrackingId: `mig-${tag}` });
  await db().collection('settings').insertOne({ organizationId: ids.shared, userId: ids.a });
  await db().collection('notifications').insertOne({ organizationId: ids.shared, userId: ids.a, type: 'x', title: 't', message: 'm', isRead: false });
  await db().collection('supporttickets').insertOne({ _id: ids.ticket, organizationId: ids.shared, requesterUserId: ids.a, subject: 'Help' });
  await db().collection('supportmessages').insertOne({ organizationId: ids.shared, ticketId: ids.ticket, authorUserId: ids.a, body: 'hi' });
  await db().collection('publicaccessgrants').insertOne({ organizationId: ids.shared, resourceType: 'proposal', resourceId: ids.aProposals[0], purpose: 'proposal:view', tokenHash: crypto.randomBytes(32).toString('hex') });
};

const seedPostgres = async () => {
  const pool = postgresPool();
  pg.shared = (await pool.query<{ id: string }>('INSERT INTO rfpilot.organizations(external_mongo_id,name) VALUES($1,$2) RETURNING id', [String(ids.shared), 'Shared'])).rows[0].id;
  const pgUser = async (id: mongoose.Types.ObjectId) =>
    (await pool.query<{ id: string }>('INSERT INTO rfpilot.users(organization_id,external_mongo_id) VALUES($1,$2) RETURNING id', [pg.shared, String(id)])).rows[0].id;
  pg.a = await pgUser(ids.a);
  pg.b = await pgUser(ids.b);
  const ref = async (owner: string, proposal: mongoose.Types.ObjectId) =>
    (await pool.query<{ id: string }>('INSERT INTO rfpilot.proposal_references(organization_id,owner_user_id,external_mongo_id) VALUES($1,$2,$3) RETURNING id', [pg.shared, owner, String(proposal)])).rows[0].id;
  pg.aRefs = [await ref(pg.a, ids.aProposals[0]), await ref(pg.a, ids.aProposals[1])];
  pg.bRef = await ref(pg.b, ids.bProposal);
  for (const [refId, owner] of [[pg.aRefs[0], String(ids.a)], [pg.bRef, String(ids.b)]] as const) {
    const conversation = crypto.randomUUID();
    await pool.query('INSERT INTO rfpilot.conversations(id,organization_id,proposal_reference_id,owner_external_user_id) VALUES($1,$2,$3,$4)', [conversation, pg.shared, refId, owner]);
    await pool.query("INSERT INTO rfpilot.conversation_messages(id,organization_id,conversation_id,ordinal,role,kind,content) VALUES($1,$2,$3,1,'user','note','hello')", [crypto.randomUUID(), pg.shared, conversation]);
  }
  await pool.query('INSERT INTO rfpilot.guidance_reports(id,organization_id,proposal_reference_id,actor_external_user_id,proposal_version,overall_completeness,correlation_id) VALUES($1,$2,$3,$4,1,0.5,$5)',
    [crypto.randomUUID(), pg.shared, pg.aRefs[1], String(ids.a), crypto.randomUUID()]);
  // Composite foreign key (organization_id, proposal_reference_id): moves with its reference.
  await pool.query(`INSERT INTO rfpilot.source_extraction_runs(id,organization_id,proposal_reference_id,vendor_submission_mongo_id,vendor_submission_version_mongo_id,source_kind,source_label,mime_type,source_checksum,policy_version,idempotency_key)
    VALUES($1,$2,$3,$4,$5,'cover_message','cover','text/plain',$6,'v1',$7)`,
    [crypto.randomUUID(), pg.shared, pg.aRefs[0], randomMongoId(), randomMongoId(), crypto.randomBytes(32).toString('hex'), `mig-${tag}`]);
  for (const actor of [ids.a, ids.b, ids.staff]) {
    await pool.query("INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,decision,correlation_id) VALUES($1,$2,$3,'test_action','proposal','allowed',$4)",
      [crypto.randomUUID(), pg.shared, String(actor), crypto.randomUUID()]);
  }
};

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  const pool = postgresPool();
  await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${OWNER_ROLE}') THEN CREATE ROLE ${OWNER_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;`);
  await pool.query(`ALTER ROLE ${OWNER_ROLE} PASSWORD '${OWNER_PASSWORD}'`);
  await pool.query(`GRANT USAGE ON SCHEMA rfpilot TO ${OWNER_ROLE}`);
  await pool.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA rfpilot TO ${OWNER_ROLE}`);
  ownedTables = (await pool.query<{ t: string }>("SELECT tablename t FROM pg_tables WHERE schemaname='rfpilot' AND tableowner='postgres'")).rows.map((r) => r.t);
  for (const t of ownedTables) await pool.query(`ALTER TABLE rfpilot."${t}" OWNER TO ${OWNER_ROLE}`);
  ownerPool = new Pool({ connectionString: `postgres://${OWNER_ROLE}:${OWNER_PASSWORD}@localhost:55432/rfpilot_test`, max: 2 });
  await seedMongo();
  await seedPostgres();
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  await ownerPool?.end();
  const pool = postgresPool();
  for (const t of ownedTables) await pool.query(`ALTER TABLE rfpilot."${t}" OWNER TO postgres`).catch(() => undefined);
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
});

let sharedBefore: { mongo: Record<string, number>; postgres: Record<string, number> };

test('the dry run reports per-customer counts and changes nothing', async () => {
  sharedBefore = { mongo: await mongoCounts(ids.shared), postgres: await pgCounts(pg.shared!) };
  const report = await migrateCustomerOrganizations({ fromSlug, runId, apply: false, pool: ownerPool });
  assert.equal(report.failed, 0, JSON.stringify(report.results));
  assert.deepEqual(report.results.map((r) => r.userId).sort(), [String(ids.a), String(ids.b)].sort(), 'staff never moves');
  const a = report.results.find((r) => r.userId === String(ids.a))!;
  assert.deepEqual(a.mongo, { users: 1, proposals: 2, settings: 1, notifications: 1, supporttickets: 1, vendorresponses: 1, publicaccessgrants: 1, supportmessages: 1 });
  assert.deepEqual(a.postgres, { users: 1, proposal_references: 2, conversations: 1, conversation_messages: 1, guidance_reports: 1, source_extraction_runs: 1, audit_events: 1 });
  assert.deepEqual({ mongo: await mongoCounts(ids.shared), postgres: await pgCounts(pg.shared!) }, sharedBefore);
  assert.equal(await Organization.countDocuments({ slug: { $in: [`legacy-${ids.a}`, `legacy-${ids.b}`] } }), 0);
});

test('apply moves each customer into a holding tenant of their own and empties the shared organization', async () => {
  const report = await migrateCustomerOrganizations({ fromSlug, runId, apply: true, pool: ownerPool });
  assert.equal(report.failed, 0, JSON.stringify(report.results));
  assert.deepEqual(report.remainingInSharedOrganization, { customers: 0, proposals: 0, vendorResponses: 0 });

  for (const [userId, expectedProposals] of [[ids.a, 2], [ids.b, 1]] as const) {
    const holding = await Organization.findOne({ slug: `legacy-${userId}` }).lean();
    assert.equal(holding?.kind, 'legacy_holding');
    const memberships = await OrganizationMembership.collection.find({ organizationId: holding!._id }).toArray();
    assert.deepEqual(memberships.map((m) => [String(m.userId), m.roles]), [[String(userId), ['planner']]], 'one Planner, no Owner, DXG roles stripped');
    assert.equal(await Proposal.countDocuments({ organizationId: holding!._id, userId }), expectedProposals);
    const holdingPg = await pgOrganization(String(holding!._id));
    assert.ok(holdingPg);
    assert.equal((await postgresPool().query('SELECT count(*) FROM rfpilot.proposal_references WHERE organization_id=$1', [holdingPg])).rows[0].count, String(expectedProposals));
  }
  assert.equal((await Organization.findOne({ slug: `legacy-${ids.a}` }).lean())?.name, 'Ace Events');
  // Only DXG staff remain in the shared organization.
  assert.deepEqual(await pgCounts(pg.shared!), { audit_events: 1 });
  assert.equal(await db().collection('organizationmemberships').countDocuments({ organizationId: ids.shared }), 1);

  const client = await postgresPool().connect();
  try {
    const schema = await loadTenantSchema(client);
    const holdings = await Promise.all([ids.a, ids.b].map(async (u) => pgOrganization(String((await Organization.findOne({ slug: `legacy-${u}` }).lean())!._id))));
    assert.deepEqual(await findIntegrityViolations(client, schema, [pg.shared!, ...holdings.map(String)]), []);
    const forced = (await client.query("SELECT count(*) FILTER (WHERE NOT relforcerowsecurity) n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' WHERE ns.nspname='rfpilot' AND c.relkind='r'")).rows[0].n;
    assert.equal(forced, '0', 'row-level security is forced again on every tenant table');
    assert.equal((await client.query("SELECT count(*) n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='rfpilot' AND NOT t.tgisinternal AND t.tgenabled='D'")).rows[0].n, '0');
  } finally {
    client.release();
  }
});

test('re-running an applied run skips customers already moved', async () => {
  const report = await migrateCustomerOrganizations({ fromSlug, runId, apply: true, pool: ownerPool });
  assert.equal(report.customers, 0, 'no customers left in the shared organization to consider');
});

test('a migrated customer keeps exactly their previous proposals and waits for DXG to place them', async () => {
  const holding = await Organization.findOne({ slug: `legacy-${ids.a}` }).lean();
  // tenant-scoped: the holding tenant's proposals
  const kept = (await Proposal.find({ organizationId: holding!._id }).select('_id').lean()).map((p) => String(p._id)).sort();
  assert.deepEqual(kept, ids.aProposals.map(String).sort());
  // Until DXG places them, a session in the holding tenant is refused (and ended).
  const session = await beginAuthenticatedSession({ userId: String(ids.a), organizationId: String(holding!._id), correlationId: randomMongoId() });
  const res = await fetch(`${baseUrl}/api/proposals?limit=50`, { headers: { authorization: `Bearer ${session.accessToken}` } });
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { code?: string }).code, 'ORGANIZATION_SETUP_REQUIRED');
});

test('rollback restores the shared organization exactly', async () => {
  const dry = await rollbackCustomerOrganizations({ runId, apply: false, pool: ownerPool });
  assert.equal(dry.customers, 2);
  assert.equal(await Organization.countDocuments({ slug: { $in: [`legacy-${ids.a}`, `legacy-${ids.b}`] } }), 2, 'dry run changes nothing');

  const report = await rollbackCustomerOrganizations({ runId, apply: true, pool: ownerPool });
  assert.equal(report.failed, 0, JSON.stringify(report.results));
  const after = { mongo: await mongoCounts(ids.shared), postgres: await pgCounts(pg.shared!) };
  // Sign-in during the run created a refresh session and identity rows; those come back too.
  assert.equal(after.mongo.refreshsessions, sharedBefore.mongo.refreshsessions + 1);
  assert.deepEqual({ ...after.mongo, refreshsessions: 0 }, { ...sharedBefore.mongo, refreshsessions: 0 });
  assert.deepEqual(after.postgres, { ...sharedBefore.postgres, audit_events: after.postgres.audit_events });
  assert.ok(after.postgres.audit_events >= sharedBefore.postgres.audit_events);
  const membership = await OrganizationMembership.collection.findOne({ organizationId: ids.shared, userId: ids.a });
  assert.deepEqual(membership?.roles, ['planner', 'organization_admin', 'dxg_producer'], 'roles restored');
  assert.ok(Number(membership?.version) > 3, 'version moves past every token issued before or during the run');
  assert.equal(await Organization.countDocuments({ slug: { $in: [`legacy-${ids.a}`, `legacy-${ids.b}`] } }), 0);
  assert.equal((await postgresPool().query("SELECT count(*) FROM rfpilot.organizations WHERE name IN ('Ace Events','Ben')")).rows[0].count, '0');
});

test('a move that would break a composite foreign key is refused and nothing changes', async () => {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    const schema = await loadTenantSchema(client);
    await assert.rejects(withRowMovesAllowed(client, schema, async () => {
      const other = (await client.query<{ id: string }>('INSERT INTO rfpilot.organizations(external_mongo_id,name) VALUES($1,$2) RETURNING id', [randomMongoId(), 'Broken'])).rows[0].id;
      // Move a proposal reference without the extraction run that points at it.
      await client.query('UPDATE rfpilot.proposal_references SET organization_id=$1 WHERE id=$2', [other, pg.aRefs[0]]);
    }), /foreign key/);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  assert.equal((await postgresPool().query('SELECT organization_id FROM rfpilot.proposal_references WHERE id=$1', [pg.aRefs[0]])).rows[0].organization_id, pg.shared);
  assert.equal((await postgresPool().query("SELECT count(*) FILTER (WHERE NOT relforcerowsecurity) n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='rfpilot' AND c.relkind='r' AND c.relname='proposal_references'")).rows[0].n, '0');
});
