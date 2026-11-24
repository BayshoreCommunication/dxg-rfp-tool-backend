// Trust boundary (DECISIONS 2026-11-24): a server-owned proposal field is never taken from a
// client payload. Through the real app (routes, authenticate middleware, controller, use cases,
// Mongo repository) as a Planner in organization A: an edit or a create can't move a proposal to
// another organization or owner, can't set or clear its archive state, and can't forge lifecycle,
// counters or deletion markers, while an ordinary content edit still works.
import { TEST_MONGODB_DB_NAME } from './env';
import { connectMongo, disconnectMongo, ensureMigrated, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import mongoose from 'mongoose';
import app from '../server';
import Organization from '../modal/organizationModel';
import OrganizationMembership from '../modal/organizationMembershipModel';
import Proposal from '../modal/proposalsModel';
import ProposalStatusTransition from '../modal/proposalStatusTransitionModel';
import RefreshSession from '../modal/refreshSessionModel';
import SecurityAuditEvent from '../modal/securityAuditEventModel';
import User from '../modal/userModel';
import { authenticationSessions } from '../src/modules/auth/composition';
import { closePostgres } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';
import { closeQueue } from '../src/modules/durableJobs/queue';

let server: http.Server;
let baseUrl: string;
let orgA: mongoose.Types.ObjectId;
let orgB: mongoose.Types.ObjectId;
const orgIds: mongoose.Types.ObjectId[] = [];
const tokens: Record<string, string> = {};
const userIds: Record<string, string> = {};
const MARKER = `SOF${randomMongoId().slice(0, 10).toUpperCase()}`;
const BACK_DATED = '2020-01-01T00:00:00.000Z';
let proposalId: string;

const member = async (organizationId: mongoose.Types.ObjectId, key: string, roles: string[]) => {
  const user = await User.create({ name: key, email: `${key}-${randomMongoId().slice(0, 10)}@example.com`, password: 'not-a-real-hash', role: 'customer', organizationId });
  const membership = await OrganizationMembership.create({ organizationId, userId: user._id, roles, status: 'active' });
  const session = await authenticationSessions.begin({
    account: { userId: String(user._id), accountType: 'planner', email: user.email, organizationId: String(organizationId), role: 'customer', roles, rolesVersion: membership.version },
    correlationId: randomMongoId(),
  });
  tokens[key] = session.accessToken;
  userIds[key] = String(user._id);
};
const call = async (who: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
};
// The stored document exactly as MongoDB holds it: no schema defaults, no select:false.
const stored = async (id: string) => {
  const row = await Proposal.collection.findOne({ _id: new mongoose.Types.ObjectId(id), organizationId: { $in: orgIds } });
  assert.ok(row, `proposal ${id} is no longer in either test organization`);
  return row as Record<string, any>;
};
const listedIds = async (who: string) => ((await call(who, 'GET', '/api/proposals?limit=50')).body.data as Array<{ _id: string }>).map((p) => String(p._id));
const create = async (who: string, body: Record<string, unknown>) => {
  const res = await call(who, 'POST', '/api/proposals', body);
  assert.equal(res.status, 201, res.text);
  return String(res.body.data._id);
};

before(async () => {
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  // full_access: these tests create more than two RFPs in one organization.
  orgA = (await Organization.create({ name: 'Server fields A', slug: `intg-sof-${randomMongoId().slice(0, 10)}`, plan: 'full_access' }))._id as mongoose.Types.ObjectId;
  orgB = (await Organization.create({ name: 'Server fields B', slug: `intg-sof-${randomMongoId().slice(0, 10)}`, plan: 'full_access' }))._id as mongoose.Types.ObjectId;
  orgIds.push(orgA, orgB);
  await member(orgA, 'planner', ['planner']);
  await member(orgB, 'foreignOwner', ['owner']);
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  proposalId = await create('planner', { event: { eventName: `${MARKER} Summit` }, venueSchedule: { venueName: 'Grand Hall' } });
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    await Promise.all([
      Proposal.deleteMany({ organizationId: { $in: orgIds } }),
      ProposalStatusTransition.collection.deleteMany({ organizationId: { $in: orgIds } }),
      OrganizationMembership.deleteMany({ organizationId: { $in: orgIds } }),
      RefreshSession.deleteMany({ organizationId: { $in: orgIds } }),
      User.deleteMany({ organizationId: { $in: orgIds } }),
      Organization.deleteMany({ _id: { $in: orgIds } }),
    ]);
  }
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
  await closeQueue();
});

