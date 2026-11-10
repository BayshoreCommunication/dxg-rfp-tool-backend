// ORG-606: the organization vendor list through the real app (routes, authenticate middleware,
// controller, Mongo repository): role policy, search, audit, cross-tenant isolation, and the
// rule that a vendor's submission link never reaches the list.
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
import OrganizationVendor from '../modal/organizationVendorModel';
import Proposal from '../modal/proposalsModel';
import ProposalStatusTransition from '../modal/proposalStatusTransitionModel';
import PublicAccessGrant from '../modal/publicAccessGrantModel';
import RefreshSession from '../modal/refreshSessionModel';
import SecurityAuditEvent from '../modal/securityAuditEventModel';
import User from '../modal/userModel';
import { authenticationSessions } from '../src/modules/auth/composition';
import { closePostgres } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';

let server: http.Server;
let baseUrl: string;
let orgA: mongoose.Types.ObjectId;
let orgB: mongoose.Types.ObjectId;
const orgIds: mongoose.Types.ObjectId[] = [];
const tokens: Record<string, string> = {};
const MARKER = `VLIST${randomMongoId().slice(0, 10).toUpperCase()}`;

const member = async (organizationId: mongoose.Types.ObjectId, key: string, roles: string[]) => {
  const user = await User.create({ name: key, email: `${key}-${randomMongoId().slice(0, 10)}@example.com`, password: 'not-a-real-hash', role: 'customer', organizationId });
  const membership = await OrganizationMembership.create({ organizationId, userId: user._id, roles, status: 'active' });
  const session = await authenticationSessions.begin({
    account: { userId: String(user._id), accountType: 'planner', email: user.email, organizationId: String(organizationId), role: 'customer', roles, rolesVersion: membership.version },
    correlationId: randomMongoId(),
  });
  tokens[key] = session.accessToken;
};
const send = async (headers: Record<string, string>, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
};
const call = (who: string, method: string, path: string, body?: unknown) => send({ authorization: `Bearer ${tokens[who]}` }, method, path, body);
const companies = async (who: string, query = '') =>
  ((await call(who, 'GET', `/api/v1/vendor-list${query}`)).body.data.items as Array<{ company: string }>).map((v) => v.company);
const stored = (vendorId: string) => OrganizationVendor.findOne({ _id: vendorId, organizationId: { $in: orgIds } }).lean();

const EDITORS = ['owner', 'admin', 'manager'];

