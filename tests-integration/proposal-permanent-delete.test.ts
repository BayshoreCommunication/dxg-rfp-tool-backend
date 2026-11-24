// What a planner and the daily job can and cannot do with a proposal once its permanent delete
// has started, through the real app against MongoDB, with Postgres reached as the application
// role under forced row-level security and storage pointed at the local stand-in.
//
//   - a proposal the archive sweep had to keep cannot be restored or edited back to life;
//   - a restore that races a permanent delete either wins outright or is refused;
//   - a purge whose proposal MongoDB no longer has is finished by the daily job, and that pass
//     leaves alone everything that is not a proposal being deleted.
import { TEST_MONGODB_DB_NAME } from './env';
import { connectMongo, disconnectMongo, randomMongoId } from './setup';
import {
  admin, conversationStatus, deleteRequests, purgeEvents, seedProposal, seedSource, sourceRow,
  startPurgeEnvironment, stopPurgeEnvironment, storage, type Fixture,
} from './purgeFixtures';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import mongoose from 'mongoose';
import app from '../server';
import Organization from '../modal/organizationModel';
import OrganizationMembership from '../modal/organizationMembershipModel';
import Proposal from '../modal/proposalsModel';
import RefreshSession from '../modal/refreshSessionModel';
import User from '../modal/userModel';
import { authenticationSessions } from '../src/modules/auth/composition';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';
import { purgeArchivedProposals } from '../utils/cronJobs';
import { finishStrandedProposalPurges } from '../src/modules/dataFoundation/purgeProposalArtifacts';

let server: http.Server;
let baseUrl: string;
let token = '';
let ownerId: mongoose.Types.ObjectId;
let orgA: mongoose.Types.ObjectId;
let orgExcluded: mongoose.Types.ObjectId;
const orgIds: mongoose.Types.ObjectId[] = [];
const DAY = 24 * 60 * 60 * 1000;

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

const organization = async (label: string) => {
  const id = (await Organization.create({ plan: 'full_access', name: `Purge ${label}`, slug: `intg-purge-${randomMongoId().slice(0, 12)}` }))._id as mongoose.Types.ObjectId;
  orgIds.push(id);
  return id;
};

type Archived = Fixture & { id: string };
/** A proposal in MongoDB (archived `daysAgo` days ago) with its Postgres reference and conversation. */
const archivedProposal = async (label: string, daysAgo: number, organizationId = orgA): Promise<Archived> => {
  const created = await Proposal.create({ organizationId, userId: ownerId, event: { eventName: `Purge ${label}` } });
  await Proposal.collection.updateOne({ _id: created._id }, { $set: { isArchived: true, archivedAt: new Date(Date.now() - daysAgo * DAY) } });
  const existing = (await admin.query<{ id: string }>('SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1', [String(organizationId)])).rows[0];
  const fixture = await seedProposal(
    label,
    existing ? { organizationId: existing.id, organizationMongoId: String(organizationId) } : undefined,
    { organizationMongoId: String(organizationId), proposalMongoId: String(created._id) },
  );
  return { ...fixture, id: String(created._id) };
};
/** A Postgres-only proposal: MongoDB has no document for it (already permanently deleted). */
const goneProposal = async (label: string, organizationId = orgA): Promise<Fixture> => {
  const existing = (await admin.query<{ id: string }>('SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1', [String(organizationId)])).rows[0];
  return seedProposal(label, existing ? { organizationId: existing.id, organizationMongoId: String(organizationId) } : undefined, { organizationMongoId: String(organizationId) });
};
const mongoProposal = (id: string) =>
  Proposal.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }) as Promise<{ isArchived?: boolean; purgeStarted?: boolean; purgeStartedAt?: Date | null } | null>;

