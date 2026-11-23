// A proposal's Postgres data follows the proposal's owner (DECISIONS.md, 2026-11-23). On a copy of
// production the ORG-107 migration put one customer's proposal reference and all its AI data in
// the holding tenant of another customer who had merely acted on that proposal; which customer got
// it depended on who was processed first, and the verifier passed. This reproduces that shape and
// runs the migration in both orders, as the non-superuser table owner production uses.
import { TEST_MONGODB_DB_NAME } from './env';
import { connectMongo, disconnectMongo, ensureMigrated, ensureServices, randomMongoId } from './setup';
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
import { migrateCustomerOrganizations, rollbackCustomerOrganizations } from '../src/modules/tenancy/customerOrganizationMigration';
import { findCustomerLeftovers, findMisplacedProposalData, findOrphanedProposals, verificationChecks, verificationFailed } from '../src/modules/tenancy/migrationVerification';
import { findIntegrityViolations, loadTenantSchema, type MoveCounts } from '../src/modules/tenancy/postgresTenantMove';

const OWNER_ROLE = 'rfpilot_owner_wins_probe';
const OWNER_PASSWORD = crypto.randomBytes(12).toString('hex');
const tag = randomMongoId().slice(0, 10);
const fromSlug = `intg-owner-wins-${tag}`;
const oid = () => new mongoose.Types.ObjectId();
const uuid = () => crypto.randomUUID();

type Home = 'shared' | 'a' | 'b';
type Customer = 'a' | 'b';
let ownerPool: Pool;
let ownedTables: string[] = [];
const ids = { shared: oid(), a: oid(), b: oid(), staff: oid(), aProposals: [oid(), oid()], bProposal: oid(), staffProposal: oid() };
const pg = { shared: '', a: '', b: '', staff: '', aRefs: ['', ''], bRef: '', staffRef: '' };
// Every Postgres row the test seeds: how to find it, and whose organization it must end up in.
const seeded: Record<string, { table: string; key: Record<string, string>; home: Home }> = {};

const pgOrganization = async (mongoId: unknown) =>
  (await postgresPool().query<{ id: string }>('SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1', [String(mongoId)])).rows[0]?.id ?? null;
const holdingOf = async (userId: mongoose.Types.ObjectId) => (await Organization.findOne({ slug: `legacy-${userId}` }).lean())?._id ?? null;

// Which organization each seeded row is in now.
const placement = async () => {
  const labels = new Map<string, string>([[pg.shared, 'shared']]);
  for (const who of ['a', 'b'] as const) {
    const holding = await holdingOf(ids[who]);
    const id = holding ? await pgOrganization(holding) : null;
    if (id) labels.set(id, who);
  }
  const placed: Record<string, string> = {};
  for (const [name, row] of Object.entries(seeded)) {
    const columns = Object.keys(row.key);
    const found = await postgresPool().query<{ organization_id: string }>(
      `SELECT organization_id FROM rfpilot."${row.table}" WHERE ${columns.map((c, i) => `"${c}"::text=$${i + 1}`).join(' AND ')}`, Object.values(row.key),
    );
    placed[name] = labels.get(found.rows[0]?.organization_id) ?? `somewhere else (${found.rows[0]?.organization_id})`;
  }
  return placed;
};
const expectedPlacement = () => Object.fromEntries(Object.entries(seeded).map(([name, row]) => [name, row.home]));

// Per tenant table, the primary keys of the shared organization's rows.
const sharedRows = async () => {
  const client = await postgresPool().connect();
  try {
    const schema = await loadTenantSchema(client);
    const rows: Record<string, string[]> = {};
    for (const name of schema.tables) {
      const pk = schema.primaryKeys[name];
      if (!pk?.length) continue;
      const found = await client.query<{ key: string }>(
        `SELECT jsonb_build_array(${pk.map((c) => `"${c}"::text`).join(',')})::text AS key FROM rfpilot."${name}" WHERE organization_id=$1 ORDER BY 1`, [pg.shared],
      );
      if (found.rows.length) rows[name] = found.rows.map((r) => r.key);
    }
    return rows;
  } finally {
    client.release();
  }
};
const countsOf = (rows: Record<string, string[]>) => Object.fromEntries(Object.entries(rows).map(([name, keys]) => [name, keys.length]));
const sum = (all: Array<MoveCounts | 'skipped'>) => {
  const total: Record<string, number> = {};
  for (const counts of all) {
    assert.notEqual(counts, 'skipped');
    for (const [name, n] of Object.entries(counts as MoveCounts)) total[name] = (total[name] ?? 0) + n;
  }
  return total;
};
const sorted = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).sort(([x], [y]) => x.localeCompare(y)));