test('an ordinary content edit still works, with whole sections, a dotted path and a flag', async () => {
  const res = await call('planner', 'PUT', `/api/proposals/${proposalId}`, {
    event: { eventName: `${MARKER} Summit edited`, attendees: '800' },
    venueSchedule: { venueName: 'Harbour Centre' },
    roomByRoom: [{ roomFunction: 'General session' }],
    proposalSettings: { defaultFont: 'Inter' },
    'contact.contactTitle': 'Producer',
    isFavorite: true,
    status: 'unsubmitted',
    isDraft: true,
  });
  assert.equal(res.status, 200, res.text);
  const row = await stored(proposalId);
  assert.deepEqual(
    [row.event.eventName, row.event.attendees, row.venueSchedule.venueName, row.roomByRoom[0].roomFunction, row.proposalSettings.defaultFont, row.contact.contactTitle, row.isFavorite, row.status, row.isDraft],
    [`${MARKER} Summit edited`, '800', 'Harbour Centre', 'General session', 'Inter', 'Producer', true, 'unsubmitted', true],
  );
  assert.equal(String(row.organizationId), String(orgA));
  assert.equal(String(row.userId), userIds.planner);
});

test('an edit naming another organization is refused, recorded, and moves nothing', async () => {
  const original = await stored(proposalId);
  const res = await call('planner', 'PUT', `/api/proposals/${proposalId}`, {
    organizationId: String(orgB),
    event: { eventName: `${MARKER} moved` },
  });
  assert.equal(res.status, 400, res.text);
  assert.equal(res.body.code, 'PROPOSAL_TENANCY_FIELD_NOT_WRITABLE');
  const row = await stored(proposalId);
  assert.equal(String(row.organizationId), String(orgA));
  assert.equal(row.event.eventName, original.event.eventName, 'a refused request writes nothing');
  assert.equal((await listedIds('foreignOwner')).includes(proposalId), false, "organization B's list must not show it");
  assert.equal((await call('foreignOwner', 'GET', `/api/proposals/${proposalId}`)).status, 404);
  assert.equal((await listedIds('planner')).includes(proposalId), true);
  // The event names the proposal as the id the request claimed (no lookup happened), never as its target.
  const events = await SecurityAuditEvent.find({ organizationId: orgA, action: 'proposal.tenancy_field_write.refused', 'metadata.claimedProposalId': proposalId }).lean();
  assert.equal(events.length, 1);
  assert.deepEqual(
    [events[0].decision, String(events[0].actorUserId), events[0].targetId ?? null, events[0].metadata.field, events[0].metadata.attemptedOrganizationId],
    ['denied', userIds.planner, null, 'organizationId', String(orgB)],
  );

  // A value that is not a 24-hex id is refused too, and recorded as a fixed marker, not as sent.
  const malformed = await call('planner', 'PUT', `/api/proposals/${proposalId}`, { organizationId: 'twelve chars', event: { eventName: `${MARKER} moved` } });
  assert.equal(malformed.status, 400, malformed.text);
  const recorded = await SecurityAuditEvent.find({ organizationId: orgA, action: 'proposal.tenancy_field_write.refused', 'metadata.claimedProposalId': proposalId }).sort({ createdAt: 1, _id: 1 }).lean();
  assert.deepEqual(recorded.map((event) => event.metadata.attemptedOrganizationId), [String(orgB), 'malformed']);
});

