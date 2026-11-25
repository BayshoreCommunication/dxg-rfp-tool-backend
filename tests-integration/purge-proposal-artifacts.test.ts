// purgeProposalArtifacts, the step behind "permanently delete" and the 30-day archive sweep, run
// the way the API runs it: as the application role under forced row-level security, with the
// real transition trigger on rfpilot.document_sources, and with storage pointed at a local
// stand-in that records every request it receives and knows which objects exist.
import './env';
import { randomMongoId } from './setup';
import {
  SYSTEM_ACTOR, admin, conversationStatus, deleteRequests, purgeEvents, seedProposal, seedSource, sourceRow,
  startPurgeEnvironment, stopPurgeEnvironment, storage, type Fixture,
} from './purgeFixtures';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withPostgresTransaction } from '../config/postgres';
import { purgeProposalArtifacts } from '../src/modules/dataFoundation/purgeProposalArtifacts';
import { postgresDocumentRepository } from '../src/modules/documentIngestion/postgresDocumentRepository';

const purge = async (fixture: Fixture) => {
  const results = await purgeProposalArtifacts([{ proposalMongoId: fixture.proposalMongoId, organizationMongoId: fixture.organizationMongoId }]);
  assert.equal(results.length, 1);
  return results[0];
};

before(startPurgeEnvironment);
after(stopPurgeEnvironment);

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
    sources: { tombstoned: 1, pending: 0, notDeletable: 0 },
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
  assert.deepEqual(result.sources, { tombstoned: statuses.length + 1, pending: 0, notDeletable: 0 });
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
  // Every tombstoned source of the proposal, the one its owner deleted earlier included.
  assert.deepEqual((await purgeEvents(fixture)).map((event) => event.metadata), [{ count: statuses.length + 2 }]);
});

test('a storage failure leaves the source deletion_pending and unaudited, and a second run finishes it', async () => {
  const fixture = await seedProposal('storage-failure');
  const failing = await seedSource(fixture, 'ready');
  const fine = await seedSource(fixture, 'ready');
  storage.denied.add(failing.objectKey);

  const first = await purge(fixture);

  assert.equal(first.complete, false);
  assert.equal(first.errorCode, 'AccessDenied');
  assert.deepEqual(first.sources, { tombstoned: 1, pending: 1, notDeletable: 0 });
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
  assert.deepEqual(second.sources, { tombstoned: 1, pending: 0, notDeletable: 0 });
  const finished = await sourceRow(failing.id);
  assert.equal(finished.status, 'deleted');
  assert.ok(finished.deleted_at instanceof Date);
  assert.equal(deleteRequests(failing.objectKey), 2);
  assert.equal(deleteRequests(fine.objectKey), 1, 'the source finished by the first run is not touched again');
  assert.equal(await conversationStatus(fixture), 'archived');
  // Both sources, although the first run tombstoned one of them.
  assert.deepEqual((await purgeEvents(fixture)).map((event) => event.metadata), [{ count: 2 }]);
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
  assert.deepEqual(result.sources, { tombstoned: 1, pending: 0, notDeletable: 3 });
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
  assert.deepEqual(result.sources, { tombstoned: 0, pending: 0, notDeletable: 0 });
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
    complete: true, skipped: 'proposal_reference_not_found', sources: { tombstoned: 0, pending: 0, notDeletable: 0 },
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
  assert.deepEqual(second.sources, { tombstoned: 0, pending: 0, notDeletable: 0 });
  assert.deepEqual(await snapshot(), afterFirst);
  assert.equal(deleteRequests(source.objectKey), 1);
});

test('an object that is already missing from storage counts as deleted', async () => {
  const fixture = await seedProposal('missing-object');
  const source = await seedSource(fixture, 'ready', { inStorage: false });

  const result = await purge(fixture);

  assert.equal(deleteRequests(source.objectKey), 1, 'the stand-in answered 404 NoSuchKey');
  assert.equal(result.complete, true);
  assert.deepEqual(result.sources, { tombstoned: 1, pending: 0, notDeletable: 0 });
  assert.equal((await sourceRow(source.id)).status, 'deleted');
});

test('a 5xx from storage leaves the source deletion_pending, and the next run finishes it', async () => {
  const fixture = await seedProposal('storage-5xx');
  const source = await seedSource(fixture, 'ready');
  storage.failing.add(source.objectKey);

  const first = await purge(fixture);

  assert.equal(first.complete, false);
  assert.equal(first.errorCode, 'InternalError');
  assert.deepEqual(first.sources, { tombstoned: 0, pending: 1, notDeletable: 0 });
  assert.equal((await sourceRow(source.id)).status, 'deletion_pending');
  assert.ok(deleteRequests(source.objectKey) >= 1);
  assert.deepEqual(await purgeEvents(fixture), []);
  assert.equal(await conversationStatus(fixture), 'active');

  storage.failing.delete(source.objectKey);
  assert.equal((await purge(fixture)).complete, true);
  assert.equal((await sourceRow(source.id)).status, 'deleted');
  assert.deepEqual((await purgeEvents(fixture)).map((event) => event.metadata), [{ count: 1 }]);
});

