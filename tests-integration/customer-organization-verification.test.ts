// ORG-109: the verification proves an ORG-107 migration kept everyone's access, and catches what
// would break it: lost visibility, customer records left in the shared organization, orphans.
import { TEST_APP_ROLE_URL, TEST_MONGODB_DB_NAME } from './env';
import { connectMongo, disconnectMongo, ensureAppRole, ensureMigrated, ensureServices, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import { Pool } from 'pg';
import Organization from '../modal/organizationModel';
import OrganizationMembership from '../modal/organizationMembershipModel';
import Proposal from '../modal/proposalsModel';
import User from '../modal/userModel';
import { closePostgres, postgresPool } from '../config/postgres';
import { migrateCustomerOrganizations } from '../src/modules/tenancy/customerOrganizationMigration';
import { compareVisibility, findCustomerLeftovers, findOrphanedProposals, snapshotVisibility, type VisibilitySnapshot } from '../src/modules/tenancy/migrationVerification';

const tag = randomMongoId().slice(0, 10);
const fromSlug = `intg-verify-${tag}`;
const oid = () => new mongoose.Types.ObjectId();
const ids = { shared: oid(), a: oid(), b: oid(), staff: oid(), aProposals: [oid(), oid()], bProposal: oid() };
let pgShared: string;
let beforeSnapshot: VisibilitySnapshot;
const db = () => mongoose.connection.db!;
const holdingOf = async (userId: mongoose.Types.ObjectId) => (await Organization.findOne({ slug: `legacy-${userId}` }).lean())!._id;

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  await Organization.collection.insertOne({ _id: ids.shared, name: 'Shared', slug: fromSlug, status: 'active', kind: 'customer', plan: 'free_trial' });
  await User.collection.insertMany([
    { _id: ids.a, organizationId: ids.shared, name: 'Ana', email: `ana-${tag}@example.test`, password: 'x'.repeat(10), role: 'customer' },
    { _id: ids.b, organizationId: ids.shared, name: 'Ben', email: `ben-${tag}@example.test`, password: 'x'.repeat(10), role: 'customer' },
    { _id: ids.staff, organizationId: ids.shared, name: 'Staff', email: `staff-${tag}@example.test`, password: 'x'.repeat(10), role: 'admin' },
  ]);
  await OrganizationMembership.collection.insertMany([
    { organizationId: ids.shared, userId: ids.a, roles: ['planner'], status: 'active', version: 1 },
    { organizationId: ids.shared, userId: ids.b, roles: ['planner'], status: 'active', version: 1 },
    { organizationId: ids.shared, userId: ids.staff, roles: ['dxg_admin'], status: 'active', version: 1 },
  ]);
  for (const id of ids.aProposals) await Proposal.create({ _id: id, organizationId: ids.shared, userId: ids.a, event: { eventName: 'Ana' } });
  await Proposal.create({ _id: ids.bProposal, organizationId: ids.shared, userId: ids.b, event: { eventName: 'Ben' } });
  await db().collection('vendorresponses').insertOne({ organizationId: ids.shared, proposalId: ids.aProposals[0], proposalOwnerId: ids.a, vendorName: 'AV', submittedBy: 'V', email: 'v@example.test', emailTrackingId: `verify-${tag}` });
  const pool = postgresPool();
  pgShared = (await pool.query<{ id: string }>('INSERT INTO rfpilot.organizations(external_mongo_id,name) VALUES($1,$2) RETURNING id', [String(ids.shared), 'Shared'])).rows[0].id;
  const pgA = (await pool.query<{ id: string }>('INSERT INTO rfpilot.users(organization_id,external_mongo_id) VALUES($1,$2) RETURNING id', [pgShared, String(ids.a)])).rows[0].id;
  await pool.query('INSERT INTO rfpilot.proposal_references(organization_id,owner_user_id,external_mongo_id) VALUES($1,$2,$3)', [pgShared, pgA, String(ids.aProposals[0])]);
  await pool.query("INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,decision,correlation_id) VALUES($1,$2,$3,'staff_action','proposal','allowed',$4)",
    [crypto.randomUUID(), pgShared, String(ids.staff), crypto.randomUUID()]);
});

after(async () => {
  await disconnectMongo();
  await closePostgres();
});