test("the caller's own organization echoed back is ignored, and the owner can't be changed", async () => {
  const res = await call('planner', 'PUT', `/api/proposals/${proposalId}`, {
    _id: proposalId,
    organizationId: String(orgA),
    userId: userIds.foreignOwner,
    'userId.x': userIds.foreignOwner,
    'organizationId.x': String(orgB),
    event: { eventName: `${MARKER} echoed` },
  });
  assert.equal(res.status, 200, res.text);
  const row = await stored(proposalId);
  assert.deepEqual([String(row.organizationId), String(row.userId), row.event.eventName], [String(orgA), userIds.planner, `${MARKER} echoed`]);
  assert.equal((await listedIds('foreignOwner')).includes(proposalId), false);
});

test("an edit can't archive a proposal or back-date its archive time", async () => {
  const res = await call('planner', 'PUT', `/api/proposals/${proposalId}`, {
    isArchived: true,
    archivedAt: BACK_DATED,
    'isArchived.x': true,
    event: { eventName: `${MARKER} still live` },
  });
  assert.equal(res.status, 200, res.text);
  const row = await stored(proposalId);
  assert.equal(row.isArchived, false);
  assert.equal(row.archivedAt ?? null, null);
  assert.equal(row.event.eventName, `${MARKER} still live`);
  // What the daily purge selects on.
  assert.equal(await Proposal.countDocuments({ _id: proposalId, organizationId: orgA, isArchived: true }), 0);
});

test("an edit can't forge lifecycle, counters, copy state, version, timestamps or deletion markers, as keys, dotted paths or operators", async () => {
  const original = await stored(proposalId);
  const res = await call('planner', 'PUT', `/api/proposals/${proposalId}`, {
    lifecycle: { stage: 'awarded', awardedAt: BACK_DATED, vendorsResponded: 9, vendorsInvited: 9, revision: 500 },
    'lifecycle.stage': 'awarded',
    'lifecycle.awardedAt': BACK_DATED,
    'lifecycle.reviewStartedAt': BACK_DATED,
    'lifecycle.vendorsResponded': 9,
    'lifecycle.vendorsInvited': 9,
    viewsCount: 999,
    version: 42,
    isCopy: true,
    candidateApplicationIds: ['forged'],
    createdAt: BACK_DATED,
    purgeStarted: true,
    purgeStartedAt: BACK_DATED,
    deletedAt: BACK_DATED,
    $set: { isArchived: true, organizationId: String(orgB) },
    $unset: { event: '' },
    $inc: { viewsCount: 50 },
    venue: { riggingRequired: 'YES', $set: { isArchived: true } },
    event: { eventName: `${MARKER} unforged` },
  });
  assert.equal(res.status, 200, res.text);
  const row = await stored(proposalId);
  assert.deepEqual(
    [row.viewsCount, row.version, row.isCopy, row.candidateApplicationIds ?? [], row.isArchived, String(row.organizationId)],
    [0, 1, false, [], false, String(orgA)],
  );
  assert.equal(new Date(row.createdAt).getTime(), new Date(original.createdAt).getTime());
  for (const marker of ['purgeStarted', 'purgeStartedAt', 'deletedAt', '$set', '$unset', '$inc']) assert.equal(marker in row, false, marker);
  assert.deepEqual(row.venue, { riggingRequired: 'YES' });
  assert.equal(row.event.eventName, `${MARKER} unforged`);
  const lifecycle = row.lifecycle ?? {};
  assert.notEqual(lifecycle.stage, 'awarded');
  assert.deepEqual(
    [lifecycle.awardedAt ?? null, lifecycle.reviewStartedAt ?? null, lifecycle.vendorsResponded ?? 0, lifecycle.vendorsInvited ?? 0],
    [null, null, 0, 0],
  );
  assert.ok((lifecycle.revision ?? 0) < 500);
  assert.equal(await ProposalStatusTransition.countDocuments({ organizationId: orgA, proposalId, toStage: 'awarded' }), 0);
});

