// purgeProposalArtifacts, the step behind "permanently delete" and the 30-day archive sweep, run
// the way the API runs it: as the application role under forced row-level security, with the
// real transition trigger on rfpilot.document_sources, and with storage pointed at a local
// stand-in that records every request it receives.
import { TEST_APP_ROLE_URL, TEST_POSTGRES_URL } from './env';
import { ensureAppRole, ensureMigrated, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { closePostgres, postgresPool, withPostgresTransaction } from '../config/postgres';
import { purgeProposalArtifacts } from '../src/modules/dataFoundation/purgeProposalArtifacts';

const tag = randomMongoId().slice(0, 10);
const SYSTEM_ACTOR = '000000000000000000000000';

// ---- storage stand-in ---------------------------------------------------------------------------
const bucket = `purge-artifacts-${tag}`;
const storage = { requests: [] as string[], denied: new Set<string>(), server: null as http.Server | null };
const deleteRequests = (objectKey: string) => storage.requests.filter((request) => request === `DELETE ${objectKey}`).length;

// ---- fixtures (written by the migration role, which is not subject to row-level security) -------
let admin: Pool;

type Fixture = { organizationId: string; organizationMongoId: string; referenceId: string; proposalMongoId: string; conversationId: string };

const seedProposal = async (label: string, existing?: Fixture): Promise<Fixture> => {
  const organizationMongoId = existing?.organizationMongoId ?? randomMongoId();
  const proposalMongoId = randomMongoId();
  let organizationId = existing?.organizationId;
  if (!organizationId) {
    organizationId = (await admin.query<{ id: string }>(
      'INSERT INTO rfpilot.organizations(external_mongo_id,name) VALUES($1,$2) RETURNING id',
      [organizationMongoId, `Purge ${label} ${tag}`],
    )).rows[0].id;
  }
  const userId = (await admin.query<{ id: string }>(
    'INSERT INTO rfpilot.users(organization_id,external_mongo_id) VALUES($1,$2) RETURNING id',
    [organizationId, randomMongoId()],
  )).rows[0].id;
  const referenceId = (await admin.query<{ id: string }>(
    'INSERT INTO rfpilot.proposal_references(organization_id,owner_user_id,external_mongo_id) VALUES($1,$2,$3) RETURNING id',
    [organizationId, userId, proposalMongoId],
  )).rows[0].id;
  const conversationId = crypto.randomUUID();
  await admin.query(
    'INSERT INTO rfpilot.conversations(id,organization_id,proposal_reference_id,owner_external_user_id) VALUES($1,$2,$3,$4)',
    [conversationId, organizationId, referenceId, randomMongoId()],
  );
  return { organizationId, organizationMongoId, referenceId, proposalMongoId, conversationId };
};

type SourceOptions = { withObject?: boolean; legalHold?: boolean; retentionDays?: number };
const seedSource = async (fixture: Fixture, status: string, options: SourceOptions = {}) => {
  const id = crypto.randomUUID();
  await admin.query(
    `INSERT INTO rfpilot.document_sources(id,organization_id,proposal_reference_id,uploader_external_user_id,status,legal_hold,retention_until,deleted_at)
     VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(days => $7::int) END,CASE WHEN $5='deleted' THEN now() - interval '1 day' ELSE NULL END)`,
    [id, fixture.organizationId, fixture.referenceId, randomMongoId(), status, options.legalHold ?? false, options.retentionDays ?? null],
  );
  const objectKey = `quarantine/${fixture.organizationMongoId}/${id}/original.pdf`;
  if (options.withObject !== false) {
    await admin.query(
      `INSERT INTO rfpilot.document_objects(id,organization_id,source_id,object_key,original_filename,safe_filename,declared_mime_type,expected_size_bytes)
       VALUES($1,$2,$3,$4,'brief.pdf','brief.pdf','application/pdf',1024)`,
      [crypto.randomUUID(), fixture.organizationId, id, objectKey],
    );
  }
  return { id, objectKey };
};

const sourceRow = async (id: string) =>
  (await admin.query<{ status: string; deleted_at: Date | null; updated_at: Date }>(
    'SELECT status, deleted_at, updated_at FROM rfpilot.document_sources WHERE id=$1', [id],
  )).rows[0];
const conversationStatus = async (fixture: Fixture) =>
  (await admin.query<{ status: string }>('SELECT status FROM rfpilot.conversations WHERE id=$1', [fixture.conversationId])).rows[0].status;
const purgeEvents = async (fixture: Fixture) =>
  (await admin.query<{ actor_external_user_id: string; target_type: string; target_id: string; decision: string; metadata: Record<string, unknown> }>(
    `SELECT actor_external_user_id, target_type, target_id, decision, metadata FROM rfpilot.audit_events
      WHERE organization_id=$1 AND action='proposal_artifacts_purged' AND target_id=$2 ORDER BY occurred_at, id`,
    [fixture.organizationId, fixture.referenceId],
  )).rows;
const purge = async (fixture: Fixture) => {
  const results = await purgeProposalArtifacts([{ proposalMongoId: fixture.proposalMongoId, organizationMongoId: fixture.organizationMongoId }]);
  assert.equal(results.length, 1);
  return results[0];
};

before(async () => {
  admin = new Pool({ connectionString: TEST_POSTGRES_URL, max: 2 });
  try {
    await admin.query('SELECT 1');
  } catch (error) {
    throw new Error(`integration services are not reachable; start them with \`npm run integration:up\`. ${String(error)}`);
  }
  ensureMigrated();
  await ensureAppRole(admin);

  // From here on the code under test connects as the application role.
  await closePostgres();
  process.env.POSTGRES_URL = TEST_APP_ROLE_URL;
  const role = (await postgresPool().query<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  )).rows[0];
  assert.deepEqual(role, { role: 'rfpilot_app', rolsuper: false, rolbypassrls: false });
  const guards = (await admin.query<{ forced: boolean; triggers: number }>(
    `SELECT c.relforcerowsecurity AS forced,
            (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'document_source_transition' AND t.tgenabled <> 'D') AS triggers
       FROM pg_class c WHERE c.oid = 'rfpilot.document_sources'::regclass`,
  )).rows[0];
  assert.deepEqual(guards, { forced: true, triggers: 1 });

  storage.server = http.createServer((request, response) => {
    const objectKey = decodeURIComponent(new URL(request.url ?? '/', 'http://storage').pathname).replace(`/${bucket}/`, '');
    storage.requests.push(`${request.method} ${objectKey}`);
    request.resume();
    if (storage.denied.has(objectKey)) {
      response.writeHead(403, { 'content-type': 'application/xml' });
      response.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
    } else {
      response.writeHead(204);
      response.end();
    }
  });
  await new Promise<void>((resolve) => storage.server!.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, {
    DOCUMENT_STORAGE_BUCKET: bucket,
    DOCUMENT_STORAGE_REGION: 'us-east-1',
    DOCUMENT_STORAGE_ENDPOINT: `http://127.0.0.1:${(storage.server.address() as AddressInfo).port}`,
    DOCUMENT_STORAGE_FORCE_PATH_STYLE: 'true',
    DOCUMENT_STORAGE_KEY: 'test',
    DOCUMENT_STORAGE_SECRET: 'test',
  });
});

