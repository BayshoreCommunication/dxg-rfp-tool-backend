// `scripts/purgeTestAccounts.ts --with-content`, run the way production runs it: as its own
// process, against real MongoDB and PostgreSQL (as the application role, under row-level
// security), with storage pointed at a local stand-in that records every request it receives.
import { TEST_APP_ROLE_URL, TEST_MONGODB_DB_NAME, TEST_MONGODB_URL } from './env';
import { connectMongo, disconnectMongo, ensureAppRole, ensureMigrated, ensureServices, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import Admin from '../modal/adminModel';
import { closePostgres, postgresPool } from '../config/postgres';
import { findOrphanedProposals } from '../src/modules/tenancy/migrationVerification';

const tag = randomMongoId().slice(0, 10);
const oid = () => new mongoose.Types.ObjectId();
const db = () => mongoose.connection.db!;
const { EJSON } = mongoose.mongo.BSON;

const org = { shared: oid(), ownerLed: oid(), holding: oid() };
const user = { ana: oid(), ben: oid(), carol: oid(), staff: oid(), admin: oid(), dora: oid(), eve: oid(), fay: oid(), gil: oid() };
const proposal = { ana1: oid(), ana2: oid(), ben1: oid(), carol1: oid(), fay1: oid(), gil1: oid() };
const email = {
  // Stored with capitals; the command line passes lower case.
  ana: `Ana.Purge-${tag}@Example.test`, ben: `ben.purge-${tag}@example.test`, carol: `carol.stays-${tag}@example.test`,
  dora: `dora-${tag}@example.test`, eve: `eve-${tag}@example.test`, fay: `fay-${tag}@example.test`, gil: `gil-${tag}@example.test`,
  ghost: `nobody-${tag}@example.test`,
};
const key = {
  anaDocument: `org/${tag}/sources/ana-brief.pdf`, carolDocument: `org/${tag}/sources/carol-brief.pdf`, gilDocument: `org/${tag}/sources/gil-brief.pdf`,
  anaAttached: `support/${tag}/ana-attached.png`, anaPending: `support/${tag}/ana-pending.png`, anaStaffReply: `support/${tag}/staff-reply.png`,
  carolAttached: `support/${tag}/carol-attached.png`,
};

// _ids this purge must delete, per collection. Everything else in the database must not change.
const going = new Map<string, Set<string>>();
const insert = async (collection: string, doc: Record<string, unknown>, goes: boolean) => {
  const _id = (doc._id as mongoose.Types.ObjectId | undefined) ?? oid();
  await db().collection(collection).insertOne({ ...doc, _id });
  if (goes) going.set(collection, (going.get(collection) ?? new Set()).add(String(_id)));
  return _id;
};

// ---- storage stand-in ---------------------------------------------------------------------------
const bucket = `purge-test-${tag}`;
const storage = { requests: [] as string[], deny: false, server: null as http.Server | null, endpoint: '' };
const deletedKeys = () => storage.requests.filter((r) => r.startsWith('DELETE ')).map((r) => r.slice('DELETE '.length));

// ---- the script ---------------------------------------------------------------------------------
type Run = { status: number | null; stdout: string; stderr: string; report: Record<string, any> | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
const purge = (...args: string[]): Promise<Run> => new Promise((resolve, reject) => {
  // cwd is this directory so config/env finds no developer .env file (see setup.ts).
  const child = spawn(process.execPath, ['--require', 'ts-node/register', path.resolve(__dirname, '..', 'scripts', 'purgeTestAccounts.ts'), ...args], {
    cwd: __dirname,
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test', TS_NODE_TRANSPILE_ONLY: '1',
      MONGODB_URL: TEST_MONGODB_URL, MONGODB_DB_NAME: TEST_MONGODB_DB_NAME,
      // The application role, not the migration role: every Postgres statement runs under RLS.
      POSTGRES_FOUNDATION_ENABLED: 'true', POSTGRES_URL: TEST_APP_ROLE_URL, POSTGRES_SSL: 'false',
      DOCUMENT_STORAGE_BUCKET: bucket, DOCUMENT_STORAGE_REGION: 'us-east-1', DOCUMENT_STORAGE_ENDPOINT: storage.endpoint,
      DOCUMENT_STORAGE_FORCE_PATH_STYLE: 'true', DOCUMENT_STORAGE_KEY: 'test', DOCUMENT_STORAGE_SECRET: 'test',
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
  child.on('error', reject);
  child.on('close', (status) => {
    clearTimeout(timer);
    // The report is the pretty-printed object that starts with "mode"; other lines may surround it.
    const start = stdout.search(/\{\r?\n\s+"mode"/);
    let report: Run['report'] = null;
    for (let end = stdout.lastIndexOf('}'); start >= 0 && end > start && !report; end = stdout.lastIndexOf('}', end - 1)) {
      try { report = JSON.parse(stdout.slice(start, end + 1)); } catch { report = null; }
    }
    if (!report) process.stderr.write(`purgeTestAccounts ${args.join(' ')} printed no report:\n--- stdout\n${stdout}\n--- stderr\n${stderr}\n`);
    resolve({ status, stdout, stderr, report });
  });
});
const explain = (run: Run) => `exit ${run.status}\n${run.stdout}\n${run.stderr}`;

// ---- snapshots ----------------------------------------------------------------------------------
// Every document, in every collection, that belongs to this file's organizations or carries its
// tag, as canonical extended JSON. Other files share the database, and their expiring documents
// can be removed by MongoDB's TTL monitor while this one runs, so they are left out.
const mine = () => [String(org.shared), String(org.ownerLed), String(org.holding), tag];
const mongoSnapshot = async (): Promise<Map<string, string>> => {
  const snapshot = new Map<string, string>();
  for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith('system.')) continue;
    for (const doc of await db().collection(name).find({}).toArray()) {
      const text = EJSON.stringify(doc, { relaxed: false });
      if (mine().some((marker) => text.includes(marker))) snapshot.set(`${name}/${String(doc._id)}`, text);
    }
  }
  return snapshot;
};
const without = (snapshot: Map<string, string>, removed: Map<string, Set<string>>) => {
  const copy = new Map(snapshot);
  for (const [collection, ids] of removed) for (const id of ids) assert.ok(copy.delete(`${collection}/${id}`), `fixture ${collection}/${id} is missing from the snapshot`);
  return copy;
};
const assertSameDocuments = (actual: Map<string, string>, expected: Map<string, string>, message: string) => {
  const differences = [
    ...[...expected.keys()].filter((k) => !actual.has(k)).map((k) => `missing ${k}`),
    ...[...actual.keys()].filter((k) => !expected.has(k)).map((k) => `unexpected ${k}`),
    ...[...expected.keys()].filter((k) => actual.has(k) && actual.get(k) !== expected.get(k)).map((k) => `changed ${k}`),
  ];
  assert.deepEqual(differences, [], message);
};

let pgShared = '';
const pg = { anaSource: crypto.randomUUID(), carolSource: crypto.randomUUID(), gilSource: crypto.randomUUID(), anaConversation: crypto.randomUUID(), carolConversation: crypto.randomUUID(), gilConversation: crypto.randomUUID() };
const postgresSnapshot = async () => {
  const pool = postgresPool();
  const rows = async (sql: string) => JSON.stringify((await pool.query(sql, [pgShared])).rows);
  return {
    users: await rows('SELECT id, external_mongo_id, status FROM rfpilot.users WHERE organization_id=$1 ORDER BY external_mongo_id'),
    references: await rows('SELECT id, external_mongo_id, owner_user_id FROM rfpilot.proposal_references WHERE organization_id=$1 ORDER BY external_mongo_id'),
    sources: await rows('SELECT id, status, deleted_at IS NOT NULL AS deleted FROM rfpilot.document_sources WHERE organization_id=$1 ORDER BY id'),
    conversations: await rows('SELECT id, status FROM rfpilot.conversations WHERE organization_id=$1 ORDER BY id'),
    audit: await rows('SELECT action, target_id, actor_external_user_id FROM rfpilot.audit_events WHERE organization_id=$1 ORDER BY occurred_at, id'),
  };
};

const targets = `--emails=${[email.ana, email.ben, email.ghost].map((e) => e.toLowerCase()).join(',')}`;
let beforeEverything: Map<string, string>;
let adminPasswordHash = '';

before(async () => {
  await ensureServices();
  ensureMigrated();
  await ensureAppRole();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);

  storage.server = http.createServer((request, response) => {
    const objectKey = decodeURIComponent(new URL(request.url ?? '/', 'http://storage').pathname).replace(`/${bucket}/`, '');
    storage.requests.push(`${request.method} ${objectKey}`);
    request.resume();
    if (storage.deny) {
      response.writeHead(403, { 'content-type': 'application/xml' });
      response.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
    } else {
      response.writeHead(204);
      response.end();
    }
  });
  await new Promise<void>((resolve) => storage.server!.listen(0, '127.0.0.1', resolve));
  storage.endpoint = `http://127.0.0.1:${(storage.server.address() as AddressInfo).port}`;

  const now = new Date();
  // ---- the shared organization: Ana and Ben go, Carol and the staff stay --------------------
  await insert('organizations', { _id: org.shared, name: `Shared ${tag}`, slug: `intg-purge-${tag}`, status: 'active', kind: 'customer', plan: 'free_trial' }, false);
  const person = (id: mongoose.Types.ObjectId, name: string, address: string, organizationId = org.shared) =>
    ({ _id: id, organizationId, name, email: address, password: 'x'.repeat(10), role: 'customer', createdAt: now, updatedAt: now });
  await insert('users', person(user.ana, 'Ana', email.ana), true);
  await insert('users', person(user.ben, 'Ben', email.ben), true);
  await insert('users', person(user.carol, 'Carol', email.carol), false);
  await insert('users', { ...person(user.staff, 'Staff', `staff-${tag}@example.test`), role: 'admin' }, false);
  const member = (userId: mongoose.Types.ObjectId, roles: string[], organizationId = org.shared) =>
    ({ organizationId, userId, roles, status: 'active', version: 1, createdAt: now, updatedAt: now });
  await insert('organizationmemberships', member(user.ana, ['planner']), true);
  await insert('organizationmemberships', member(user.ben, ['planner']), true);
  await insert('organizationmemberships', member(user.carol, ['planner']), false);
  await insert('organizationmemberships', member(user.staff, ['dxg_admin']), false);

  // A staff account in the admins collection with Ana's email, its membership and its session.
  const admin = await Admin.create({ _id: user.admin, organizationId: org.shared, name: 'Ana (staff)', email: email.ana.toLowerCase(), password: `staff-secret-${tag}`, role: 'admin' });
  adminPasswordHash = String((await db().collection('admins').findOne({ _id: user.admin }))!.password);
  assert.match(adminPasswordHash, /^\$2/);
  void admin;
  await insert('organizationmemberships', member(user.admin, ['dxg_admin']), false);
  const session = (userId: mongoose.Types.ObjectId, label: string) =>
    ({ organizationId: org.shared, userId, sessionId: `s-${label}-${tag}`, familyId: `f-${label}-${tag}`, tokenId: `t-${label}-${tag}`, tokenHash: `h-${label}-${tag}`, expiresAt: new Date(now.getTime() + 86_400_000), createdAt: now, updatedAt: now });
  await insert('refreshsessions', session(user.admin, 'admin'), false);
  await insert('refreshsessions', session(user.ana, 'ana'), true);
  await insert('refreshsessions', session(user.carol, 'carol'), false);
  await insert('settings', { organizationId: org.shared, userId: user.ana, createdAt: now, updatedAt: now }, true);
  await insert('settings', { organizationId: org.shared, userId: user.carol, createdAt: now, updatedAt: now }, false);

  const rfp = (id: mongoose.Types.ObjectId, owner: mongoose.Types.ObjectId, title: string, extra: Record<string, unknown> = {}, organizationId = org.shared) =>
    ({ _id: id, organizationId, userId: owner, status: 'unsubmitted', isDraft: true, isArchived: false, version: 1, event: { eventName: title }, createdAt: now, updatedAt: now, ...extra });
  await insert('proposals', rfp(proposal.ana1, user.ana, 'Ana one'), true);
  await insert('proposals', rfp(proposal.ana2, user.ana, 'Ana two', { isArchived: true, archivedAt: now }), true);
  await insert('proposals', rfp(proposal.ben1, user.ben, 'Ben one', { status: 'submitted', isDraft: false }), true);
  await insert('proposals', rfp(proposal.carol1, user.carol, 'Carol one'), false);
  // Gil is refused: his proposal has a source document the product's purge cannot tombstone.
  await insert('users', person(user.gil, 'Gil', email.gil), false);
  await insert('organizationmemberships', member(user.gil, ['planner']), false);
  await insert('proposals', rfp(proposal.gil1, user.gil, 'Gil one'), false);

  // Every kind of document that hangs off a proposal: once for a proposal that goes, once for Carol's.
  const dependents = async (proposalId: mongoose.Types.ObjectId, owner: mongoose.Types.ObjectId, label: string, goes: boolean) => {
    const base = { organizationId: org.shared, proposalId, createdAt: now, updatedAt: now };
    const response = await insert('vendorresponses', { ...base, proposalOwnerId: owner, vendorName: 'AV Co', submittedBy: 'Vic', email: `vendor-${label}@example.test`, emailTrackingId: `track-${label}-${tag}` }, goes);
    const grant = await insert('publicaccessgrants', { organizationId: org.shared, resourceType: 'proposal', resourceId: proposalId, purpose: 'vendor_response', tokenHash: `grant-${label}-${tag}`, createdByUserId: owner, policyVersion: 'public-access.v1', expiresAt: new Date(now.getTime() + 86_400_000), useCount: 0, createdAt: now, updatedAt: now }, goes);
    const submission = await insert('vendorsubmissions', { ...base, proposalOwnerId: owner, vendorIdentityKey: `vendor-${label}`, legacyVendorResponseId: response, publicGrantIds: [grant] }, goes);
    const version = await insert('vendorsubmissionversions', { ...base, submissionId: submission, responseId: response, versionNumber: 1, idempotencyKey: `idem-${label}-${tag}`, receivedAt: now }, goes);
    await insert('vendorsubmissiondrafts', { ...base, grantId: grant, status: 'active', draftVersion: 1 }, goes);
    await insert('vendorconfirmationdeliveries', { ...base, submissionId: submission, versionId: version, status: 'accepted', attemptedAt: now }, goes);
    await insert('vendorresponsequestionnaireversions', { ...base, questionnaireVersion: 1, sourceChecksum: `sum-${label}`, status: 'published', questionnaire: { sections: [] } }, goes);
    await insert('proposalcanonicalsnapshots', { organizationId: org.shared, legacyProposalId: proposalId, ownerUserId: String(owner), legacyHash: `hash-${label}`, migrationRelease: `r-${tag}`, createdAt: now, updatedAt: now }, goes);
    await insert('proposalstatustransitions', { organizationId: org.shared, proposalId, fromStage: null, toStage: 'draft', fromStatus: null, toStatus: 'unsubmitted', actorType: 'user', actorUserId: owner, reason: 'created', at: now }, goes);
    await insert('emailcampaigns', { organizationId: org.shared, userId: owner, proposalId, subject: 'RFP', recipients: [{ email: 'vendor@example.test', trackingId: `campaign-${label}-${tag}`, status: 'sent' }], createdAt: now, updatedAt: now }, goes);
  };
  await dependents(proposal.ana1, user.ana, 'ana1', true);
  await dependents(proposal.ben1, user.ben, 'ben1', true);
  await dependents(proposal.carol1, user.carol, 'carol1', false);

  const share = (proposalId: mongoose.Types.ObjectId, userId: mongoose.Types.ObjectId, grantedBy: mongoose.Types.ObjectId) =>
    ({ organizationId: org.shared, proposalId, userId, permission: 'edit', grantedBy, createdAt: now, updatedAt: now });
  // Ana's proposal shared with Carol goes with the proposal. Carol's proposal shared with Ana:
  // the share goes with Ana's account, the proposal stays although Ana could edit it.
  await insert('rfpshares', share(proposal.ana1, user.carol, user.ana), true);
  await insert('rfpshares', share(proposal.carol1, user.ana, user.carol), true);
  // A campaign Ana sent for Carol's proposal is Ana's.
  await insert('emailcampaigns', { organizationId: org.shared, userId: user.ana, proposalId: proposal.carol1, subject: 'From Ana', recipients: [{ email: 'vendor@example.test', trackingId: `campaign-ana-on-carol-${tag}`, status: 'sent' }], createdAt: now, updatedAt: now }, true);
  // Carol's notification about Ana's proposal is Carol's and stays; Ana's own goes.
  await insert('notifications', { organizationId: org.shared, userId: user.carol, proposalId: proposal.ana1, type: 'proposal_shared', title: 'Shared with you', message: 'x', createdAt: now, updatedAt: now }, false);
  await insert('notifications', { organizationId: org.shared, userId: user.ana, proposalId: proposal.carol1, type: 'proposal_shared', title: 'Shared with you', message: 'x', createdAt: now, updatedAt: now }, true);
  // Templates: Ana's personal one goes, the one she published for the organization stays.
  const template = (scope: string, title: string) => ({ organizationId: org.shared, ownerUserId: user.ana, scope, title, description: '', content: {}, archived: false, createdAt: now, updatedAt: now });
  await insert('proposaltemplates', template('personal', `Mine ${tag}`), true);
  await insert('proposaltemplates', { ...template('organization', `Ours ${tag}`), publishedAt: now, publishedBy: user.ana }, false);
  // A team Ana created stays; her place in it goes.
  const team = await insert('teams', { organizationId: org.shared, name: `Team ${tag}`, archived: false, createdBy: user.ana, createdAt: now, updatedAt: now }, false);
  await insert('teammemberships', { organizationId: org.shared, teamId: team, userId: user.ana, isManager: true, createdAt: now, updatedAt: now }, true);
  await insert('teammemberships', { organizationId: org.shared, teamId: team, userId: user.carol, isManager: false, createdAt: now, updatedAt: now }, false);

  // Support: Ana's ticket with her message, a staff reply and three stored files; Carol's ticket.
  const ticket = async (requester: mongoose.Types.ObjectId, number: number, goes: boolean) =>
    insert('supporttickets', { organizationId: org.shared, ticketNumber: number, requesterUserId: requester, assigneeUserId: user.staff, subject: 'Help', category: 'other', priority: 'normal', status: 'open', messageCount: 2, lastMessageAt: now, createdAt: now, updatedAt: now }, goes);
  const attachment = (objectKey: string) => ({ id: crypto.randomUUID(), fileName: 'shot.png', mimeType: 'image/png', sizeBytes: 10, objectKey });
  const stored = (uploader: mongoose.Types.ObjectId, objectKey: string, ticketId: mongoose.Types.ObjectId | null, messageId: mongoose.Types.ObjectId | null) =>
    ({ organizationId: org.shared, uploaderUserId: uploader, attachmentId: crypto.randomUUID(), fileName: 'shot.png', mimeType: 'image/png', sizeBytes: 10, objectKey, status: ticketId ? 'attached' : 'pending', ticketId, messageId, createdAt: now, updatedAt: now });
  const anaTicket = await ticket(user.ana, 900_001, true);
  const anaMessage = await insert('supportmessages', { organizationId: org.shared, ticketId: anaTicket, authorUserId: user.ana, authorRole: 'customer', kind: 'message', body: 'It broke', attachments: [attachment(key.anaAttached)], createdAt: now, updatedAt: now }, true);
  // The staff reply's file exists only on the message, with no attachment row of its own.
  await insert('supportmessages', { organizationId: org.shared, ticketId: anaTicket, authorUserId: user.staff, authorRole: 'agent', kind: 'message', body: 'Try this', attachments: [attachment(key.anaStaffReply)], createdAt: now, updatedAt: now }, true);
  await insert('supportattachments', stored(user.ana, key.anaAttached, anaTicket, anaMessage), true);
  await insert('supportattachments', stored(user.ana, key.anaPending, null, null), true);
  const carolTicket = await ticket(user.carol, 900_002, false);
  const carolMessage = await insert('supportmessages', { organizationId: org.shared, ticketId: carolTicket, authorUserId: user.carol, authorRole: 'customer', kind: 'message', body: 'Mine too', attachments: [attachment(key.carolAttached)], createdAt: now, updatedAt: now }, false);
  await insert('supportattachments', stored(user.carol, key.carolAttached, carolTicket, carolMessage), false);

  // ---- an organization whose Owner would leave a member behind: refused ---------------------
  await insert('organizations', { _id: org.ownerLed, name: `Owner led ${tag}`, slug: `intg-purge-owner-${tag}`, status: 'active', kind: 'customer', plan: 'free_trial' }, false);
  await insert('users', person(user.dora, 'Dora', email.dora, org.ownerLed), false);
  await insert('users', person(user.eve, 'Eve', email.eve, org.ownerLed), false);
  await insert('organizationmemberships', member(user.dora, ['owner'], org.ownerLed), false);
  await insert('organizationmemberships', member(user.eve, ['planner'], org.ownerLed), false);
  // ---- a legacy holding organization: refused ------------------------------------------------
  await insert('organizations', { _id: org.holding, name: `Fay (legacy) ${tag}`, slug: `legacy-${user.fay}`, status: 'active', kind: 'legacy_holding', plan: 'free_trial' }, false);
  await insert('users', person(user.fay, 'Fay', email.fay, org.holding), false);
  await insert('organizationmemberships', member(user.fay, ['planner'], org.holding), false);
  await insert('proposals', rfp(proposal.fay1, user.fay, 'Fay one', {}, org.holding), false);

  // ---- PostgreSQL: Ana's, Carol's and Gil's proposals have a reference, a private source
  // document and a conversation. Ana's second proposal and Ben's have no reference at all.
  // Ana's source is already marked for deletion: the only state the product's purge can tombstone
  // (see TOMBSTONABLE_SOURCE_STATUSES). Gil's is an ordinary ingested document.
  const pool = postgresPool();
  pgShared = (await pool.query<{ id: string }>('INSERT INTO rfpilot.organizations(external_mongo_id,name) VALUES($1,$2) RETURNING id', [String(org.shared), `Shared ${tag}`])).rows[0].id;
  for (const [owner, proposalId, source, objectKey, conversation, status] of [
    [user.ana, proposal.ana1, pg.anaSource, key.anaDocument, pg.anaConversation, 'deletion_pending'],
    [user.carol, proposal.carol1, pg.carolSource, key.carolDocument, pg.carolConversation, 'ready'],
    [user.gil, proposal.gil1, pg.gilSource, key.gilDocument, pg.gilConversation, 'ready'],
  ] as const) {
    const pgUser = (await pool.query<{ id: string }>('INSERT INTO rfpilot.users(organization_id,external_mongo_id) VALUES($1,$2) RETURNING id', [pgShared, String(owner)])).rows[0].id;
    const reference = (await pool.query<{ id: string }>('INSERT INTO rfpilot.proposal_references(organization_id,owner_user_id,external_mongo_id) VALUES($1,$2,$3) RETURNING id', [pgShared, pgUser, String(proposalId)])).rows[0].id;
    await pool.query("INSERT INTO rfpilot.document_sources(id,organization_id,proposal_reference_id,uploader_external_user_id,status) VALUES($1,$2,$3,$4,$5)", [source, pgShared, reference, String(owner), status]);
    await pool.query("INSERT INTO rfpilot.document_objects(id,organization_id,source_id,object_key,original_filename,safe_filename,declared_mime_type,expected_size_bytes) VALUES($1,$2,$3,$4,'brief.pdf','brief.pdf','application/pdf',10)", [crypto.randomUUID(), pgShared, source, objectKey]);
    await pool.query('INSERT INTO rfpilot.conversations(id,organization_id,proposal_reference_id,owner_external_user_id) VALUES($1,$2,$3,$4)', [conversation, pgShared, reference, String(owner)]);
  }
  beforeEverything = await mongoSnapshot();
});

after(async () => {
  await new Promise<void>((resolve) => (storage.server ? storage.server.close(() => resolve()) : resolve()));
  await disconnectMongo();
  await closePostgres();
});

test('without --with-content the script still refuses nothing new and removes no content', async () => {
  // Ana and Ben are not every member, and neither is an Owner: the old dry run lists accounts only.
  const run = await purge(targets);
  assert.equal(run.status, 0, explain(run));
  assert.equal(run.report?.mode, 'dry-run');
  assert.deepEqual(Object.keys(run.report!), ['mode', 'database', 'users', 'withoutAccount', 'organizationsRemoved', 'refused', 'wouldDelete']);
  assert.equal(run.report!.wouldDelete.users, 2);
  assertSameDocuments(await mongoSnapshot(), beforeEverything, 'the old dry run wrote to MongoDB');
});

test('the dry run reports every account and writes nothing to MongoDB, PostgreSQL or storage', async () => {
  const postgresBefore = await postgresSnapshot();
  const run = await purge(targets, '--with-content');
  assert.equal(run.status, 0, explain(run));
  const report = run.report!;
  assert.equal(report.mode, 'dry-run', explain(run));
  assert.equal(report.database, TEST_MONGODB_DB_NAME);
  assert.equal(report.privateSourceDocuments, 1, "Ana's, read from PostgreSQL");
  assert.deepEqual(report.users.sort(), [email.ana, email.ben].sort(), 'matched whatever the stored capitals');
  assert.deepEqual(report.withoutAccount, [email.ghost], 'an address with no account is reported, not an error');
  assert.deepEqual(report.refused, []);
  assert.deepEqual(report.organizationsRemoved, [], 'Carol and the staff keep the organization');

  const ana = report.accounts.find((a: { email: string }) => a.email === email.ana);
  const ben = report.accounts.find((a: { email: string }) => a.email === email.ben);
  assert.deepEqual(ana.organizations, [{ organization: `Shared ${tag} (customer)`, id: String(org.shared), roles: ['planner'], status: 'active' }]);
  assert.deepEqual(ana.proposals, { count: 2, withTitle: 2, alreadyArchived: 1, ids: [String(proposal.ana1), String(proposal.ana2)].sort() });
  assert.deepEqual(ben.proposals, { count: 1, withTitle: 1, alreadyArchived: 0, ids: [String(proposal.ben1)] });
  assert.deepEqual(ana.wouldDelete, {
    proposals: 2, vendorresponses: 1, vendorsubmissions: 1, vendorsubmissionversions: 1, vendorsubmissiondrafts: 1, vendorconfirmationdeliveries: 1,
    vendorresponsequestionnaireversions: 1, proposalcanonicalsnapshots: 1, publicaccessgrants: 1, proposalstatustransitions: 1, rfpshares: 1,
    emailcampaigns: 2, proposaltemplates: 1, supporttickets: 1, supportmessages: 2, supportattachments: 2, storedSupportFiles: 3,
  });
  assert.equal(ben.wouldDelete.proposals, 1);
  assert.equal(ben.wouldDelete.emailcampaigns, 1);
  assert.equal(report.wouldDelete.content.proposals, 3);
  assert.equal(report.wouldDelete.accounts.users, 2);
  assert.equal(report.wouldDelete.accounts.organizationMemberships, 2);
  assert.ok(report.stays.some((s: { what: string }) => /rfpilot\.users and rfpilot\.proposal_references/.test(s.what)));
  assert.ok(report.stays.some((s: { what: string }) => /security audit events/.test(s.what)));
  assert.ok(report.removedBeyondTheProductPath.includes('vendorresponses'));
  // Ids and counts only: no title, no vendor name, no message text.
  assert.doesNotMatch(run.stdout, /Ana one|Ana two|Ben one|AV Co|It broke/);

  assertSameDocuments(await mongoSnapshot(), beforeEverything, 'the dry run wrote to MongoDB');
  assert.deepEqual(await postgresSnapshot(), postgresBefore, 'the dry run wrote to PostgreSQL');
  assert.deepEqual(storage.requests, [], 'the dry run called storage');
});

test('an Owner who would leave members behind, and a legacy holding organization, refuse the whole run', async () => {
  const postgresBeforeRefusals = await postgresSnapshot();
  const ownerLed = await purge(`--emails=${email.dora},${email.ana.toLowerCase()}`, '--with-content', '--apply');
  assert.equal(ownerLed.status, 1, explain(ownerLed));
  assert.equal(ownerLed.report?.mode, 'refused');
  assert.match(ownerLed.report!.refused.join('\n'), /its Owner is being removed but 1 other member\(s\) stay/);

  const holding = await purge(`--emails=${email.fay},${email.ben}`, '--with-content', '--apply');
  assert.equal(holding.status, 1, explain(holding));
  assert.equal(holding.report?.mode, 'refused');
  assert.match(holding.report!.refused.join('\n'), /kind legacy_holding/);

  // A source document the product's purge cannot tombstone: refused in the dry run and in apply.
  for (const flags of [[], ['--apply']]) {
    const source = await purge(`--emails=${email.gil},${email.ben}`, '--with-content', ...flags);
    assert.equal(source.status, 1, explain(source));
    assert.equal(source.report?.mode, 'refused');
    assert.match(source.report!.refused.join('\n'), new RegExp(`proposal ${proposal.gil1}: 1 private source document\\(s\\) in status ready`));
  }

  // Refused means nothing at all was deleted, for the accounts that were fine too.
  assertSameDocuments(await mongoSnapshot(), beforeEverything, 'a refused run wrote to MongoDB');
  assert.deepEqual(storage.requests, []);
  assert.deepEqual(await postgresSnapshot(), postgresBeforeRefusals, 'a refused run wrote to PostgreSQL');
});

test('when a stored file cannot be deleted the run stops and no account is removed', async () => {
  storage.deny = true;
  const run = await purge(targets, '--with-content', '--apply');
  storage.deny = false;
  assert.equal(run.status, 1, explain(run));
  assert.equal(run.report?.mode, 'failed', explain(run));
  assert.equal(run.report!.failed.email, email.ana, explain(run));
  assert.equal(run.report!.failed.step, 'deleting a stored support attachment', explain(run));
  assert.deepEqual(run.report!.accountsRemoved, []);
  // Ana's proposals went through the product before the file failed; her account and her ticket did not go.
  assert.equal(await db().collection('proposals').countDocuments({ userId: user.ana }), 0);
  assert.equal(await db().collection('users').countDocuments({ _id: { $in: [user.ana, user.ben] } }), 2);
  assert.equal(await db().collection('organizationmemberships').countDocuments({ userId: { $in: [user.ana, user.ben] } }), 2);
  assert.equal(await db().collection('supporttickets').countDocuments({ requesterUserId: user.ana }), 1);
  assert.equal(await db().collection('supportattachments').countDocuments({ uploaderUserId: user.ana }), 2);
  // The run stopped at Ana: Ben was not started.
  assert.equal(await db().collection('proposals').countDocuments({ _id: proposal.ben1 }), 1);
  assert.equal(await db().collection('vendorresponses').countDocuments({ proposalId: proposal.ben1 }), 1);
});

test('apply removes exactly the purged accounts and their content', async () => {
  const run = await purge(targets, '--with-content', '--apply');
  assert.equal(run.status, 0, explain(run));
  const report = run.report!;
  assert.equal(report.mode, 'applied', explain(run));
  assert.equal(report.deleted.accounts.users, 2, explain(run));
  assert.equal(report.deleted.accounts.organizationMemberships, 2);
  assert.equal(report.deleted.accounts.organizations, 0);
  assert.equal(report.deleted.content.proposals, 1, `Ben's; Ana's two went in the run that stopped\n${explain(run)}`);
  assert.equal(report.deleted.content.supporttickets, 1);
  assert.equal(report.deleted.content.storedSupportFiles, 3);
  assert.deepEqual(report.ownerCheck.newlyWithoutActiveOwner, []);
  assert.deepEqual(report.ownerCheck.stillOwnedByRemovedAccounts, []);

  // Everything else in the database is byte-identical: Carol, her proposal and everything under
  // it, her ticket, the staff user, the admin record with Ana's email, its membership and its
  // session, the organization, the team, the organization template, the other organizations.
  assertSameDocuments(await mongoSnapshot(), without(beforeEverything, going), 'apply changed something it should not have, or left something behind');
  for (const [collection, ids] of going) {
    assert.equal(await db().collection(collection).countDocuments({ _id: { $in: [...ids].map((id) => new mongoose.Types.ObjectId(id)) } }), 0, collection);
  }
});

test('the staff account with the same email is untouched and can still sign in', async () => {
  const admin = await Admin.findOne({ email: email.ana.toLowerCase() }).select('+password');
  assert.ok(admin);
  assert.equal(String(admin._id), String(user.admin));
  assert.equal(String(admin.password), adminPasswordHash);
  assert.equal(await bcrypt.compare(`staff-secret-${tag}`, String(admin.password)), true);
  assert.equal(await db().collection('organizationmemberships').countDocuments({ organizationId: org.shared, userId: user.admin, status: 'active' }), 1);
  assert.equal(await db().collection('refreshsessions').countDocuments({ userId: user.admin }), 1);
  assert.equal(await db().collection('users').countDocuments({ email: new RegExp(`^${email.ana.replace(/[.]/g, '\\.')}$`, 'i') }), 0, 'the customer account is gone');
});

test("a proposal the purged account could edit, but did not own, is still there with everything under it", async () => {
  assert.equal(await db().collection('proposals').countDocuments({ _id: proposal.carol1, userId: user.carol, isArchived: false }), 1);
  for (const collection of ['vendorresponses', 'vendorsubmissions', 'vendorsubmissionversions', 'vendorsubmissiondrafts', 'vendorconfirmationdeliveries', 'vendorresponsequestionnaireversions', 'proposalstatustransitions']) {
    assert.equal(await db().collection(collection).countDocuments({ proposalId: proposal.carol1 }), 1, collection);
  }
  assert.equal(await db().collection('publicaccessgrants').countDocuments({ resourceId: proposal.carol1 }), 1);
  assert.equal(await db().collection('proposalcanonicalsnapshots').countDocuments({ legacyProposalId: proposal.carol1 }), 1);
  assert.equal(await db().collection('emailcampaigns').countDocuments({ proposalId: proposal.carol1 }), 1, "Carol's campaign stays, Ana's on the same proposal is gone");
});

test('no proposal in the organization is left without an active owner', async () => {
  const orphans = await findOrphanedProposals({ organizationId: String(org.shared) });
  assert.equal(orphans.total, 0);
  assert.equal(await db().collection('proposals').countDocuments({ organizationId: org.shared }), 2, "Carol's and Gil's");
});

test('storage was asked to delete the purged files and no others', async () => {
  assert.deepEqual(storage.requests.filter((r) => !r.startsWith('DELETE ')), []);
  assert.deepEqual([...new Set(deletedKeys())].sort(), [key.anaDocument, key.anaAttached, key.anaPending, key.anaStaffReply].sort());
});

test('PostgreSQL keeps its rows: the source is tombstoned, the conversation archived, the rest as it was', async () => {
  const pool = postgresPool();
  const source = async (id: string) => (await pool.query('SELECT status, deleted_at FROM rfpilot.document_sources WHERE id=$1', [id])).rows[0];
  assert.equal((await source(pg.anaSource)).status, 'deleted', `audit events: ${(await postgresSnapshot()).audit}`);
  assert.ok((await source(pg.anaSource)).deleted_at);
  assert.equal((await source(pg.carolSource)).status, 'ready');
  assert.equal((await source(pg.carolSource)).deleted_at, null);
  assert.equal((await source(pg.gilSource)).status, 'ready');
  const conversation = async (id: string) => (await pool.query('SELECT status FROM rfpilot.conversations WHERE id=$1', [id])).rows[0].status;
  assert.equal(await conversation(pg.anaConversation), 'archived');
  assert.equal(await conversation(pg.carolConversation), 'active');
  // The retained rows the report promises: both users and both references are still there.
  assert.equal(Number((await pool.query('SELECT count(*) FROM rfpilot.users WHERE organization_id=$1', [pgShared])).rows[0].count), 3);
  assert.equal(Number((await pool.query('SELECT count(*) FROM rfpilot.proposal_references WHERE organization_id=$1', [pgShared])).rows[0].count), 3);
  const audit = (await pool.query("SELECT count(*) FROM rfpilot.audit_events WHERE organization_id=$1 AND action='proposal_artifacts_purged'", [pgShared])).rows[0].count;
  assert.equal(Number(audit), 1, 'one audit event, for the one proposal that had a reference');
});

test('a second apply with the same emails finds nothing', async () => {
  const requests = storage.requests.length;
  const snapshot = await mongoSnapshot();
  const postgresBefore = await postgresSnapshot();
  const run = await purge(targets, '--with-content', '--apply');
  assert.equal(run.status, 0, explain(run));
  assert.equal(run.report?.mode, 'nothing-found');
  assert.deepEqual(run.report!.users, []);
  assert.deepEqual(run.report!.withoutAccount.sort(), [email.ana.toLowerCase(), email.ben, email.ghost].sort());
  assertSameDocuments(await mongoSnapshot(), snapshot, 'the second apply wrote to MongoDB');
  assert.deepEqual(await postgresSnapshot(), postgresBefore);
  assert.equal(storage.requests.length, requests);
});