test('an archived proposal is not un-archived or re-dated through an edit; restore still works', async () => {
  assert.equal((await call('planner', 'DELETE', `/api/proposals/${proposalId}`)).status, 200);
  const archived = await stored(proposalId);
  assert.equal(archived.isArchived, true);
  const archivedAt = new Date(archived.archivedAt).getTime();
  assert.ok(Date.now() - archivedAt < 5 * 60_000);

  for (const body of [
    { isArchived: false, archivedAt: null, event: { eventName: `${MARKER} unarchive attempt` } },
    { archivedAt: BACK_DATED, 'archivedAt.x': BACK_DATED, $unset: { archivedAt: '' }, $set: { isArchived: false }, event: { eventName: `${MARKER} re-date attempt` } },
  ]) {
    const res = await call('planner', 'PUT', `/api/proposals/${proposalId}`, body);
    assert.ok(res.status < 500, res.text);
    const row = await stored(proposalId);
    assert.equal(row.isArchived, true);
    assert.equal(new Date(row.archivedAt).getTime(), archivedAt);
  }

  assert.equal((await call('planner', 'PATCH', `/api/proposals/${proposalId}/restore`)).status, 200);
  const restored = await stored(proposalId);
  assert.equal(restored.isArchived, false);
  assert.equal(restored.archivedAt ?? null, null);
});

test('content nested beyond the limit is refused with 400, not a 500, and writes nothing', async () => {
  const original = await stored(proposalId);
  let deep: unknown = 'leaf';
  for (let level = 0; level < 500; level += 1) deep = { a: deep };
  const res = await call('planner', 'PUT', `/api/proposals/${proposalId}`, { venue: deep, event: { eventName: `${MARKER} deep` } });
  assert.equal(res.status, 400, res.text);
  assert.equal(res.body.code, 'PROPOSAL_PAYLOAD_TOO_DEEP');
  assert.equal((await stored(proposalId)).event.eventName, original.event.eventName);
});

test("a create takes no server-owned field from the payload, and can't name another organization", async () => {
  const id = await create('planner', {
    userId: userIds.foreignOwner,
    isArchived: true,
    archivedAt: BACK_DATED,
    viewsCount: 999,
    version: 42,
    isCopy: true,
    createdAt: BACK_DATED,
    purgeStarted: true,
    lifecycle: { stage: 'awarded', awardedAt: BACK_DATED },
    'lifecycle.awardedAt': BACK_DATED,
    'lifecycle.vendorsResponded': 9,
    event: { eventName: `${MARKER} created` },
  });
  const row = await stored(id);
  assert.deepEqual(
    [String(row.organizationId), String(row.userId), row.isArchived, row.archivedAt ?? null, row.viewsCount, row.version, row.isCopy, 'purgeStarted' in row],
    [String(orgA), userIds.planner, false, null, 0, 1, false, false],
  );
  assert.ok(Date.now() - new Date(row.createdAt).getTime() < 5 * 60_000);
  assert.notEqual(row.lifecycle?.stage, 'awarded');
  assert.deepEqual([row.lifecycle?.awardedAt ?? null, row.lifecycle?.vendorsResponded ?? 0], [null, 0]);

  const refused = await call('planner', 'POST', '/api/proposals', { organizationId: String(orgB), event: { eventName: `${MARKER} planted` } });
  assert.equal(refused.status, 400, refused.text);
  assert.equal(refused.body.code, 'PROPOSAL_TENANCY_FIELD_NOT_WRITABLE');
  assert.equal(await Proposal.countDocuments({ organizationId: { $in: orgIds }, 'event.eventName': `${MARKER} planted` }), 0);
  assert.equal((await listedIds('foreignOwner')).length, 0);
});