after(async () => {
  storage.server?.closeAllConnections();
  storage.server?.close();
  await admin?.end();
  await closePostgres();
});

test('the database refuses a ready source written straight to deleted, also for the application role', async () => {
  // The statement the purge used to run. This is why it never tombstoned anything.
  const fixture = await seedProposal('trigger');
  const source = await seedSource(fixture, 'ready');
  await assert.rejects(
    withPostgresTransaction(async (client) => {
      await client.query("SELECT set_config('app.organization_id',$1,true)", [fixture.organizationId]);
      await client.query("UPDATE rfpilot.document_sources SET deleted_at=now(),status='deleted',updated_at=now() WHERE id=$1", [source.id]);
    }),
    /invalid document source transition: ready -> deleted/,
  );
  assert.equal((await sourceRow(source.id)).status, 'ready');
});

test('a ready source is tombstoned, its object deleted once, the conversation archived and the purge audited', async () => {
  const fixture = await seedProposal('ready');
  const source = await seedSource(fixture, 'ready');

  const result = await purge(fixture);

  assert.deepEqual(result, {
    proposalMongoId: fixture.proposalMongoId,
    organizationMongoId: fixture.organizationMongoId,
    complete: true,
    sources: { tombstoned: 1, pending: 0, blocked: 0 },
  });
  const row = await sourceRow(source.id);
  assert.equal(row.status, 'deleted');
  assert.ok(row.deleted_at instanceof Date);
  assert.equal(deleteRequests(source.objectKey), 1);
  assert.equal(await conversationStatus(fixture), 'archived');
  assert.deepEqual(await purgeEvents(fixture), [{
    actor_external_user_id: SYSTEM_ACTOR, target_type: 'proposal', target_id: fixture.referenceId, decision: 'allowed', metadata: { count: 1 },
  }]);
});

