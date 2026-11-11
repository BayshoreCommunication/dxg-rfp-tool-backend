// ORG-601: plan entitlements end to end through the real app (routes, authenticate middleware,
// controllers, use cases, repositories) against the replica-set Mongo and Postgres. Covers the
// free-trial RFP limit on every create path, the race at the limit, the counter never going down,
// and every gated route being refused on the free trial and open after a plan change.
import { TEST_MONGODB_DB_NAME, TEST_POSTGRES_URL } from './env';
import { connectMongo, disconnectMongo, ensureMigrated, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import type { Application } from 'express';
import mongoose from 'mongoose';
import { Pool } from 'pg';
import app from '../server';
import Organization from '../modal/organizationModel';
import Notification from '../modal/notificationModel';
import OrganizationMembership from '../modal/organizationMembershipModel';
import Proposal from '../modal/proposalsModel';
import ProposalStatusTransition from '../modal/proposalStatusTransitionModel';
import PublicAccessGrant from '../modal/publicAccessGrantModel';
import RefreshSession from '../modal/refreshSessionModel';
import User from '../modal/userModel';
import VendorResponse from '../modal/vendorResponseModel';
import { authenticationSessions } from '../src/modules/auth/composition';
import { closePostgres } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';
import { closeQueue } from '../src/modules/durableJobs/queue';

type Org = { id: mongoose.Types.ObjectId; token: string; userId: string };

let server: http.Server;
let baseUrl: string;
let admin: Pool;
const orgIds: mongoose.Types.ObjectId[] = [];

const organization = async (fields: Record<string, unknown> = {}): Promise<Org> => {
  const created = await Organization.create({ name: 'Plan Org', slug: `intg-plan-${randomMongoId().slice(0, 12)}`, ...fields });
  const id = created._id as mongoose.Types.ObjectId;
  orgIds.push(id);
  const user = await User.create({ name: 'Owner', email: `owner-${randomMongoId().slice(0, 10)}@example.test`, password: 'not-a-real-hash', role: 'customer', organizationId: id });
  const membership = await OrganizationMembership.create({ organizationId: id, userId: user._id, roles: ['owner'], status: 'active' });
  const session = await authenticationSessions.begin({
    account: { userId: String(user._id), accountType: 'planner', email: user.email, organizationId: String(id), role: 'customer', roles: ['owner'], rolesVersion: membership.version },
    correlationId: randomMongoId(),
  });
  return { id, token: session.accessToken, userId: String(user._id) };
};

const call = async (org: Org, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${org.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* exports are not JSON */ }
  return { status: res.status, body: json };
};

const create = (org: Org, name = 'Gala') => call(org, 'POST', '/api/proposals', { event: { eventName: `${name} ${randomMongoId().slice(0, 6)}` } });
const copy = (org: Org, proposalId: string) => call(org, 'POST', `/api/proposals/${proposalId}/copy`, { eventName: 'Copy', isDraft: true });
const createdCount = async (org: Org) => (await Organization.findById(org.id).select('proposalsCreated').lean())?.proposalsCreated;
const storedProposals = (org: Org) => Proposal.countDocuments({ organizationId: org.id });
const setPlan = (org: Org, plan: string) => Organization.updateOne({ _id: org.id }, { $set: { plan } });

const assertLimitReached = (result: { status: number; body: Record<string, any> }, created = 2) => {
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body.code, 'PLAN_LIMIT_REACHED');
  assert.equal(result.body.success, false);
  assert.deepEqual({ plan: result.body.plan, limit: result.body.limit, created: result.body.created }, { plan: 'free_trial', limit: 2, created });
  assert.match(result.body.message, /RFP/);
  assert.doesNotMatch(result.body.message, /proposal/i);
};

// Express 4 keeps each mounted router's prefix only as a regexp; this reverses the simple ones
// (same approach as tenant-isolation-routes.test.ts).
const mountPrefix = (layer: { regexp: RegExp & { fast_slash?: boolean } }) =>
  layer.regexp.fast_slash ? '' : layer.regexp.source.replace('^\\/', '/').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
const listRoutes = (target: Application) => {
  const routes: Array<{ method: string; path: string }> = [];
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) for (const method of Object.keys(layer.route.methods)) routes.push({ method: method.toUpperCase(), path: `${prefix}${layer.route.path}` });
      else if (layer.name === 'router' && layer.handle?.stack) walk(layer.handle.stack, prefix + mountPrefix(layer));
    }
  };
  walk((target as any)._router.stack, '');
  return routes;
};

