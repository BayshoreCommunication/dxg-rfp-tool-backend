// ORG-104: proposal reads and writes go through the access policy end to end, through the real
// app (routes, authenticate middleware, controllers, repositories) against Mongo.
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
import RefreshSession from '../modal/refreshSessionModel';
import VendorResponse from '../modal/vendorResponseModel';
import PublicAccessGrant from '../modal/publicAccessGrantModel';
import User from '../modal/userModel';
import { authenticationSessions } from '../src/modules/auth/composition';
import { closePostgres } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';

let server: http.Server;
let baseUrl: string;
const orgIds: mongoose.Types.ObjectId[] = [];
const tokens: Record<string, string> = {};
const proposals: Record<string, string> = {};
const responses: Record<string, string> = {};
const owners: Record<string, unknown> = {};

const member = async (organizationId: mongoose.Types.ObjectId, key: string, roles: string[]) => {
  const user = await User.create({ name: key, email: `${key}-${randomMongoId().slice(0, 10)}@example.test`, password: 'not-a-real-hash', role: 'customer', organizationId });
  const membership = await OrganizationMembership.create({ organizationId, userId: user._id, roles, status: 'active' });
  const session = await authenticationSessions.begin({
    account: { userId: String(user._id), accountType: 'planner', email: user.email, organizationId: String(organizationId), role: 'customer', roles, rolesVersion: membership.version },
    correlationId: randomMongoId(),
  });
  tokens[key] = session.accessToken;
  return user._id;
};
const proposal = async (key: string, organizationId: mongoose.Types.ObjectId, userId: unknown) => {
  const created = await Proposal.create({ organizationId, userId, event: { eventName: `Scope ${key}` } });
  proposals[key] = String(created._id);
  owners[key] = userId;
  const response = await VendorResponse.create({
    organizationId, proposalId: created._id, proposalOwnerId: userId, proposalTitle: `Scope ${key}`,
    vendorName: `Vendor ${key}`, submittedBy: 'Avery', email: `vendor-${key}@example.test`, message: 'Quote', emailTrackingId: `scope-${key}-${randomMongoId()}`,
  });
  responses[key] = String(response._id);
};
const call = async (who: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};
const listedIds = async (who: string) => ((await call(who, 'GET', '/api/proposals?limit=50')).body.data as Array<{ _id: string }>).map((p) => String(p._id)).sort();