before(async () => {
  await startPurgeEnvironment();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  orgA = await organization('A');
  orgExcluded = await organization('Excluded');
  const user = await User.create({ name: 'Owner', email: `purge-owner-${randomMongoId().slice(0, 10)}@example.test`, password: 'not-a-real-hash', role: 'customer', organizationId: orgA });
  ownerId = user._id as mongoose.Types.ObjectId;
  const membership = await OrganizationMembership.create({ organizationId: orgA, userId: ownerId, roles: ['owner'], status: 'active' });
  const session = await authenticationSessions.begin({
    account: { userId: String(ownerId), accountType: 'planner', email: user.email, organizationId: String(orgA), role: 'customer', roles: ['owner'], rolesVersion: membership.version },
    correlationId: randomMongoId(),
  });
  token = session.accessToken;
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    await Promise.all([
      Proposal.collection.deleteMany({ organizationId: { $in: orgIds } }),
      OrganizationMembership.deleteMany({ organizationId: { $in: orgIds } }),
      RefreshSession.deleteMany({ organizationId: { $in: orgIds } }),
      User.deleteMany({ organizationId: { $in: orgIds } }),
      Organization.deleteMany({ _id: { $in: orgIds } }),
    ]);
  }
  await disconnectMongo();
  await stopPurgeEnvironment();
  await closeSecurityRateLimitRedis();
});

test('a proposal the archive sweep had to keep cannot be restored or edited back, and the next sweep finishes it', async () => {
  const proposal = await archivedProposal('sweep-kept', 31);
  const failing = await seedSource(proposal, 'ready');
  const fine = await seedSource(proposal, 'ready');
  storage.denied.add(failing.objectKey);

  await purgeArchivedProposals();

  // Kept, because one object could not be deleted; marked, because the purge had started.
  const kept = await mongoProposal(proposal.id);
  assert.ok(kept, 'the sweep keeps the MongoDB record');
  assert.equal(kept.isArchived, true);
  assert.equal(kept.purgeStarted, true);
  assert.ok(kept.purgeStartedAt instanceof Date);
  assert.equal((await sourceRow(failing.id)).status, 'deletion_pending');
  assert.equal((await sourceRow(fine.id)).status, 'deleted');

  // Its owner still sees it in the archive.
  const list = await call('GET', '/api/proposals?limit=100&archived=true');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.ok((list.body.data as Array<{ _id: string }>).some((row) => String(row._id) === proposal.id), 'still listed in the archive');

  // It cannot come back: its documents are already marked for deletion or gone.
  const restore = await call('PATCH', `/api/proposals/${proposal.id}/restore`);
  assert.equal(restore.status, 409, JSON.stringify(restore.body));
  assert.deepEqual(restore.body, {
    success: false,
    code: 'PROPOSAL_BEING_DELETED',
    message: 'This Proposal is being permanently deleted and can no longer be restored.',
  });
  // Nor through an edit that sets the archived flag itself.
  const edit = await call('PUT', `/api/proposals/${proposal.id}`, { isArchived: false, archivedAt: null, purgeStarted: false });
  assert.equal(edit.status, 404, JSON.stringify(edit.body));
  const still = await mongoProposal(proposal.id);
  assert.equal(still?.isArchived, true);
  assert.equal(still?.purgeStarted, true);

  storage.denied.delete(failing.objectKey);
  await purgeArchivedProposals();

  assert.equal(await mongoProposal(proposal.id), null, 'the next sweep deletes it');
  assert.equal((await sourceRow(failing.id)).status, 'deleted');
  assert.equal(await conversationStatus(proposal), 'archived');
  assert.deepEqual((await purgeEvents(proposal)).map((event) => event.metadata), [{ count: 2 }]);
});

test('a restore that arrives while the permanent delete is running is refused', async () => {
  const proposal = await archivedProposal('restore-mid-delete', 1);
  const source = await seedSource(proposal, 'ready');
  const restore = { answer: null as Awaited<ReturnType<typeof call>> | null };
  // The object is being deleted: the source is already deletion_pending, the proposal still exists.
  storage.onDelete.set(source.objectKey, async () => {
    restore.answer = await call('PATCH', `/api/proposals/${proposal.id}/restore`);
  });
  try {
    const deleted = await call('DELETE', `/api/proposals/${proposal.id}/permanent`);

    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(restore.answer?.status, 409, JSON.stringify(restore.answer?.body));
    assert.equal(restore.answer?.body.code, 'PROPOSAL_BEING_DELETED');
    assert.equal(await mongoProposal(proposal.id), null);
    assert.equal((await sourceRow(source.id)).status, 'deleted');
    assert.equal(deleteRequests(source.objectKey), 1);
  } finally {
    storage.onDelete.delete(source.objectKey);
  }
});