// The planner's vendor-response reads and export. Everything else under /api/vendor-responses
// (the vendor's submission flow, the send side, delete by id) stays open on every plan.
const VENDOR_RESPONSE_READS = new Set([
  'GET /api/vendor-responses/',
  'GET /api/vendor-responses/proposals',
  'GET /api/vendor-responses/:id/submission-detail',
  'GET /api/vendor-responses/:id/submission-export',
  'GET /api/vendor-responses/:id',
  'PATCH /api/vendor-responses/:id/read',
]);
const featureOf = (route: { method: string; path: string }): 'vendorResponses' | 'proposalIntelligence' | null => {
  if (route.path.startsWith('/api/v1/proposals/:proposalId/intelligence/')) return 'proposalIntelligence';
  if (route.path.startsWith('/api/v1/vendor-responses/:responseId/analysis-')) return 'vendorResponses';
  if (VENDOR_RESPONSE_READS.has(`${route.method} ${route.path}`)) return 'vendorResponses';
  return null;
};

before(async () => {
  ensureMigrated();
  admin = new Pool({ connectionString: TEST_POSTGRES_URL, max: 2 });
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
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
      Notification.deleteMany({ organizationId: { $in: orgIds } }),
      PublicAccessGrant.deleteMany({ organizationId: { $in: orgIds } }),
      OrganizationMembership.deleteMany({ organizationId: { $in: orgIds } }),
      RefreshSession.deleteMany({ organizationId: { $in: orgIds } }),
      User.deleteMany({ organizationId: { $in: orgIds } }),
      Organization.deleteMany({ _id: { $in: orgIds } }),
    ]);
  }
  await admin?.end();
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
  await closeQueue();
});

test('a new organization starts on the free trial with both features locked', async () => {
  const org = await organization();
  const entitlements = await call(org, 'GET', '/api/organization/entitlements');
  assert.equal(entitlements.status, 200, JSON.stringify(entitlements.body));
  assert.deepEqual(entitlements.body.data, {
    plan: 'free_trial',
    exempt: false,
    proposals: { created: 0, limit: 2, remaining: 2, canCreate: true },
    features: { vendorResponses: false, proposalIntelligence: false },
  });
});

test('the third create is refused with PLAN_LIMIT_REACHED and counts nothing', async () => {
  const org = await organization();
  assert.equal((await create(org)).status, 201);
  assert.equal(await createdCount(org), 1);
  assert.equal((await create(org)).status, 201);
  assert.equal(await createdCount(org), 2);

  assertLimitReached(await create(org));
  assert.equal(await createdCount(org), 2);
  assert.equal(await storedProposals(org), 2);
  assert.deepEqual((await call(org, 'GET', '/api/organization/entitlements')).body.data.proposals, { created: 2, limit: 2, remaining: 0, canCreate: false });
});

test('a duplicate counts toward the limit and is refused at it', async () => {
  const org = await organization();
  const first = await create(org);
  assert.equal(first.status, 201);
  const duplicate = await copy(org, first.body.data._id);
  assert.equal(duplicate.status, 201, JSON.stringify(duplicate.body));
  assert.equal(await createdCount(org), 2);

  assertLimitReached(await copy(org, first.body.data._id));
  assertLimitReached(await create(org));
  assert.equal(await storedProposals(org), 2);
});

test('concurrent creates at the limit: exactly one takes the last slot', async () => {
  const org = await organization();
  const first = await create(org);
  assert.equal(first.status, 201);

  // New RFPs and duplicates race for the one slot left.
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? copy(org, first.body.data._id) : create(org, 'Race'))));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 403, 403, 403, 403, 403, 403, 403], JSON.stringify(results.map((r) => r.body.code ?? r.body.message)));
  for (const refused of results.filter((r) => r.status === 403)) assertLimitReached(refused);
  assert.equal(await createdCount(org), 2);
  assert.equal(await storedProposals(org), 2);
});

test('concurrent creates from zero: exactly two succeed', async () => {
  const org = await organization();
  const results = await Promise.all(Array.from({ length: 10 }, () => create(org, 'Burst')));
  assert.equal(results.filter((r) => r.status === 201).length, 2, JSON.stringify(results.map((r) => r.status)));
  assert.equal(results.filter((r) => r.status === 403 && r.body.code === 'PLAN_LIMIT_REACHED').length, 8);
  assert.equal(await createdCount(org), 2);
  assert.equal(await storedProposals(org), 2);
});