test('a source in every other live status is tombstoned, including one that is being scanned', async () => {
  const fixture = await seedProposal('statuses');
  const statuses = ['pending_upload', 'uploaded', 'scanning', 'scan_failed', 'blocked', 'deletion_pending'];
  const sources = new Map<string, { id: string; objectKey: string }>();
  for (const status of statuses) sources.set(status, await seedSource(fixture, status));
  // An upload session whose bytes never arrived has no object row, so there is nothing to delete from storage.
  const neverUploaded = await seedSource(fixture, 'pending_upload', { withObject: false });
  // Deleted earlier by its owner: not live, so the purge leaves it exactly as it is.
  const alreadyDeleted = await seedSource(fixture, 'deleted');
  const deletedBefore = await sourceRow(alreadyDeleted.id);

  const result = await purge(fixture);

  assert.equal(result.complete, true);
  assert.deepEqual(result.sources, { tombstoned: statuses.length + 1, pending: 0, blocked: 0 });
  for (const [status, source] of sources) {
    const row = await sourceRow(source.id);
    assert.equal(row.status, 'deleted', `${status} source is tombstoned`);
    assert.ok(row.deleted_at instanceof Date, `${status} source has deleted_at`);
    assert.equal(deleteRequests(source.objectKey), 1, `${status} source's object is deleted once`);
  }
  assert.equal((await sourceRow(neverUploaded.id)).status, 'deleted');
  assert.equal(deleteRequests(neverUploaded.objectKey), 0);
  assert.deepEqual(await sourceRow(alreadyDeleted.id), deletedBefore);
  assert.equal(deleteRequests(alreadyDeleted.objectKey), 0);
  assert.equal(await conversationStatus(fixture), 'archived');
  assert.deepEqual((await purgeEvents(fixture)).map((event) => event.metadata), [{ count: statuses.length + 1 }]);
});

test('a storage failure leaves the source deletion_pending and unaudited, and a second run finishes it', async () => {
  const fixture = await seedProposal('storage-failure');
  const failing = await seedSource(fixture, 'ready');
  const fine = await seedSource(fixture, 'ready');
  storage.denied.add(failing.objectKey);

  const first = await purge(fixture);

  assert.equal(first.complete, false);
  assert.equal(first.errorCode, 'AccessDenied');
  assert.deepEqual(first.sources, { tombstoned: 1, pending: 1, blocked: 0 });
  const stuck = await sourceRow(failing.id);
  assert.equal(stuck.status, 'deletion_pending', 'never "file may still exist, row says deleted", never "row still ready"');
  assert.equal(stuck.deleted_at, null);
  assert.equal((await sourceRow(fine.id)).status, 'deleted');
  assert.equal(await conversationStatus(fixture), 'active');
  assert.deepEqual(await purgeEvents(fixture), []);
  assert.equal(deleteRequests(failing.objectKey), 1);
  assert.equal(deleteRequests(fine.objectKey), 1);

  storage.denied.delete(failing.objectKey);
  const second = await purge(fixture);

  assert.equal(second.complete, true);
  assert.equal(second.errorCode, undefined);
  assert.deepEqual(second.sources, { tombstoned: 1, pending: 0, blocked: 0 });
  const finished = await sourceRow(failing.id);
  assert.equal(finished.status, 'deleted');
  assert.ok(finished.deleted_at instanceof Date);
  assert.equal(deleteRequests(failing.objectKey), 2);
  assert.equal(deleteRequests(fine.objectKey), 1, 'the source finished by the first run is not touched again');
  assert.equal(await conversationStatus(fixture), 'archived');
  assert.deepEqual((await purgeEvents(fixture)).map((event) => event.metadata), [{ count: 1 }]);
});