test('before the migration the shared organization is full of customer records', async () => {
  beforeSnapshot = await snapshotVisibility();
  const a = beforeSnapshot.users.find((u) => u.userId === String(ids.a))!;
  assert.deepEqual(a.proposals, ids.aProposals.map(String).sort());
  assert.equal(a.vendorResponses.length, 1);
  assert.deepEqual(beforeSnapshot.users.find((u) => u.userId === String(ids.staff))!.proposals, [], 'DXG roles see no customer proposals');
  const leftovers = await findCustomerLeftovers({ organizationId: String(ids.shared), pool: postgresPool() });
  assert.deepEqual(leftovers.mongo, { users: 2, organizationmemberships: 2, proposals: 3, vendorresponses: 1 });
  assert.deepEqual(leftovers.postgres, { users: 1, proposal_references: 1 });
});

// ORG-501: production runs the verifier as the table owner, which is no superuser, so forced
// row-level security hides rfpilot.organizations until the session names an organization. The
// check used to look the organization up first, find nothing, and pass without reading a row.
test('the Postgres check sees customer rows as a role bound by row-level security', async () => {
  await ensureAppRole();
  const bound = new Pool({ connectionString: TEST_APP_ROLE_URL, max: 1 });
  try {
    assert.equal((await bound.query('SELECT count(*) FROM rfpilot.organizations WHERE external_mongo_id=$1', [String(ids.shared)])).rows[0].count, '0',
      'row-level security hides the organization from a session that has not named it');
    const leftovers = await findCustomerLeftovers({ organizationId: String(ids.shared), pool: bound });
    assert.deepEqual(leftovers.postgres, { users: 1, proposal_references: 1 });
  } finally {
    await bound.end();
  }
});

test('after a clean migration all three checks pass', async () => {
  const report = await migrateCustomerOrganizations({ fromSlug, runId: `verify-${tag}`, apply: true, pool: postgresPool() });
  assert.equal(report.failed, 0, JSON.stringify(report.results));
  assert.deepEqual(compareVisibility(beforeSnapshot, await snapshotVisibility()), []);
  assert.deepEqual(await findCustomerLeftovers({ organizationId: String(ids.shared), pool: postgresPool() }), { mongo: {}, postgres: {} });
  const orphans = await findOrphanedProposals();
  const holdings = new Set([String(await holdingOf(ids.a)), String(await holdingOf(ids.b))]);
  assert.equal(orphans.byOrganization.filter((o) => holdings.has(o.organizationId)).length, 0);
});

test('lost visibility is reported per customer', async () => {
  const holding = await holdingOf(ids.a);
  await OrganizationMembership.collection.updateOne({ organizationId: holding, userId: ids.a }, { $set: { status: 'suspended' } });
  try {
    const differences = compareVisibility(beforeSnapshot, await snapshotVisibility());
    assert.deepEqual(differences.map((d) => [d.userId, d.lostProposals.length, d.lostVendorResponses.length]), [[String(ids.a), 2, 1]]);
  } finally {
    await OrganizationMembership.collection.updateOne({ organizationId: holding, userId: ids.a }, { $set: { status: 'active' } });
  }
});

test('a customer record left in the shared organization is caught in both stores', async () => {
  const stray = await db().collection('notifications').insertOne({ organizationId: ids.shared, userId: ids.a, type: 'x', title: 't', message: 'm' });
  const pgA = (await postgresPool().query<{ id: string }>('SELECT id FROM rfpilot.users WHERE external_mongo_id=$1', [String(ids.a)])).rows[0].id;
  const strayRef = (await postgresPool().query<{ id: string }>('INSERT INTO rfpilot.proposal_references(organization_id,owner_user_id,external_mongo_id) VALUES($1,$2,$3) RETURNING id', [pgShared, pgA, randomMongoId()])).rows[0].id;
  try {
    assert.deepEqual(await findCustomerLeftovers({ organizationId: String(ids.shared), pool: postgresPool() }), { mongo: { notifications: 1 }, postgres: { proposal_references: 1 } });
  } finally {
    await db().collection('notifications').deleteOne({ _id: stray.insertedId });
    await postgresPool().query('DELETE FROM rfpilot.proposal_references WHERE id=$1', [strayRef]);
  }
});

test('a proposal whose owner is no longer an active member is an orphan', async () => {
  const holding = await holdingOf(ids.b);
  await OrganizationMembership.collection.updateOne({ organizationId: holding, userId: ids.b }, { $set: { status: 'removed' } });
  try {
    const orphans = await findOrphanedProposals();
    assert.deepEqual(orphans.byOrganization.filter((o) => o.organizationId === String(holding)), [
      { organizationId: String(holding), count: 1, sample: [String(ids.bProposal)] },
    ]);
  } finally {
    await OrganizationMembership.collection.updateOne({ organizationId: holding, userId: ids.b }, { $set: { status: 'active' } });
  }
});