test('a restore racing a permanent delete either wins outright or loses outright', async () => {
  const outcomes = new Set<string>();
  for (let round = 0; round < 8; round += 1) {
    const proposal = await archivedProposal(`race-${round}`, 1);
    const source = await seedSource(proposal, 'ready');

    const [deleted, restored] = await Promise.all([
      call('DELETE', `/api/proposals/${proposal.id}/permanent`),
      call('PATCH', `/api/proposals/${proposal.id}/restore`),
    ]);

    const after = await mongoProposal(proposal.id);
    const row = await sourceRow(source.id);
    if (restored.status === 200) {
      // The restore won: nothing of the proposal was touched.
      outcomes.add('restored');
      assert.equal(deleted.status, 404, `round ${round}: ${JSON.stringify(deleted.body)}`);
      assert.equal(after?.isArchived, false, `round ${round}`);
      assert.notEqual(after?.purgeStarted, true, `round ${round}`);
      assert.equal(row.status, 'ready', `round ${round}`);
      assert.equal(deleteRequests(source.objectKey), 0, `round ${round}`);
      assert.equal(await conversationStatus(proposal), 'active', `round ${round}`);
    } else {
      // The delete won: the proposal and its documents are gone, and the restore was refused
      // (409 while the delete was running, 404 once it had finished).
      outcomes.add('deleted');
      assert.ok([404, 409].includes(restored.status), `round ${round}: restore ${restored.status} ${JSON.stringify(restored.body)}`);
      assert.equal(deleted.status, 200, `round ${round}: ${JSON.stringify(deleted.body)}`);
      assert.equal(after, null, `round ${round}`);
      assert.equal(row.status, 'deleted', `round ${round}`);
    }
  }
  assert.ok(outcomes.size >= 1);
});

test('a planner\'s permanent delete whose storage step failed is finished by the daily job, once', async () => {
  const proposal = await archivedProposal('stranded', 1);
  const source = await seedSource(proposal, 'ready');
  storage.denied.add(source.objectKey);

  const deleted = await call('DELETE', `/api/proposals/${proposal.id}/permanent`);

  // The planner's request succeeds and the proposal is gone; the document is not.
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(await mongoProposal(proposal.id), null);
  assert.equal((await sourceRow(source.id)).status, 'deletion_pending');
  assert.deepEqual(await purgeEvents(proposal), []);

  // Storage still refuses: the pass leaves it pending for the next run.
  const refused = await finishStrandedProposalPurges({ excludedOrganizationMongoIds: new Set([String(orgExcluded)]) });
  assert.ok(refused.incomplete >= 1);
  assert.equal((await sourceRow(source.id)).status, 'deletion_pending');
  assert.deepEqual(await purgeEvents(proposal), []);
  assert.equal(await conversationStatus(proposal), 'active');

  storage.denied.delete(source.objectKey);
  const finished = await finishStrandedProposalPurges({ excludedOrganizationMongoIds: new Set([String(orgExcluded)]) });

  assert.ok(finished.completed >= 1);
  const row = await sourceRow(source.id);
  assert.equal(row.status, 'deleted');
  assert.ok(row.deleted_at instanceof Date);
  assert.equal(await conversationStatus(proposal), 'archived');
  assert.deepEqual((await purgeEvents(proposal)).map((event) => event.metadata), [{ count: 1 }]);
  assert.equal(deleteRequests(source.objectKey), 3, 'the delete itself, the refused pass, the pass that finished');

  // Idempotent: nothing of this proposal is touched again.
  const requests = storage.requests.length;
  await finishStrandedProposalPurges({ excludedOrganizationMongoIds: new Set([String(orgExcluded)]) });
  assert.deepEqual(await sourceRow(source.id), row);
  assert.equal((await purgeEvents(proposal)).length, 1);
  assert.equal(storage.requests.filter((request) => request === `DELETE ${source.objectKey}`).length, 3);
  assert.ok(storage.requests.length >= requests);
});