test('a source under legal hold or retention, or with no allowed way to deleted, is left alone and reported', async () => {
  const fixture = await seedProposal('blocked');
  const held = await seedSource(fixture, 'ready', { legalHold: true });
  const retained = await seedSource(fixture, 'ready', { retentionDays: 30 });
  const expired = await seedSource(fixture, 'expired');
  const ordinary = await seedSource(fixture, 'ready');
  const before = { held: await sourceRow(held.id), retained: await sourceRow(retained.id), expired: await sourceRow(expired.id) };

  const result = await purge(fixture);

  assert.equal(result.complete, false);
  assert.equal(result.errorCode, 'SOURCE_NOT_DELETABLE');
  assert.deepEqual(result.sources, { tombstoned: 1, pending: 0, blocked: 3 });
  assert.deepEqual({ held: await sourceRow(held.id), retained: await sourceRow(retained.id), expired: await sourceRow(expired.id) }, before);
  for (const source of [held, retained, expired]) assert.equal(deleteRequests(source.objectKey), 0);
  assert.equal((await sourceRow(ordinary.id)).status, 'deleted');
  assert.equal(deleteRequests(ordinary.objectKey), 1);
  assert.equal(await conversationStatus(fixture), 'active');
  assert.deepEqual(await purgeEvents(fixture), []);
});

test('a proposal with no sources is closed out: conversation archived, one audit event with a zero count', async () => {
  const fixture = await seedProposal('empty');
  const requestsBefore = storage.requests.length;

  const result = await purge(fixture);

  assert.equal(result.complete, true);
  assert.deepEqual(result.sources, { tombstoned: 0, pending: 0, blocked: 0 });
  assert.equal(storage.requests.length, requestsBefore);
  assert.equal(await conversationStatus(fixture), 'archived');
  assert.deepEqual((await purgeEvents(fixture)).map((event) => event.metadata), [{ count: 0 }]);
});

test('another organization, and another proposal of the same organization, are untouched', async () => {
  const mine = await seedProposal('mine');
  const mySource = await seedSource(mine, 'ready');
  const sibling = await seedProposal('sibling', mine);
  const siblingSource = await seedSource(sibling, 'ready');
  const foreign = await seedProposal('foreign');
  const foreignSource = await seedSource(foreign, 'ready');
  const untouched = async () => ({
    sibling: await sourceRow(siblingSource.id), siblingConversation: await conversationStatus(sibling), siblingEvents: await purgeEvents(sibling),
    foreign: await sourceRow(foreignSource.id), foreignConversation: await conversationStatus(foreign),
    foreignAudit: (await admin.query('SELECT count(*)::int AS n FROM rfpilot.audit_events WHERE organization_id=$1', [foreign.organizationId])).rows[0].n,
  });
  const before = await untouched();
  assert.equal(before.foreign.status, 'ready');

  assert.equal((await purge(mine)).complete, true);
  assert.equal((await sourceRow(mySource.id)).status, 'deleted');
  assert.deepEqual(await untouched(), before);

  // The foreign proposal named under my organization resolves nothing: the tenant comes from the
  // caller's organization, and row-level security hides the other organization's reference.
  const crossed = await purgeProposalArtifacts([{ proposalMongoId: foreign.proposalMongoId, organizationMongoId: mine.organizationMongoId }]);
  assert.deepEqual(crossed, [{
    proposalMongoId: foreign.proposalMongoId, organizationMongoId: mine.organizationMongoId,
    complete: true, skipped: 'proposal_reference_not_found', sources: { tombstoned: 0, pending: 0, blocked: 0 },
  }]);
  assert.deepEqual(await untouched(), before);
  assert.equal(deleteRequests(siblingSource.objectKey), 0);
  assert.equal(deleteRequests(foreignSource.objectKey), 0);
});

test('calling it a second time changes nothing', async () => {
  const fixture = await seedProposal('twice');
  const source = await seedSource(fixture, 'ready');
  assert.equal((await purge(fixture)).complete, true);
  const snapshot = async () => ({
    source: await sourceRow(source.id),
    conversation: (await admin.query('SELECT status, updated_at FROM rfpilot.conversations WHERE id=$1', [fixture.conversationId])).rows[0],
    audit: (await admin.query('SELECT count(*)::int AS n FROM rfpilot.audit_events WHERE organization_id=$1', [fixture.organizationId])).rows[0].n,
    requests: storage.requests.length,
  });
  const afterFirst = await snapshot();
  assert.equal(afterFirst.audit, 1);

  const second = await purge(fixture);

  assert.equal(second.complete, true);
  assert.deepEqual(second.sources, { tombstoned: 0, pending: 0, blocked: 0 });
  assert.deepEqual(await snapshot(), afterFirst);
  assert.equal(deleteRequests(source.objectKey), 1);
});