before(async () => {
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  const orgA = (await Organization.create({ plan: 'full_access', name: 'Scope A', slug: `intg-scope-${randomMongoId().slice(0, 10)}` }))._id;
  const orgB = (await Organization.create({ plan: 'full_access', name: 'Scope B', slug: `intg-scope-${randomMongoId().slice(0, 10)}` }))._id;
  orgIds.push(orgA, orgB);
  await member(orgA, 'admin', ['organization_admin']);
  const plannerOne = await member(orgA, 'plannerOne', ['planner']);
  const plannerTwo = await member(orgA, 'plannerTwo', ['planner']);
  await member(orgA, 'viewer', ['viewer']);
  const foreigner = await member(orgB, 'foreigner', ['planner']);
  await proposal('one', orgA, plannerOne);
  await proposal('two', orgA, plannerTwo);
  await proposal('foreign', orgB, foreigner);
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    await Promise.all([
      Proposal.deleteMany({ organizationId: { $in: orgIds } }),
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

test('a planner lists and opens only their own proposals', async () => {
  assert.deepEqual(await listedIds('plannerOne'), [proposals.one]);
  assert.equal((await call('plannerOne', 'GET', `/api/proposals/${proposals.one}`)).status, 200);
});

test('another planner\'s proposal in the same organization is forbidden, not hidden', async () => {
  const res = await call('plannerOne', 'GET', `/api/proposals/${proposals.two}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'PROPOSAL_ACCESS_DENIED');
  assert.equal((await call('plannerOne', 'PATCH', `/api/proposals/${proposals.two}/meta`, { isFavorite: true })).status, 403);
  assert.equal((await call('plannerOne', 'DELETE', `/api/proposals/${proposals.two}`)).status, 403);
});

test('another organization\'s proposal looks like it does not exist', async () => {
  for (const who of ['plannerOne', 'admin']) {
    assert.equal((await call(who, 'GET', `/api/proposals/${proposals.foreign}`)).status, 404, who);
    assert.equal((await call(who, 'PATCH', `/api/proposals/${proposals.foreign}/meta`, { isFavorite: true })).status, 404, who);
  }
});

test('an organization admin sees and manages every proposal in the organization', async () => {
  assert.deepEqual(await listedIds('admin'), [proposals.one, proposals.two].sort());
  assert.equal((await call('admin', 'GET', `/api/proposals/${proposals.two}`)).status, 200);
  assert.equal((await call('admin', 'PATCH', `/api/proposals/${proposals.two}/meta`, { isFavorite: true })).status, 200);
});

test('a viewer without shares sees nothing and cannot open proposals', async () => {
  assert.deepEqual(await listedIds('viewer'), []);
  assert.equal((await call('viewer', 'GET', `/api/proposals/${proposals.one}`)).status, 403);
});

test('dashboard totals use the same scope as the list', async () => {
  const totals = async (who: string) => (await call(who, 'GET', '/api/dashboard/overview')).body.data?.totals?.totalProposals;
  assert.equal(await totals('admin'), 2);
  assert.equal(await totals('plannerOne'), 1);
  assert.equal(await totals('viewer'), 0);
});

test('list counts match the scoped list', async () => {
  for (const [who, expected] of [['admin', 2], ['plannerOne', 1], ['viewer', 0]] as const) {
    const res = await call(who, 'GET', '/api/proposals?limit=50&includeCounts=true');
    assert.equal(res.status, 200, who);
    assert.equal(res.body.counts?.all, expected, who);
    assert.equal(res.body.counts?.all, res.body.data.length, who);
  }
});

test('vendor responses inherit the proposal decision', async () => {
  const listed = async (who: string) => ((await call(who, 'GET', '/api/vendor-responses?limit=50')).body.data as Array<{ _id: string }>).map((r) => String(r._id)).sort();
  assert.deepEqual(await listed('plannerOne'), [responses.one]);
  assert.deepEqual(await listed('admin'), [responses.one, responses.two].sort());
  assert.deepEqual(await listed('viewer'), []);

  assert.equal((await call('plannerOne', 'GET', `/api/vendor-responses/${responses.one}`)).status, 200);
  const refused = await call('plannerOne', 'GET', `/api/vendor-responses/${responses.two}`);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'PROPOSAL_ACCESS_DENIED');
  assert.equal((await call('plannerOne', 'GET', `/api/vendor-responses/${responses.foreign}`)).status, 404);
  assert.equal((await call('admin', 'GET', `/api/vendor-responses/${responses.two}`)).status, 200);
  assert.equal((await call('admin', 'GET', `/api/vendor-responses/${responses.foreign}`)).status, 404);
  assert.equal((await call('plannerOne', 'DELETE', `/api/vendor-responses/${responses.two}`)).status, 403);
  assert.equal(await VendorResponse.countDocuments({ _id: responses.two }), 1, 'a refused delete removes nothing');
});

test('issuing a public link follows the policy and always answers', async () => {
  const issue = (who: string, key: string) => call(who, 'POST', '/api/public-access', { resourceId: proposals[key], purpose: 'proposal:view' });
  assert.equal((await issue('plannerOne', 'two')).status, 403);
  assert.equal((await issue('plannerOne', 'foreign')).status, 404);
  assert.equal((await issue('admin', 'two')).status, 201);
  assert.equal((await issue('plannerOne', 'one')).status, 201);
});

test('the owner can archive their own proposal', async () => {
  assert.equal((await call('plannerOne', 'DELETE', `/api/proposals/${proposals.one}`)).status, 200);
});
