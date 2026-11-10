// ORG-403: the RFP lifecycle stage and its append-only history, end to end through the real app
// (routes, authenticate middleware, controllers, use cases, repositories) against Mongo.
import { TEST_MONGODB_DB_NAME } from './env';
import { connectMongo, disconnectMongo, randomMongoId } from './setup';
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
import PublicAccessGrant from '../modal/publicAccessGrantModel';
import RefreshSession from '../modal/refreshSessionModel';
import User from '../modal/userModel';
import VendorResponse from '../modal/vendorResponseModel';
import { authenticationSessions } from '../src/modules/auth/composition';
import { proposalLifecycle } from '../src/modules/proposalLifecycle/composition';
import { closePostgres } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';

let server: http.Server;
let baseUrl: string;
const orgIds: mongoose.Types.ObjectId[] = [];
const tokens: Record<string, string> = {};
const userIds: Record<string, string> = {};

const member = async (organizationId: mongoose.Types.ObjectId, key: string, roles: string[]) => {
  const user = await User.create({ name: key, email: `${key}-${randomMongoId().slice(0, 10)}@example.test`, password: 'not-a-real-hash', role: 'customer', organizationId });
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
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};

const stored = async (proposalId: string) =>
  (await Proposal.findById(proposalId).select('lifecycle').lean<{ lifecycle?: Record<string, any> }>())?.lifecycle ?? {};

const history = async (proposalId: string) =>
  ProposalStatusTransition.find({ proposalId }).sort({ at: 1, _id: 1 }).lean();

const createDraft = async (who = 'planner') => {
  const created = await call(who, 'POST', '/api/proposals', { event: { eventName: `Lifecycle ${randomMongoId().slice(0, 6)}` } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return String(created.body.data._id);
};

before(async () => {
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  const orgA = (await Organization.create({ plan: 'full_access', name: 'Lifecycle A', slug: `intg-lifecycle-${randomMongoId().slice(0, 10)}` }))._id;
  const orgB = (await Organization.create({ plan: 'full_access', name: 'Lifecycle B', slug: `intg-lifecycle-${randomMongoId().slice(0, 10)}` }))._id;
  orgIds.push(orgA, orgB);
  await member(orgA, 'planner', ['planner']);
  await member(orgA, 'otherPlanner', ['planner']);
  await member(orgA, 'viewer', ['viewer']);
  await member(orgB, 'foreigner', ['organization_admin']);
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    await Promise.all([
      Proposal.deleteMany({ organizationId: { $in: orgIds } }),
      ProposalStatusTransition.collection.deleteMany({ organizationId: { $in: orgIds } }),
      VendorResponse.deleteMany({ organizationId: { $in: orgIds } }),
      PublicAccessGrant.deleteMany({ organizationId: { $in: orgIds } }),
      OrganizationMembership.deleteMany({ organizationId: { $in: orgIds } }),
      RefreshSession.deleteMany({ organizationId: { $in: orgIds } }),
      User.deleteMany({ organizationId: { $in: orgIds } }),
      Organization.deleteMany({ _id: { $in: orgIds } }),
    ]);
  }
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
});

test('an RFP moves draft -> sent -> receiving responses -> awarded -> archived, recording each step', async () => {
  const id = await createDraft();
  assert.equal((await stored(id)).stage, 'draft');

  assert.equal((await call('planner', 'PATCH', `/api/proposals/${id}/status`, { status: 'submitted' })).status, 200);
  assert.equal((await stored(id)).stage, 'sent');

  const grant = await call('planner', 'POST', '/api/public-access', { resourceId: id, purpose: 'vendor:submit', recipient: 'vendor@example.test' });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));
  // A second link to the same vendor is the same invitee.
  await call('planner', 'POST', '/api/public-access', { resourceId: id, purpose: 'vendor:submit', recipient: 'VENDOR@example.test' });
  assert.equal((await stored(id)).vendorsInvited, 1);
  assert.equal((await stored(id)).stage, 'sent');

  // The response row a submission writes, then the hook every submission path goes through.
  const organizationId = String(orgIds[0]);
  await VendorResponse.create({
    organizationId, proposalId: id, proposalOwnerId: userIds.planner, proposalTitle: 'Lifecycle',
    vendorName: 'Acme AV', submittedBy: 'Avery', email: 'vendor@example.test', message: 'Quote', emailTrackingId: `lifecycle-${randomMongoId()}`,
  });
  await proposalLifecycle.record({ organizationId, proposalId: id, actor: { type: 'vendor' }, reason: 'vendor_responded', recount: ['responded'] });
  assert.equal((await stored(id)).stage, 'receiving_responses');
  assert.equal((await stored(id)).vendorsResponded, 1);

  const awarded = await call('planner', 'POST', `/api/proposals/${id}/award`);
  assert.equal(awarded.status, 200, JSON.stringify(awarded.body));
  assert.equal(awarded.body.data.stage, 'awarded');
  assert.equal(awarded.body.data.awardSource, 'manual');
  assert.equal(awarded.body.data.awardedByUserId, userIds.planner);

  assert.equal((await call('planner', 'DELETE', `/api/proposals/${id}`)).status, 200);
  assert.equal((await stored(id)).stage, 'archived');

  const read = await call('planner', 'GET', `/api/proposals/${id}/status-history`);
  assert.equal(read.status, 200);
  assert.equal(read.body.data.stage, 'archived');
  assert.deepEqual(
    read.body.data.transitions.map((row: any) => [row.fromStage, row.toStage, row.reason, row.actorType]),
    [
      [null, 'draft', 'created', 'user'],
      ['draft', 'sent', 'status_changed', 'user'],
      ['sent', 'receiving_responses', 'vendor_responded', 'vendor'],
      ['receiving_responses', 'awarded', 'awarded', 'user'],
      ['awarded', 'archived', 'archived', 'user'],
    ],
  );
  assert.ok(read.body.data.transitions.every((row: any) => row.actorType !== 'user' || row.actorUserId === userIds.planner));
});