const seedMongo = async () => {
  await Organization.collection.insertOne({ _id: ids.shared, name: 'Shared', slug: fromSlug, status: 'active', kind: 'customer', plan: 'free_trial' });
  const user = (id: mongoose.Types.ObjectId, name: string, role: string) => ({
    _id: id, organizationId: ids.shared, name, email: `${name.toLowerCase()}-${tag}@example.test`, password: 'not-a-real-hash', role, isBlocked: false,
  });
  await User.collection.insertMany([user(ids.a, 'Ana', 'customer'), user(ids.b, 'Ben', 'customer'), user(ids.staff, 'Staff', 'admin')]);
  await OrganizationMembership.collection.insertMany([
    { organizationId: ids.shared, userId: ids.a, roles: ['planner'], status: 'active', version: 1 },
    { organizationId: ids.shared, userId: ids.b, roles: ['planner'], status: 'active', version: 1 },
    { organizationId: ids.shared, userId: ids.staff, roles: ['dxg_admin'], status: 'active', version: 1 },
  ]);
  for (const id of ids.aProposals) await Proposal.create({ _id: id, organizationId: ids.shared, userId: ids.a, event: { eventName: 'Ana event' } });
  await Proposal.create({ _id: ids.bProposal, organizationId: ids.shared, userId: ids.b, event: { eventName: 'Ben event' } });
  await Proposal.create({ _id: ids.staffProposal, organizationId: ids.shared, userId: ids.staff, event: { eventName: 'Staff event' } });
};