test('a failure of the last step, after the object is gone, leaves deletion_pending and a rerun completes', async () => {
  const fixture = await seedProposal('step-three');
  const source = await seedSource(fixture, 'ready');
  // While the object is being deleted, another session takes the source row and keeps it, so
  // the tombstone that follows waits for the lock and gives up (lock_timeout is 5 seconds).
  const blocker = await admin.connect();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await blocker.query('ROLLBACK');
    blocker.release();
  };
  storage.onDelete.set(source.objectKey, async () => {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM rfpilot.document_sources WHERE id=$1 FOR UPDATE', [source.id]);
  });
  try {
    const first = await purge(fixture);

    assert.equal(first.complete, false);
    assert.equal(first.errorCode, '55P03', 'lock_not_available from the tombstone step');
    assert.equal(storage.objects.has(source.objectKey), false, 'the object is gone');
    const stuck = await sourceRow(source.id);
    assert.equal(stuck.status, 'deletion_pending');
    assert.equal(stuck.deleted_at, null);
    assert.equal(await conversationStatus(fixture), 'active');
    assert.deepEqual(await purgeEvents(fixture), []);
  } finally {
    storage.onDelete.delete(source.objectKey);
    await release();
  }

  const second = await purge(fixture);

  assert.equal(second.complete, true);
  assert.deepEqual(second.sources, { tombstoned: 1, pending: 0, notDeletable: 0 });
  assert.equal(deleteRequests(source.objectKey), 2, 'asked again; the object was already gone');
  assert.equal((await sourceRow(source.id)).status, 'deleted');
  assert.equal(await conversationStatus(fixture), 'archived');
  assert.deepEqual((await purgeEvents(fixture)).map((event) => event.metadata), [{ count: 1 }]);
});

test('two purges of the same proposal at once tombstone each source once and write one audit event', async () => {
  const fixture = await seedProposal('concurrent');
  const sources = [await seedSource(fixture, 'ready'), await seedSource(fixture, 'uploaded'), await seedSource(fixture, 'scanning')];

  const [one, two] = await Promise.all([purge(fixture), purge(fixture)]);

  assert.equal(one.complete, true);
  assert.equal(two.complete, true);
  assert.equal(one.sources.tombstoned + two.sources.tombstoned, sources.length);
  for (const source of sources) assert.equal((await sourceRow(source.id)).status, 'deleted');
  assert.equal(await conversationStatus(fixture), 'archived');
  assert.deepEqual((await purgeEvents(fixture)).map((event) => event.metadata), [{ count: sources.length }]);

  // With no sources at all there is still exactly one event.
  const empty = await seedProposal('concurrent-empty');
  const results = await Promise.all([purge(empty), purge(empty), purge(empty)]);
  assert.deepEqual(results.map((result) => result.complete), [true, true, true]);
  assert.deepEqual((await purgeEvents(empty)).map((event) => event.metadata), [{ count: 0 }]);
});

test('a scan that finishes while the purge is running changes nothing', async () => {
  const fixture = await seedProposal('scan-mid-purge');
  const source = await seedSource(fixture, 'scanning');
  const scan = { answer: null as { status: string } | null };
  // The scanner comes back clean at the moment the object is being deleted.
  storage.onDelete.set(source.objectKey, async () => {
    scan.answer = await postgresDocumentRepository.finishScan({
      organizationMongoId: fixture.organizationMongoId, sourceId: source.id, scanner: 'test-signature', status: 'clean',
      startedAt: new Date(), actorUserMongoId: randomMongoId(), correlationId: randomMongoId(),
    });
  });
  try {
    const result = await purge(fixture);

    assert.equal(scan.answer?.status, 'deletion_pending', 'finishScan saw a source that is no longer scanning and left it');
    assert.equal(result.complete, true);
    assert.equal((await sourceRow(source.id)).status, 'deleted');
    const scans = await admin.query('SELECT count(*)::int AS n FROM rfpilot.document_scan_results WHERE object_id=$1', [source.objectId]);
    assert.equal(scans.rows[0].n, 0, 'no scan result was recorded for the abandoned scan');
  } finally {
    storage.onDelete.delete(source.objectKey);
  }
});

test('an organization that is not active in Postgres is reported, not passed off as nothing to do', async () => {
  const fixture = await seedProposal('inactive');
  const source = await seedSource(fixture, 'ready');
  await admin.query("UPDATE rfpilot.organizations SET status='suspended' WHERE id=$1", [fixture.organizationId]);

  const result = await purge(fixture);

  assert.equal(result.complete, false);
  assert.equal(result.errorCode, 'ORGANIZATION_INACTIVE');
  assert.equal(result.skipped, undefined);
  assert.equal((await sourceRow(source.id)).status, 'ready');
  assert.equal(deleteRequests(source.objectKey), 0);

  // An organization Postgres has never heard of has nothing there to purge.
  const unknown = await purgeProposalArtifacts([{ proposalMongoId: randomMongoId(), organizationMongoId: randomMongoId() }]);
  assert.equal(unknown[0].complete, true);
  assert.equal(unknown[0].skipped, 'organization_not_in_postgres');
});