test('restoring brings back the derived stage; clearing an award withdraws it', async () => {
  const id = await createDraft();
  await call('planner', 'PATCH', `/api/proposals/${id}/status`, { status: 'submitted' });
  await call('planner', 'POST', `/api/proposals/${id}/award`);
  await call('planner', 'DELETE', `/api/proposals/${id}`);
  assert.equal((await call('planner', 'PATCH', `/api/proposals/${id}/restore`)).status, 200);
  assert.equal((await stored(id)).stage, 'awarded');

  const cleared = await call('planner', 'DELETE', `/api/proposals/${id}/award`);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.stage, 'sent');
  assert.equal((await stored(id)).awardedAt, null);
  assert.deepEqual((await history(id)).map((row) => row.reason), ['created', 'status_changed', 'awarded', 'archived', 'restored', 'award_cleared']);
});

test('a draft cannot be awarded', async () => {
  const id = await createDraft();
  const refused = await call('planner', 'POST', `/api/proposals/${id}/award`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'PROPOSAL_NOT_AWARDABLE');
  assert.equal((await stored(id)).stage, 'draft');
});

test('the expiry status change is recorded even though the stage stays put', async () => {
  const id = await createDraft();
  await call('planner', 'PATCH', `/api/proposals/${id}/status`, { status: 'submitted' });
  await Proposal.updateOne({ _id: id }, { $set: { status: 'rejected' } });
  await proposalLifecycle.record({ organizationId: String(orgIds[0]), proposalId: id, actor: { type: 'system' }, reason: 'expired' });
  const last = (await history(id)).at(-1)!;
  assert.deepEqual([last.fromStage, last.toStage, last.fromStatus, last.toStatus, last.actorType, last.reason], ['sent', 'sent', 'submitted', 'rejected', 'system', 'expired']);
});

test('a client cannot write its own stage or award', async () => {
  const id = await createDraft();
  const forged = { lifecycle: { stage: 'awarded', awardedAt: new Date().toISOString(), awardSource: 'manual' } };
  assert.equal((await call('planner', 'PUT', `/api/proposals/${id}`, forged)).status, 200);
  const lifecycle = await stored(id);
  assert.equal(lifecycle.stage, 'draft');
  assert.equal(lifecycle.awardedAt ?? null, null);
});

test('awarding and history follow the access policy', async () => {
  const id = await createDraft();
  await call('planner', 'PATCH', `/api/proposals/${id}/status`, { status: 'submitted' });
  // A viewer lacks proposal:publish; another planner can't edit this planner's RFP; another
  // organization can't see it at all.
  assert.equal((await call('viewer', 'POST', `/api/proposals/${id}/award`)).status, 403);
  assert.equal((await call('otherPlanner', 'POST', `/api/proposals/${id}/award`)).status, 403);
  assert.equal((await call('foreigner', 'POST', `/api/proposals/${id}/award`)).status, 404);
  assert.equal((await call('foreigner', 'GET', `/api/proposals/${id}/status-history`)).status, 404);
  assert.equal((await stored(id)).stage, 'sent');
  assert.equal((await call('planner', 'GET', `/api/proposals/${id}/status-history`)).status, 200);
});

test('transitions are append-only', async () => {
  const id = await createDraft();
  await assert.rejects(ProposalStatusTransition.updateOne({ proposalId: id }, { $set: { toStage: 'awarded' } }), /append-only/);
  const row = await ProposalStatusTransition.findOne({ proposalId: id });
  row!.toStage = 'awarded';
  await assert.rejects(row!.save(), /append-only/);
});

test('deleting the only vendor response returns the RFP to sent', async () => {
  const id = await createDraft();
  await call('planner', 'PATCH', `/api/proposals/${id}/status`, { status: 'submitted' });
  const organizationId = String(orgIds[0]);
  const response = await VendorResponse.create({
    organizationId, proposalId: id, proposalOwnerId: userIds.planner, proposalTitle: 'Lifecycle',
    vendorName: 'Beta AV', submittedBy: 'Sam', email: 'beta@example.test', message: 'Quote', emailTrackingId: `lifecycle-${randomMongoId()}`,
  });
  await proposalLifecycle.record({ organizationId, proposalId: id, actor: { type: 'vendor' }, reason: 'vendor_responded', recount: ['responded'] });
  assert.equal((await stored(id)).stage, 'receiving_responses');

  const deleted = await call('planner', 'DELETE', `/api/vendor-responses/${response._id}`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal((await stored(id)).stage, 'sent');
  const last = (await history(id)).at(-1)!;
  assert.deepEqual([last.reason, last.actorType, String(last.actorUserId)], ['vendor_response_deleted', 'user', userIds.planner]);
});