test('the daily pass finishes only proposals that are being deleted, in organizations it may touch', async () => {
  // Stranded, but under legal hold or retention: left exactly as it is.
  const held = await goneProposal('held');
  const heldSource = await seedSource(held, 'deletion_pending', { legalHold: true });
  const retainedSource = await seedSource(held, 'deletion_pending', { retentionDays: 30 });

  // A proposal that still exists and is NOT being deleted: its pending document came from a
  // single-document delete, which is not this job's to finish.
  const live = await archivedProposal('live', 1);
  await Proposal.collection.updateOne({ _id: new mongoose.Types.ObjectId(live.id) }, { $set: { isArchived: false, archivedAt: null } });
  const livePending = await seedSource(live, 'deletion_pending');
  const liveReady = await seedSource(live, 'ready');

  // A proposal that carries the marker (a sweep kept it): the whole purge is run again.
  const marked = await archivedProposal('marked', 5);
  await Proposal.collection.updateOne({ _id: new mongoose.Types.ObjectId(marked.id) }, { $set: { purgeStarted: true, purgeStartedAt: new Date() } });
  const markedPending = await seedSource(marked, 'deletion_pending');
  const markedReady = await seedSource(marked, 'ready');

  // A proposal MongoDB no longer has: its pending source is finished, nothing new is marked.
  const gone = await goneProposal('gone');
  const gonePending = await seedSource(gone, 'deletion_pending');
  const goneReady = await seedSource(gone, 'ready');

  // Another organization the caller excludes (a blocked one), and one MongoDB does not list.
  const excluded = await goneProposal('excluded', orgExcluded);
  const excludedSource = await seedSource(excluded, 'deletion_pending');
  const unlisted = await seedProposal('unlisted');
  const unlistedSource = await seedSource(unlisted, 'deletion_pending');

  const untouched = async () => ({
    held: await sourceRow(heldSource.id), retained: await sourceRow(retainedSource.id),
    livePending: await sourceRow(livePending.id), liveReady: await sourceRow(liveReady.id),
    goneReady: await sourceRow(goneReady.id),
    excluded: await sourceRow(excludedSource.id), unlisted: await sourceRow(unlistedSource.id),
    conversations: [await conversationStatus(held), await conversationStatus(live), await conversationStatus(gone), await conversationStatus(excluded), await conversationStatus(unlisted)],
    excludedAudit: (await admin.query('SELECT count(*)::int AS n FROM rfpilot.audit_events WHERE organization_id=$1', [excluded.organizationId])).rows[0].n,
    unlistedAudit: (await admin.query('SELECT count(*)::int AS n FROM rfpilot.audit_events WHERE organization_id=$1', [unlisted.organizationId])).rows[0].n,
  });
  const before = await untouched();

  const run = await finishStrandedProposalPurges({ excludedOrganizationMongoIds: new Set([String(orgExcluded)]) });

  assert.deepEqual(await untouched(), before);
  for (const source of [heldSource, retainedSource, livePending, liveReady, goneReady, excludedSource, unlistedSource]) {
    assert.equal(deleteRequests(source.objectKey), 0);
  }
  assert.ok(run.leftAlone >= 1, 'the live proposal was seen and left alone');

  // The marked proposal: both of its documents are gone, and it is closed out. Its MongoDB
  // record is the archive sweep's to delete, not this pass's.
  assert.equal((await sourceRow(markedPending.id)).status, 'deleted');
  assert.equal((await sourceRow(markedReady.id)).status, 'deleted');
  assert.equal(await conversationStatus(marked), 'archived');
  assert.deepEqual((await purgeEvents(marked)).map((event) => event.metadata), [{ count: 2 }]);
  assert.ok(await mongoProposal(marked.id));

  // The gone proposal: only what was already pending.
  assert.equal((await sourceRow(gonePending.id)).status, 'deleted');
  assert.equal(deleteRequests(gonePending.objectKey), 1);
  assert.deepEqual(await purgeEvents(gone), [], 'a live source remains, so it is not closed out');

  // A second pass changes nothing at all for these.
  const afterFirst = {
    ...(await untouched()),
    markedPending: await sourceRow(markedPending.id), markedReady: await sourceRow(markedReady.id), gonePending: await sourceRow(gonePending.id),
    orgAAudit: (await admin.query('SELECT count(*)::int AS n FROM rfpilot.audit_events WHERE organization_id=$1', [gone.organizationId])).rows[0].n,
    requests: storage.requests.length,
  };
  await finishStrandedProposalPurges({ excludedOrganizationMongoIds: new Set([String(orgExcluded)]) });
  assert.deepEqual({
    ...(await untouched()),
    markedPending: await sourceRow(markedPending.id), markedReady: await sourceRow(markedReady.id), gonePending: await sourceRow(gonePending.id),
    orgAAudit: (await admin.query('SELECT count(*)::int AS n FROM rfpilot.audit_events WHERE organization_id=$1', [gone.organizationId])).rows[0].n,
    requests: storage.requests.length,
  }, afterFirst);
});