const seedPostgres = async () => {
  const pool = postgresPool();
  const insert = async (name: string, home: Home, table: string, values: Record<string, unknown>, key?: Record<string, string>) => {
    const row: Record<string, unknown> = { ...(key ? {} : { id: uuid() }), organization_id: pg.shared, ...values };
    const columns = Object.keys(row);
    await pool.query(`INSERT INTO rfpilot."${table}"(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
    seeded[name] = { table, key: key ?? { id: String(row.id) }, home };
    return String(row.id);
  };
  pg.shared = (await pool.query<{ id: string }>('INSERT INTO rfpilot.organizations(external_mongo_id,name) VALUES($1,$2) RETURNING id', [String(ids.shared), 'Shared'])).rows[0].id;
  pg.a = await insert('A user', 'a', 'users', { external_mongo_id: String(ids.a) });
  pg.b = await insert('B user', 'b', 'users', { external_mongo_id: String(ids.b) });
  pg.staff = await insert('staff user', 'shared', 'users', { external_mongo_id: String(ids.staff) });
  const reference = (name: string, home: Home, owner: string, proposal: mongoose.Types.ObjectId) =>
    insert(name, home, 'proposal_references', { owner_user_id: owner, external_mongo_id: String(proposal) });
  pg.aRefs = [await reference('A reference 1', 'a', pg.a, ids.aProposals[0]), await reference('A reference 2', 'a', pg.a, ids.aProposals[1])];
  pg.bRef = await reference('B reference', 'b', pg.b, ids.bProposal);
  pg.staffRef = await reference('staff reference', 'shared', pg.staff, ids.staffProposal);

  const conversation = (name: string, home: Home, ref: string, owner: mongoose.Types.ObjectId) =>
    insert(name, home, 'conversations', { proposal_reference_id: ref, owner_external_user_id: String(owner) });
  let ordinal = 0;
  const message = (name: string, home: Home, conversationId: string, actor: mongoose.Types.ObjectId) =>
    insert(name, home, 'conversation_messages', { conversation_id: conversationId, ordinal: ++ordinal, role: 'user', kind: 'note', content: 'hello', actor_external_user_id: String(actor) });
  // Plain foreign key to the reference.
  const guidance = (name: string, home: Home, ref: string, actor: mongoose.Types.ObjectId) =>
    insert(name, home, 'guidance_reports', { proposal_reference_id: ref, actor_external_user_id: String(actor), proposal_version: 1, overall_completeness: 0.5, correlation_id: uuid() });
  // Composite foreign keys (organization_id, reference): the database won't let these live apart from the reference.
  const extraction = (name: string, home: Home, ref: string) =>
    insert(name, home, 'source_extraction_runs', {
      proposal_reference_id: ref, vendor_submission_mongo_id: randomMongoId(), vendor_submission_version_mongo_id: randomMongoId(), source_kind: 'cover_message',
      source_label: 'cover', mime_type: 'text/plain', source_checksum: crypto.randomBytes(32).toString('hex'), policy_version: 'v1', idempotency_key: `owner-wins-${uuid()}`,
    });
  const insight = (name: string, home: Home, ref: string, actor: mongoose.Types.ObjectId) =>
    insert(name, home, 'historical_insight_reports', {
      current_proposal_reference_id: ref, actor_external_user_id: String(actor), current_proposal_version: 1, analysis_version: 'v1',
      reference_summary: '[]', section_comparisons: '[]', insights: '[]', privacy_summary: '{}', correlation_id: uuid(),
    });
  const cites = (name: string, home: Home, report: string, ref: string, position: number) =>
    insert(name, home, 'historical_insight_report_references', { report_id: report, reference_proposal_reference_id: ref, ordinal: position },
      { report_id: report, reference_proposal_reference_id: ref });
  const audit = (name: string, home: Home, actor: mongoose.Types.ObjectId) =>
    insert(name, home, 'audit_events', { actor_external_user_id: String(actor), action: 'test_action', target_type: 'proposal', decision: 'allowed', correlation_id: uuid() });

  // A's own data.
  const aConversation = await conversation('A conversation', 'a', pg.aRefs[0], ids.a);
  await message('A message', 'a', aConversation, ids.a);
  await guidance('A guidance', 'a', pg.aRefs[1], ids.a);
  await extraction('A extraction', 'a', pg.aRefs[0]);
  const aInsight = await insight('A insight on own proposal', 'a', pg.aRefs[0], ids.a);
  await cites('A insight cites own proposal', 'a', aInsight, pg.aRefs[1], 1);
  await audit('A audit event', 'a', ids.a);
  // B's own data.
  const bConversation = await conversation('B conversation', 'b', pg.bRef, ids.b);
  await message('B message', 'b', bConversation, ids.b);
  await extraction('B extraction', 'b', pg.bRef);
  await audit('B audit event', 'b', ids.b);
  // A acted on B's proposal. Each of these names A as the doer and hangs off B's reference: by a
  // chain of plain foreign keys, by one plain foreign key, and by a composite one. The last is
  // what dragged B's reference, and then everything under it, into A's tenant.
  await message('A message in B conversation', 'b', bConversation, ids.a);
  await guidance('A guidance on B proposal', 'b', pg.bRef, ids.a);
  const aOnB = await insight('A insight on B proposal', 'b', pg.bRef, ids.a);
  // Named by id only, no foreign key: follows the row it names.
  await insert('outbox event of A insight on B proposal', 'b', 'outbox_events',
    { aggregate_type: 'historical_insight_report', aggregate_id: aOnB, event_type: 'test.generated', idempotency_key: `owner-wins-${uuid()}`, payload: '{}', status: 'published' });
  // Hangs off A's report by a plain foreign key and is tied to B's reference by a composite one.
  await cites('A insight cites B proposal', 'b', aInsight, pg.bRef, 2);
  // B acted on A's proposal.
  await guidance('B guidance on A proposal', 'a', pg.aRefs[0], ids.b);
  // A acted on a proposal DXG staff own: it stays in the shared organization with that proposal.
  await guidance('A guidance on staff proposal', 'shared', pg.staffRef, ids.a);
  await audit('staff audit event', 'shared', ids.staff);
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
});

after(async () => {
  await ownerPool?.end();
  const pool = postgresPool();
  for (const t of ownedTables) await pool.query(`ALTER TABLE rfpilot."${t}" OWNER TO postgres`).catch(() => undefined);
  await disconnectMongo();
  await closePostgres();
});

let sharedBefore: Record<string, string[]>;
let dryRun: Record<Customer, MoveCounts>;

test('the dry run counts every row for exactly one customer', async () => {
  sharedBefore = await sharedRows();
  const report = await migrateCustomerOrganizations({ fromSlug, runId: `owner-wins-dry-${tag}`, apply: false, pool: ownerPool });
  assert.equal(report.failed, 0, JSON.stringify(report.results));
  const of = (userId: mongoose.Types.ObjectId) => report.results.find((r) => r.userId === String(userId))!.postgres as MoveCounts;
  dryRun = { a: of(ids.a), b: of(ids.b) };
  assert.deepEqual(sorted(dryRun.a), {
    audit_events: 1, conversation_messages: 1, conversations: 1, guidance_reports: 2, historical_insight_report_references: 1,
    historical_insight_reports: 1, proposal_references: 2, source_extraction_runs: 1, users: 1,
  });
  assert.deepEqual(sorted(dryRun.b), {
    audit_events: 1, conversation_messages: 2, conversations: 1, guidance_reports: 1, historical_insight_report_references: 1,
    historical_insight_reports: 1, outbox_events: 1, proposal_references: 1, source_extraction_runs: 1, users: 1,
  });
  // No row is promised to two customers: together they are the rows whose home is a customer's.
  const homes: Record<string, number> = {};
  for (const row of Object.values(seeded)) if (row.home !== 'shared') homes[row.table] = (homes[row.table] ?? 0) + 1;
  assert.deepEqual(sorted(sum([dryRun.a, dryRun.b])), sorted(homes));
  assert.deepEqual(await sharedRows(), sharedBefore, 'the dry run changes nothing');
});

for (const order of [['a', 'b'], ['b', 'a']] as Customer[][]) {
  const label = order.map((who) => who.toUpperCase()).join(' then ');
  const runId = `owner-wins-${order.join('')}-${tag}`;

  test(`apply, ${label}: every proposal's data is in its owner's organization`, async () => {
    const applied: Array<MoveCounts | 'skipped'> = [];
    for (const who of order) {
      const report = await migrateCustomerOrganizations({ fromSlug, runId, apply: true, pool: ownerPool, userId: String(ids[who]) });
      assert.equal(report.failed, 0, JSON.stringify(report.results));
      assert.deepEqual(sorted(report.results[0].postgres as MoveCounts), sorted(dryRun[who]), `the apply moves for ${who} what the dry run said`);
      applied.push(report.results[0].postgres);
    }
    // Every reference with its children in its owner's organization, nothing of B's in A's
    // tenant, A's own data moved, and the staff-owned proposal's data still in the shared one.
    assert.deepEqual(await placement(), expectedPlacement());

    // What left the shared organization is what the per-customer counts add up to.
    const remaining = countsOf(await sharedRows());
    const left: Record<string, number> = {};
    for (const [name, n] of Object.entries(countsOf(sharedBefore))) if (n - (remaining[name] ?? 0)) left[name] = n - (remaining[name] ?? 0);
    assert.deepEqual(sorted(sum(applied)), sorted(left));
    assert.deepEqual(sorted(remaining), { audit_events: 1, guidance_reports: 1, proposal_references: 1, users: 1 });

    const holdings = [await pgOrganization(await holdingOf(ids.a)), await pgOrganization(await holdingOf(ids.b))];
    assert.ok(holdings[0] && holdings[1]);
    const client = await postgresPool().connect();
    try {
      assert.deepEqual(await findIntegrityViolations(client, await loadTenantSchema(client), [pg.shared, ...holdings.map(String)]), []);
    } finally {
      client.release();
    }
    // MongoDB moved each proposal with its owner too.
    for (const [proposal, who] of [[ids.aProposals[0], 'a'], [ids.aProposals[1], 'a'], [ids.bProposal, 'b']] as const) {
      assert.equal(String((await Proposal.collection.findOne({ _id: proposal }))?.organizationId), String(await holdingOf(ids[who])));
    }
  });

  test(`apply, ${label}: the verifier's proposalDataFollowsProposal check reads every organization and passes`, async () => {
    // The owner role is bound by forced row-level security: unnamed, it sees no reference at all.
    assert.equal((await ownerPool.query('SELECT count(*) FROM rfpilot.proposal_references')).rows[0].count, '0');
    const misplaced = await findMisplacedProposalData({ pool: ownerPool });
    assert.ok(misplaced.checked.organizations >= 3);
    assert.ok(misplaced.checked.references >= 4, 'it read the references it is judging');
    assert.ok(misplaced.checked.proposals >= 4);
    const ours = new Set([ids.shared, await holdingOf(ids.a), await holdingOf(ids.b)].map(String));
    assert.deepEqual(misplaced.referenceNotWithProposal.filter((r) => ours.has(r.referenceOrganizationId)), []);
    assert.deepEqual(misplaced.ownerNotWithReference.filter((r) => ours.has(r.referenceOrganizationId)), []);
    assert.deepEqual(misplaced.rowsNotWithReference.filter((r) => ours.has(r.organizationId)), []);
  });

  test(`apply, ${label}: a reference put in the wrong organization fails the verifier`, async () => {
    const [holdingA, holdingB] = [await holdingOf(ids.a), await holdingOf(ids.b)];
    const [pgA, pgB] = [(await pgOrganization(holdingA))!, (await pgOrganization(holdingB))!];
    // A's proposal is in A's tenant; its reference, as the defect left it, in B's.
    const proposal = oid();
    await Proposal.collection.insertOne({ _id: proposal, organizationId: holdingA, userId: ids.a, status: 'unsubmitted', isDraft: true, event: { eventName: 'Misplaced' } });
    const pool = postgresPool();
    const stray = (await pool.query<{ id: string }>('INSERT INTO rfpilot.proposal_references(organization_id,owner_user_id,external_mongo_id) VALUES($1,$2,$3) RETURNING id', [pgB, pg.a, String(proposal)])).rows[0].id;
    const conversation = uuid();
    await pool.query('INSERT INTO rfpilot.conversations(id,organization_id,proposal_reference_id,owner_external_user_id) VALUES($1,$2,$3,$4)', [conversation, pgA, stray, String(ids.a)]);
    try {
      const misplaced = await findMisplacedProposalData({ pool: ownerPool });
      assert.deepEqual(misplaced.referenceNotWithProposal.filter((r) => r.proposalId === String(proposal)),
        [{ proposalId: String(proposal), proposalOrganizationId: String(holdingA), referenceOrganizationId: String(holdingB) }]);
      assert.deepEqual(misplaced.ownerNotWithReference.filter((r) => r.proposalId === String(proposal)),
        [{ proposalId: String(proposal), referenceOrganizationId: String(holdingB), ownerOrganizationId: String(holdingA) }]);
      assert.deepEqual(misplaced.rowsNotWithReference.filter((r) => r.organizationId === String(holdingA)),
        [{ organizationId: String(holdingA), table: 'conversations', rows: 1 }]);
      assert.ok(misplaced.total >= 3);
      // Every other check is content; this one alone fails the run.
      const checks = verificationChecks({
        visibility: [], leftovers: { mongo: {}, postgres: {} }, orphans: { total: 0 }, misplaced,
      });
      assert.equal(checks.proposalDataFollowsProposal, false);
      assert.equal(verificationFailed(checks), true);
    } finally {
      await pool.query('DELETE FROM rfpilot.conversations WHERE id=$1', [conversation]);
      await pool.query('DELETE FROM rfpilot.proposal_references WHERE id=$1', [stray]);
      await Proposal.collection.deleteOne({ _id: proposal });
    }
  });

  test(`apply, ${label}: applying again moves nothing`, async () => {
    const report = await migrateCustomerOrganizations({ fromSlug, runId, apply: true, pool: ownerPool });
    assert.equal(report.customers, 0, 'no customer is left in the shared organization to consider');
    assert.deepEqual(await placement(), expectedPlacement());
  });

  test(`apply, ${label}: rollback restores the shared organization exactly`, async () => {
    const report = await rollbackCustomerOrganizations({ runId, apply: true, pool: ownerPool });
    assert.equal(report.customers, 2);
    assert.equal(report.failed, 0, JSON.stringify(report.results));
    assert.deepEqual(await sharedRows(), sharedBefore, 'the same rows, by primary key, in every tenant table');
    assert.equal(await Organization.countDocuments({ slug: { $in: [`legacy-${ids.a}`, `legacy-${ids.b}`] } }), 0);
    assert.equal(await Proposal.countDocuments({ organizationId: ids.shared }), 4);
    assert.equal(await User.countDocuments({ organizationId: ids.shared }), 3);
  });
}

test('the other verifier checks still see the proposal DXG staff own in the shared organization', async () => {
  // Unchanged behaviour, stated so nobody reads owner-wins as "staff proposals pass": a
  // staff-owned proposal and the rows under it stay and are reported as leftovers.
  const runId = `owner-wins-final-${tag}`;
  const report = await migrateCustomerOrganizations({ fromSlug, runId, apply: true, pool: ownerPool });
  assert.equal(report.failed, 0, JSON.stringify(report.results));
  try {
    const leftovers = await findCustomerLeftovers({ organizationId: String(ids.shared), pool: ownerPool });
    assert.deepEqual(leftovers.postgres, { guidance_reports: 1, proposal_references: 1 });
    assert.deepEqual(leftovers.mongo, { proposals: 1 });
    const holdings = new Set([String(await holdingOf(ids.a)), String(await holdingOf(ids.b))]);
    assert.equal((await findOrphanedProposals()).byOrganization.filter((o) => holdings.has(o.organizationId)).length, 0);
  } finally {
    const rolledBack = await rollbackCustomerOrganizations({ runId, apply: true, pool: ownerPool });
    assert.equal(rolledBack.failed, 0, JSON.stringify(rolledBack.results));
  }
});