test("deleting an RFP doesn't free a slot", async () => {
  const org = await organization();
  const first = await create(org);
  await create(org);
  const id = first.body.data._id;

  assert.equal((await call(org, 'DELETE', `/api/proposals/${id}`)).status, 200);
  assertLimitReached(await create(org));
  assert.equal((await call(org, 'DELETE', `/api/proposals/${id}/permanent`)).status, 200);
  assert.equal(await storedProposals(org), 1);

  assert.equal(await createdCount(org), 2);
  assertLimitReached(await create(org));
  assertLimitReached(await copy(org, String((await Proposal.findOne({ organizationId: org.id }).select('_id').lean())?._id)));
  assert.equal(await storedProposals(org), 1);
});

test("a create that fails validation doesn't use a slot", async () => {
  const org = await organization();
  const invalid = await call(org, 'POST', '/api/proposals', { status: 'not-a-status', event: { eventName: 'Invalid' } });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  assert.equal(await createdCount(org), 0);
  assert.equal(await storedProposals(org), 0);
  assert.equal((await create(org)).status, 201);
  assert.equal((await create(org)).status, 201);
  assert.equal(await createdCount(org), 2);
});

test('a plan change lifts the limit, and the counter keeps counting', async () => {
  const org = await organization();
  await create(org);
  await create(org);
  assertLimitReached(await create(org));

  await setPlan(org, 'full_access');
  for (let i = 0; i < 3; i++) assert.equal((await create(org)).status, 201);
  assert.equal(await createdCount(org), 5);
  assert.deepEqual((await call(org, 'GET', '/api/organization/entitlements')).body.data, {
    plan: 'full_access',
    exempt: false,
    proposals: { created: 5, limit: null, remaining: null, canCreate: true },
    features: { vendorResponses: true, proposalIntelligence: true },
  });

  // Back on the free trial the organization is over the limit, not reset.
  await setPlan(org, 'free_trial');
  assertLimitReached(await create(org), 5);
});

test('organizations written before plans existed are held to the free trial', async () => {
  const org = await organization();
  await Organization.collection.updateOne({ _id: org.id }, { $unset: { plan: '', proposalsCreated: '' } });
  assert.equal((await create(org)).status, 201);
  assert.equal((await create(org)).status, 201);
  assertLimitReached(await create(org));
  assert.equal(await createdCount(org), 2);

  // A plan value this build doesn't know never unlocks anything.
  await Organization.collection.updateOne({ _id: org.id }, { $set: { plan: 'enterprise' } });
  assert.equal((await create(org)).status, 403);
  assert.equal((await call(org, 'GET', '/api/vendor-responses')).body.code, 'PLAN_FEATURE_LOCKED');
});

test('a legacy holding tenant is exempt from the limit; its creates are still counted', async () => {
  // Legacy accounts can't sign in until DXG places them (ORG-110), so this goes through the
  // repository under the tenant context a trusted caller would set.
  const { runWithTenant } = await import('../src/modules/shared/tenancy/tenantContext');
  const { mongoProposalWriteRepository } = await import('../src/modules/proposals/infrastructure/mongo/mongoProposalWriteRepository');
  const holding = await Organization.create({ name: 'Holding', slug: `intg-plan-${randomMongoId().slice(0, 12)}`, kind: 'legacy_holding' });
  orgIds.push(holding._id as mongoose.Types.ObjectId);
  const userId = randomMongoId();
  for (let i = 0; i < 4; i++) {
    await runWithTenant({ organizationId: String(holding._id), userId }, () =>
      mongoProposalWriteRepository.createOwned({ ownerUserId: userId, proposal: { event: { eventName: `Legacy ${i}` } } }));
  }
  assert.equal((await Organization.findById(holding._id).lean())?.proposalsCreated, 4);
  assert.equal(await Proposal.countDocuments({ organizationId: holding._id }), 4);
});

test('one organization reaching its limit leaves another untouched', async () => {
  const [full, other] = [await organization(), await organization()];
  await create(full);
  await create(full);
  assertLimitReached(await create(full));
  assert.equal(await createdCount(other), 0);
  assert.equal((await create(other)).status, 201);
  // Duplicating another organization's RFP is a miss, at the limit or under it.
  const foreign = String((await Proposal.findOne({ organizationId: other.id }).select('_id').lean())?._id);
  assert.equal((await copy(full, foreign)).status, 404);
  assert.equal((await copy(full, randomMongoId())).status, 404);
  assert.equal(await createdCount(other), 1);
});