before(async () => {
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  await OrganizationVendor.init();
  orgA = (await Organization.create({ name: 'Vendors A', slug: `intg-vendors-${randomMongoId().slice(0, 10)}` }))._id as mongoose.Types.ObjectId;
  orgB = (await Organization.create({ name: 'Vendors B', slug: `intg-vendors-${randomMongoId().slice(0, 10)}` }))._id as mongoose.Types.ObjectId;
  orgIds.push(orgA, orgB);
  await member(orgA, 'owner', ['owner']);
  await member(orgA, 'admin', ['organization_admin']);
  await member(orgA, 'manager', ['team_manager']);
  await member(orgA, 'planner', ['planner']);
  await member(orgA, 'viewer', ['viewer']);
  await member(orgB, 'foreignOwner', ['owner']);
  await member(orgB, 'foreignPlanner', ['planner']);
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    await Promise.all([
      OrganizationVendor.deleteMany({ organizationId: { $in: orgIds } }),
      Proposal.deleteMany({ organizationId: { $in: orgIds } }),
      ProposalStatusTransition.collection.deleteMany({ organizationId: { $in: orgIds } }),
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

test('Owner, Admin and Team Manager add, edit, archive and restore vendors, and every edit is audited', async () => {
  for (const who of EDITORS) {
    const created = await call(who, 'POST', '/api/v1/vendor-list', {
      company: `Editor ${who} AV`, category: 'Audio', contacts: [{ name: 'Dana Reyes', email: `Dana.${who}@Vendor.example` }],
    });
    assert.equal(created.status, 201, `${who}: ${created.text}`);
    const vendorId = created.body.data.id as string;
    assert.deepEqual(created.body.data.contacts, [{ name: 'Dana Reyes', email: `dana.${who}@vendor.example` }]);
    assert.equal(String((await stored(vendorId))!.organizationId), String(orgA));

    const edited = await call(who, 'PATCH', `/api/v1/vendor-list/${vendorId}`, { category: 'Audio and video', contacts: [] });
    assert.deepEqual([edited.status, edited.body.data.category, edited.body.data.contacts], [200, 'Audio and video', []]);
    assert.equal((await call(who, 'POST', `/api/v1/vendor-list/${vendorId}/archive`)).body.data.archived, true);
    assert.equal((await call(who, 'PATCH', `/api/v1/vendor-list/${vendorId}`, { category: 'Video' })).status, 409);
    assert.equal((await call(who, 'POST', `/api/v1/vendor-list/${vendorId}/restore`)).body.data.archived, false);

    const events = await SecurityAuditEvent.find({ organizationId: orgA, targetType: 'organization_vendor', targetId: vendorId }).sort({ createdAt: 1, _id: 1 }).lean();
    assert.deepEqual(events.map((e) => e.action), ['organization_vendor.created', 'organization_vendor.updated', 'organization_vendor.archived', 'organization_vendor.restored'], who);
    assert.doesNotMatch(JSON.stringify(events.map((e) => e.metadata)), /vendor\.example|Dana/);
  }
  // Active company names are unique per organization, ignoring case (enforced by the index).
  const duplicate = await call('owner', 'POST', '/api/v1/vendor-list', { company: 'EDITOR OWNER AV' });
  assert.deepEqual([duplicate.status, duplicate.body.code], [409, 'VENDOR_COMPANY_TAKEN']);
});

test('Planners read and search the list but cannot change it; Viewers cannot see it', async () => {
  const lights = (await call('owner', 'POST', '/api/v1/vendor-list', { company: 'Bright Lights', category: 'Lighting', contacts: [{ name: 'Lee', email: 'lee@bright.example' }] })).body.data.id as string;
  const retired = (await call('owner', 'POST', '/api/v1/vendor-list', { company: 'Retired Rigging', category: 'Rigging' })).body.data.id as string;
  await call('owner', 'POST', `/api/v1/vendor-list/${retired}/archive`);

  assert.deepEqual(await companies('planner'), ['Bright Lights', 'Editor admin AV', 'Editor manager AV', 'Editor owner AV']);
  assert.deepEqual(await companies('planner', '?search=bright'), ['Bright Lights']);
  assert.deepEqual(await companies('planner', '?search=LIGHTING'), ['Bright Lights']);
  assert.deepEqual(await companies('planner', '?category=audio%20and%20video'), ['Editor admin AV', 'Editor manager AV', 'Editor owner AV']);
  assert.deepEqual(await companies('planner', '?category=audio'), []);
  // A search string is matched literally, not as a pattern.
  assert.deepEqual(await companies('planner', '?search=.*'), []);
  assert.deepEqual(await companies('planner', '?status=archived'), ['Retired Rigging']);
  assert.deepEqual((await call('planner', 'GET', '/api/v1/vendor-list/categories')).body.data, ['Audio and video', 'Lighting']);
  const page = (await call('planner', 'GET', '/api/v1/vendor-list?limit=2&offset=1')).body.data;
  assert.deepEqual([page.items.length, page.total, page.limit, page.offset], [2, 4, 2, 1]);
  assert.equal((await call('planner', 'GET', `/api/v1/vendor-list/${lights}`)).body.data.contacts[0].email, 'lee@bright.example');

  const writes: Array<[string, string, unknown?]> = [
    ['POST', '/api/v1/vendor-list', { company: 'Not allowed' }],
    ['PATCH', `/api/v1/vendor-list/${lights}`, { company: 'Not allowed' }],
    ['POST', `/api/v1/vendor-list/${lights}/archive`],
    ['POST', `/api/v1/vendor-list/${retired}/restore`],
  ];
  for (const who of ['planner', 'viewer']) {
    for (const [method, path, body] of writes) assert.equal((await call(who, method, path, body)).status, 403, `${who} ${method} ${path}`);
  }
  for (const path of ['/api/v1/vendor-list', '/api/v1/vendor-list/categories', `/api/v1/vendor-list/${lights}`]) {
    const refused = await call('viewer', 'GET', path);
    assert.equal(refused.status, 403, path);
    assert.doesNotMatch(refused.text, /Bright Lights|bright\.example/);
  }
  assert.equal((await stored(lights))!.company, 'Bright Lights');
  assert.equal((await stored(retired))!.archived, true);
});

test('another organization can neither see nor change the list: a foreign vendor is a 404', async () => {
  const secret = await call('owner', 'POST', '/api/v1/vendor-list', {
    company: `${MARKER} Staging`, category: `${MARKER} category`, contacts: [{ name: `${MARKER} contact`, email: `${MARKER.toLowerCase()}@vendor.example` }],
  });
  assert.equal(secret.status, 201, secret.text);
  const vendorId = secret.body.data.id as string;
  const before = JSON.stringify(await stored(vendorId));
  const missingId = randomMongoId();

  for (const who of ['foreignOwner', 'foreignPlanner']) {
    for (const path of ['/api/v1/vendor-list?status=all&limit=200', `/api/v1/vendor-list?search=${MARKER}`, '/api/v1/vendor-list/categories']) {
      const read = await call(who, 'GET', path);
      assert.equal(read.status, 200, `${who} ${path}`);
      assert.doesNotMatch(read.text, new RegExp(`${MARKER}|${vendorId}`, 'i'), `${who} ${path}`);
    }
  }
  const attempts: Array<[string, string, unknown?]> = [
    ['GET', '/api/v1/vendor-list/:id'],
    ['PATCH', '/api/v1/vendor-list/:id', { company: 'Taken over', contacts: [] }],
    ['POST', '/api/v1/vendor-list/:id/archive'],
    ['POST', '/api/v1/vendor-list/:id/restore'],
  ];
  for (const [method, path, body] of attempts) {
    const foreign = await call('foreignOwner', method, path.replace(':id', vendorId), body);
    const missing = await call('foreignOwner', method, path.replace(':id', missingId), body);
    assert.equal(foreign.status, 404, `${method} ${path}: ${foreign.text}`);
    // Indistinguishable from a vendor that does not exist.
    assert.deepEqual(foreign.body, missing.body, `${method} ${path}`);
    assert.doesNotMatch(foreign.text, new RegExp(MARKER, 'i'));
  }
  assert.equal(JSON.stringify(await stored(vendorId)), before);
  assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: orgB, targetType: 'organization_vendor' }), 0);

  // A forged organization id in the body or query does not move the write or widen the read.
  const forged = await call('foreignOwner', 'POST', `/api/v1/vendor-list?organizationId=${orgA}`, { company: 'Forged', organizationId: String(orgA) });
  assert.equal(forged.status, 201, forged.text);
  assert.equal(String((await stored(forged.body.data.id))!.organizationId), String(orgB));
  assert.doesNotMatch((await call('foreignOwner', 'GET', `/api/v1/vendor-list?organizationId=${orgA}&status=all`)).text, new RegExp(MARKER, 'i'));
  // The same company name is free in another organization.
  assert.equal((await call('foreignOwner', 'POST', '/api/v1/vendor-list', { company: 'Bright Lights' })).status, 201);
});

test('a vendor holding a submission link never sees the vendor list', async () => {
  const recipient = `${MARKER.toLowerCase()}@vendor.example`;
  const draft = await call('planner', 'POST', '/api/proposals', { event: { eventName: 'Vendor link RFP' } });
  assert.equal(draft.status, 201, draft.text);
  const proposalId = String(draft.body.data._id);
  assert.equal((await call('planner', 'PATCH', `/api/proposals/${proposalId}/status`, { status: 'submitted' })).status, 200);
  const issued = await call('planner', 'POST', '/api/public-access', { resourceId: proposalId, purpose: 'vendor:submit', recipient });
  assert.equal(issued.status, 201, issued.text);
  const grant = String(issued.body.grant.token);
  const grantQuery = `accessGrant=${encodeURIComponent(grant)}&proposalId=${proposalId}&email=${encodeURIComponent(recipient)}`;

  // The link works for what it is for...
  const rfp = await send({}, 'GET', `/api/proposals/${proposalId}?${grantQuery}`);
  assert.equal(rfp.status, 200, rfp.text);
  const workspace = await send({}, 'GET', `/api/vendor-responses/workspace?${grantQuery}`);
  // ...and nothing it returns carries the list, although this vendor is on it.
  for (const answer of [rfp, workspace]) assert.doesNotMatch(answer.text, new RegExp(`${MARKER}|Bright Lights|Editor owner AV`, 'i'));

  // The grant is not a credential for any vendor-list route, however it is presented.
  const vendorId = String((await OrganizationVendor.findOne({ organizationId: orgA, company: `${MARKER} Staging` }).lean())!._id);
  const routes: Array<[string, string]> = [
    ['GET', '/api/v1/vendor-list'], ['GET', '/api/v1/vendor-list/categories'], ['POST', '/api/v1/vendor-list'],
    ['GET', `/api/v1/vendor-list/${vendorId}`], ['PATCH', `/api/v1/vendor-list/${vendorId}`],
    ['POST', `/api/v1/vendor-list/${vendorId}/archive`], ['POST', `/api/v1/vendor-list/${vendorId}/restore`],
  ];
  const presentations: Array<Record<string, string>> = [{}, { 'x-rfpilot-access-grant': grant }, { authorization: `Bearer ${grant}` }];
  for (const [method, path] of routes) {
    for (const headers of presentations) {
      const answer = await send(headers, method, `${path}?${grantQuery}`, method === 'GET' ? undefined : { accessGrant: grant, proposalId, company: 'From a vendor' });
      assert.equal(answer.status, 401, `${method} ${path} ${Object.keys(headers).join()}: ${answer.text}`);
      assert.doesNotMatch(answer.text, new RegExp(MARKER, 'i'));
    }
  }
  assert.equal(await OrganizationVendor.countDocuments({ organizationId: orgA, company: 'From a vendor' }), 0);
  assert.equal((await stored(vendorId))!.archived, false);
});