test('every gated route is refused on the free trial and open after a plan change', async () => {
  const org = await organization();
  const proposal = await create(org);
  assert.equal(proposal.status, 201);
  const proposalId = String(proposal.body.data._id);
  const response = await VendorResponse.create({
    organizationId: org.id, proposalId, proposalOwnerId: org.userId, proposalTitle: 'Gala',
    vendorName: 'Stored Audio', submittedBy: 'Vendor', email: 'vendor@example.test', message: 'Stored quote',
    emailTrackingId: `plan-${randomMongoId()}`,
  });

  const gated = listRoutes(app).map((route) => ({ ...route, feature: featureOf(route) })).filter((route) => route.feature);
  // 48 intelligence routes, 4 vendor-analysis routes and 6 vendor-response reads. A route added
  // to those routers is picked up here by its path; update the count when one is.
  assert.equal(gated.length, 58, gated.map((r) => `${r.method} ${r.path}`).join('\n'));
  assert.equal(gated.filter((r) => r.feature === 'proposalIntelligence').length, 48);

  const pathFor = (path: string) => path
    .replace(':proposalId', proposalId)
    .replace(/:(responseId|id)\b/, String(response._id))
    .replace(':reportType', 'executive')
    .replace(/:(submissionId|versionId)/g, () => randomMongoId())
    .replace(/:\w+/g, () => '00000000-0000-4000-8000-000000000000');
  const probe = (route: { method: string; path: string }) =>
    call(org, route.method, pathFor(route.path), route.method === 'GET' ? undefined : {}, { 'idempotency-key': randomMongoId() });

  for (const route of gated) {
    const refused = await probe(route);
    const label = `${route.method} ${route.path}`;
    assert.equal(refused.status, 403, `${label} answered ${refused.status} on the free trial`);
    assert.equal(refused.body.code, 'PLAN_FEATURE_LOCKED', label);
    assert.equal(refused.body.feature, route.feature, label);
    assert.equal(refused.body.plan, 'free_trial', label);
    assert.doesNotMatch(JSON.stringify(refused.body), /Stored Audio|Stored quote/, label);
    assert.doesNotMatch(refused.body.message, /proposal/i, label);
  }

  // Nothing ran behind the gate: no intelligence job or run exists for the locked organization.
  const queued = await admin.query(
    'SELECT j.id FROM rfpilot.ai_jobs j JOIN rfpilot.organizations o ON o.id = j.organization_id WHERE o.external_mongo_id = $1',
    [String(org.id)],
  );
  assert.equal(queued.rowCount, 0);
  assert.equal((await VendorResponse.findById(response._id).lean())?.isRead, false);

  await setPlan(org, 'full_access');
  for (const route of gated) {
    const allowed = await probe(route);
    const label = `${route.method} ${route.path}`;
    assert.notEqual(allowed.body.code, 'PLAN_FEATURE_LOCKED', `${label} is still locked after the plan change`);
    assert.notEqual(allowed.body.code, 'PLAN_LIMIT_REACHED', label);
    // The handler ran and gave its own answer: a result, a validation error, a miss, or a
    // capability that is switched off on this stack. Never a refusal, a rate limit or a crash.
    assert.ok([200, 201, 202, 204, 400, 404, 409, 422, 503].includes(allowed.status), `${label} answered ${allowed.status} after the plan change: ${JSON.stringify(allowed.body)}`);
  }

  // The response stored while the organization was locked opens up with the plan.
  const listed = await call(org, 'GET', '/api/vendor-responses?limit=50');
  assert.equal(listed.status, 200);
  assert.deepEqual((listed.body.data as Array<{ vendorName: string }>).map((r) => r.vendorName), ['Stored Audio']);
  assert.equal((await call(org, 'GET', `/api/vendor-responses/${response._id}`)).status, 200);
});

test('a locked organization can still send to vendors, and the vendor link still works', async () => {
  const org = await organization();
  const proposal = await create(org);
  const proposalId = String(proposal.body.data._id);
  assert.equal((await call(org, 'PATCH', `/api/proposals/${proposalId}/status`, { status: 'submitted' })).status, 200);

  const grant = await call(org, 'POST', '/api/public-access', { resourceId: proposalId, purpose: 'vendor:submit', recipient: 'vendor@example.test' });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));
  const token = String(grant.body.grant?.token ?? '');
  assert.ok(token, JSON.stringify(grant.body));

  // The vendor's workspace is reached by grant alone and is never plan-gated.
  const workspace = await fetch(`${baseUrl}/api/vendor-responses/workspace?proposalId=${proposalId}&email=vendor@example.test`, {
    headers: { 'x-rfpilot-access-grant': token },
  });
  const body = await workspace.json() as Record<string, any>;
  assert.notEqual(body.code, 'PLAN_FEATURE_LOCKED');
  assert.equal(workspace.status, 200, JSON.stringify(body));

  // The planner still can't read what comes back until the plan changes.
  const locked = await call(org, 'GET', '/api/vendor-responses/proposals');
  assert.equal(locked.status, 403);
  assert.equal(locked.body.code, 'PLAN_FEATURE_LOCKED');
});

test('the gate is the same for a foreign id and a missing one', async () => {
  const [locked, other] = [await organization(), await organization({ plan: 'full_access' })];
  const foreign = await create(other);
  const foreignResponse = await VendorResponse.create({
    organizationId: other.id, proposalId: foreign.body.data._id, proposalOwnerId: other.userId, proposalTitle: 'Foreign',
    vendorName: 'Foreign Audio', submittedBy: 'Vendor', email: 'foreign@example.test', message: 'Foreign quote',
    emailTrackingId: `plan-${randomMongoId()}`,
  });
  const pairs: Array<[string, string]> = [
    [`/api/vendor-responses/${foreignResponse._id}`, `/api/vendor-responses/${randomMongoId()}`],
    [`/api/vendor-responses?proposalId=${foreign.body.data._id}`, `/api/vendor-responses?proposalId=${randomMongoId()}`],
    [`/api/v1/proposals/${foreign.body.data._id}/intelligence/requirement-sets`, `/api/v1/proposals/${randomMongoId()}/intelligence/requirement-sets`],
    [`/api/v1/proposals/${foreign.body.data._id}/intelligence/comparisons`, `/api/v1/proposals/${randomMongoId()}/intelligence/comparisons`],
  ];
  for (const [foreignPath, missingPath] of pairs) {
    const [a, b] = [await call(locked, 'GET', foreignPath), await call(locked, 'GET', missingPath)];
    assert.equal(a.status, 403);
    assert.deepEqual(a.body, b.body, foreignPath);
    assert.doesNotMatch(JSON.stringify(a.body), /Foreign/);
  }
  // With the feature unlocked the foreign record is a plain miss.
  await setPlan(locked, 'full_access');
  assert.equal((await call(locked, 'GET', `/api/vendor-responses/${foreignResponse._id}`)).status, 404);
  // The entitlements endpoint only ever describes the caller's organization.
  const own = await call(locked, 'GET', `/api/organization/entitlements?organizationId=${other.id}`);
  assert.equal(own.body.data.proposals.created, 0);
});

test("a locked organization's notification says a vendor responded, without the vendor's details", async () => {
  const { vendorResponseNotificationAdapter } = await import('../src/modules/vendorResponses/infrastructure/notifications/vendorResponseNotificationAdapter');
  const [locked, open] = [await organization(), await organization({ plan: 'full_access' })];
  const notify = (org: Org) => vendorResponseNotificationAdapter.notifyPlanner({
    ownerUserId: org.userId, organizationId: String(org.id), proposalId: randomMongoId(), responseId: randomMongoId(),
    proposalTitle: 'Gala', vendorName: 'Secret Audio', submittedBy: 'Sam Vendor', email: 'sam@secret.example',
    versionNumber: 1, responseFormat: 'structured_v1', grandTotalMinor: 1234500, currency: 'USD',
  });
  await notify(locked);
  await notify(open);

  const read = await call(locked, 'GET', '/api/notifications');
  assert.equal(read.status, 200);
  const text = JSON.stringify(read.body);
  assert.match(text, /A vendor responded to/);
  assert.doesNotMatch(text, /Secret Audio|Sam Vendor|sam@secret\.example|1234500/);
  const stored = await Notification.findOne({ organizationId: locked.id }).lean();
  assert.deepEqual(stored?.metadata, { planLocked: true, feature: 'vendorResponses' });

  const full = await Notification.findOne({ organizationId: open.id }).lean();
  assert.match(String(full?.message), /Secret Audio/);
  assert.equal((full?.metadata as Record<string, any>).calculatedTotal.amountMinor, 1234500);
});
