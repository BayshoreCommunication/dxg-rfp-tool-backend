// ORG-407: the organization audit log through the real app (routes, authenticate middleware,
// controller, Mongo reader): who may read it, cross-tenant isolation, RFPilot Support attribution,
// the filters, and the CSV export.
import { TEST_MONGODB_DB_NAME } from './env';
import { connectMongo, disconnectMongo, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import app from '../server';
import Admin from '../modal/adminModel';
import Organization from '../modal/organizationModel';
import OrganizationMembership from '../modal/organizationMembershipModel';
import OrganizationVendor from '../modal/organizationVendorModel';
import RefreshSession from '../modal/refreshSessionModel';
import SecurityAuditEvent from '../modal/securityAuditEventModel';
import User from '../modal/userModel';
import { authenticateWithCredentials, authenticationSessions } from '../src/modules/auth/composition';
import { closePostgres } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';

let server: http.Server;
let baseUrl: string;
let orgA: mongoose.Types.ObjectId;
let orgB: mongoose.Types.ObjectId;
const orgIds: mongoose.Types.ObjectId[] = [];
const tokens: Record<string, string> = {};
const users: Record<string, { id: string; email: string }> = {};
const MARKER = `AUDIT${randomMongoId().slice(0, 10).toUpperCase()}`;
const STAFF_NAME = `${MARKER} Staff Person`;
const staffId = new mongoose.Types.ObjectId();
const PASSWORD = `pw-${randomMongoId()}`;

const member = async (organizationId: mongoose.Types.ObjectId, key: string, roles: string[], name = key) => {
  const user = await User.create({ name, email: `${key}-${randomMongoId().slice(0, 10)}@example.com`, password: 'not-a-real-hash', role: 'customer', organizationId });
  const membership = await OrganizationMembership.create({ organizationId, userId: user._id, roles, status: 'active' });
  const session = await authenticationSessions.begin({
    account: { userId: String(user._id), accountType: 'planner', email: user.email, organizationId: String(organizationId), role: 'customer', roles, rolesVersion: membership.version },
    correlationId: randomMongoId(),
  });
  tokens[key] = session.accessToken;
  users[key] = { id: String(user._id), email: user.email };
};
const send = async (headers: Record<string, string>, path: string) => {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  const text = await res.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
};
const get = (who: string, path: string) => send({ authorization: `Bearer ${tokens[who]}` }, path);
const post = async (who: string, path: string, body: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const events = async (who: string, query = '') => {
  const res = await get(who, `/api/v1/organization/audit-events${query}`);
  assert.equal(res.status, 200, res.text);
  return res.body.data.events as Array<Record<string, any>>;
};
const ROUTES = ['/api/v1/organization/audit-events', '/api/v1/organization/audit-events/filters', '/api/v1/organization/audit-events/export'];

before(async () => {
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  orgA = (await Organization.create({ name: 'Audit A', slug: `intg-audit-${randomMongoId().slice(0, 10)}` }))._id as mongoose.Types.ObjectId;
  orgB = (await Organization.create({ name: 'Audit B', slug: `intg-audit-${randomMongoId().slice(0, 10)}` }))._id as mongoose.Types.ObjectId;
  orgIds.push(orgA, orgB);
  // A member name a spreadsheet would run as a formula.
  await member(orgA, 'owner', ['owner'], '=HYPERLINK("http://evil.test","Owner")');
  await member(orgA, 'admin', ['organization_admin']);
  await member(orgA, 'manager', ['team_manager']);
  await member(orgA, 'planner', ['planner']);
  await member(orgA, 'viewer', ['viewer']);
  await member(orgB, 'foreignOwner', ['owner'], `${MARKER} Foreign Owner`);
  // A staff account in `admins`, whose name must never reach a customer.
  await Admin.collection.insertOne({ _id: staffId, name: STAFF_NAME, email: `staff-${MARKER.toLowerCase()}@example.com`, role: 'admin', createdAt: new Date(), updatedAt: new Date() });
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Real writers: a vendor-list edit and a support grant in A, a vendor-list edit in B.
  assert.equal((await post('owner', '/api/v1/vendor-list', { company: `${MARKER} Audio A`, category: 'audio', contacts: [] })).status, 201);
  assert.equal((await post('admin', '/api/v1/organization/support-grants', { reason: 'Audit log test' })).status, 201);
  assert.equal((await post('foreignOwner', '/api/v1/vendor-list', { company: `${MARKER} Audio B`, category: 'audio', contacts: [] })).status, 201);
  // RFPilot Support activity as ORG-404 writes it: the actor is an `admins` id.
  const base = { actorUserId: staffId, correlationId: randomMongoId() };
  await SecurityAuditEvent.create([
    { ...base, organizationId: orgA, action: 'support_access.used', targetType: 'organization', targetId: String(orgA), decision: 'allowed', reason: 'rfp.list', metadata: { grantId: 'grant-a', operation: 'rfp.list', agentAccountType: 'admin' } },
    { ...base, organizationId: orgA, action: 'support_access.denied', targetType: 'organization', targetId: String(orgA), decision: 'denied', reason: 'no_active_grant', metadata: { operation: 'rfp.read', agentAccountType: 'admin' } },
    { ...base, organizationId: orgB, action: 'support_access.used', targetType: 'organization', targetId: String(orgB), decision: 'allowed', reason: 'rfp.list', metadata: { grantId: `${MARKER}-grant-b`, operation: 'rfp.list', agentAccountType: 'admin' } },
    // Not part of the customer's view.
    { ...base, actorUserId: new mongoose.Types.ObjectId(users.owner.id), organizationId: orgA, action: 'auth.refresh.rotated', targetType: 'refresh_session', targetId: 's1', decision: 'allowed', reason: 'rotated', metadata: {} },
  ]);
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    await Promise.all([
      OrganizationVendor.deleteMany({ organizationId: { $in: orgIds } }),
      mongoose.connection.collection('supportaccessgrants').deleteMany({ organizationId: { $in: orgIds } }),
      OrganizationMembership.deleteMany({ organizationId: { $in: orgIds } }),
      RefreshSession.deleteMany({ organizationId: { $in: orgIds } }),
      User.deleteMany({ organizationId: { $in: orgIds } }),
      Admin.collection.deleteOne({ _id: staffId }),
      Organization.deleteMany({ _id: { $in: orgIds } }),
    ]);
  }
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
});

test('Owner and Admin read the audit log; Team Manager, Planner, Viewer and anonymous callers do not', async () => {
  for (const route of ROUTES) {
    for (const who of ['owner', 'admin']) assert.equal((await get(who, route)).status, 200, `${who} ${route}`);
    for (const who of ['manager', 'planner', 'viewer']) {
      const refused = await get(who, route);
      assert.equal(refused.status, 403, `${who} ${route}`);
      assert.equal(refused.text.includes(MARKER), false);
      assert.equal(refused.body.data, undefined);
    }
    assert.equal((await send({}, route)).status, 401, route);
    assert.equal((await send({ authorization: 'Bearer nope' }, route)).status, 401, route);
  }
});

test('a failed sign-in and a successful one are written and show up for the Owner', async () => {
  await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(users.planner.id) }, { $set: { password: await bcrypt.hash(PASSWORD, 4) } });
  const correlationId = randomMongoId();
  assert.deepEqual(await authenticateWithCredentials({ email: users.planner.email, password: 'wrong-password' }, 'customer', { correlationId }), { kind: 'wrong_password' });
  const written = await SecurityAuditEvent.find({ organizationId: orgA, action: 'auth.login.failed' }).lean();
  assert.equal(written.length, 1);
  assert.equal(String(written[0].actorUserId), users.planner.id);
  assert.equal(written[0].decision, 'denied');
  assert.equal(written[0].reason, 'wrong_password');
  assert.equal(written[0].correlationId, correlationId);
  assert.equal(JSON.stringify(written[0]).includes(users.planner.email), false);
  assert.equal((await authenticateWithCredentials({ email: users.planner.email, password: PASSWORD }, 'customer')).kind, 'authenticated');
  assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: orgA, action: 'auth.login.failed' }), 1);

  const failed = await events('owner', `?action=auth.login.failed`);
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0].actor, { kind: 'member', id: users.planner.id, name: 'planner', email: users.planner.email });
  assert.equal(failed[0].label, 'Sign-in failed');
  assert.deepEqual(failed[0].details, { method: 'password' });
  // Sessions begun for the fixtures are the sign-in successes.
  const signIns = await events('admin', `?action=auth.session.created&actor=${users.planner.id}`);
  assert.equal(signIns.length, 1);
  assert.equal(signIns[0].actor.id, users.planner.id);
});

test("an organization's events never reach another organization", async () => {
  const foreignIds = (await SecurityAuditEvent.find({ organizationId: orgB }).select('_id').lean()).map((doc) => String(doc._id));
  assert.ok(foreignIds.length >= 3);
  const leaks = (text: string) => text.includes(MARKER + ' Foreign') || text.includes(`${MARKER}-grant-b`) || text.includes(String(orgB)) || foreignIds.some((id) => text.includes(id)) || text.includes(users.foreignOwner.id);
  for (const who of ['owner', 'admin']) {
    for (const query of ['', `?organizationId=${orgB}`, `?actor=${users.foreignOwner.id}`, '?actor=support', '?category=vendor_list', `?organizationId[]=${orgB}`, '?limit=100']) {
      for (const route of [ROUTES[0], ROUTES[2]]) {
        const res = await get(who, `${route}${query}`);
        assert.ok(res.status === 200 || res.status === 400, `${route}${query} -> ${res.status}`);
        assert.equal(leaks(res.text), false, `${who} ${route}${query} leaked a foreign event`);
      }
    }
  }
  // Each side sees exactly its own vendor-list event, and the foreign member's id selects nothing.
  assert.equal((await events('owner', '?action=organization_vendor.created')).length, 1);
  assert.deepEqual(await events('owner', `?actor=${users.foreignOwner.id}`), []);
  const theirs = await events('foreignOwner', '?action=organization_vendor.created');
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0].actor.id, users.foreignOwner.id);
  assert.equal((await events('foreignOwner')).some((event) => event.actor.id === users.owner.id || event.target.id === String(orgA)), false);
});

test('RFPilot Support activity is attributed to RFPilot Support, never to a staff name', async () => {
  const support = await events('owner', '?actor=support');
  assert.deepEqual(support.map((event) => event.action).sort(), ['support_access.denied', 'support_access.used']);
  for (const event of support) assert.deepEqual(event.actor, { kind: 'support', id: String(staffId), name: 'RFPilot Support' });
  assert.deepEqual(support.find((event) => event.action === 'support_access.used')!.details, { grantId: 'grant-a', operation: 'rfp.list' });
  // The staff id used as a "user" filter matches nothing, and the name is nowhere in JSON or CSV.
  assert.deepEqual(await events('owner', `?actor=${staffId}`), []);
  for (const route of [ROUTES[0], ROUTES[2]]) {
    const res = await get('owner', route);
    assert.equal(res.text.includes(STAFF_NAME), false);
    assert.equal(res.text.includes(`staff-${MARKER.toLowerCase()}`), false);
  }
  const granted = await events('owner', '?action=support_access.granted');
  assert.equal(granted.length, 1);
  assert.equal(granted[0].actor.id, users.admin.id);
  assert.equal(granted[0].details.scope, 'organization');
});

test('filters by user, action, category and date; uncatalogued actions are hidden; paging has no gaps', async () => {
  const all = await events('owner', '?limit=100');
  assert.equal(all.some((event) => event.action === 'auth.refresh.rotated'), false);
  const times = all.map((event) => Date.parse(event.occurredAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  assert.ok((await events('owner', `?actor=${users.owner.id}`)).every((event) => event.actor.id === users.owner.id));
  assert.ok((await events('owner', '?category=sign_in')).every((event) => event.category === 'sign_in'));
  assert.deepEqual(await events('owner', '?to=2020-01-01'), []);
  assert.equal((await events('owner', `?from=${new Date(Date.now() - 3600_000).toISOString()}&limit=100`)).length, all.length);
  for (const bad of ['?action=auth.refresh.rotated', '?actor=nope', '?from=nope', '?actor[$ne]=x', '?cursor=%%%', '?limit=0']) {
    const res = await get('owner', `${ROUTES[0]}${bad}`);
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.code, 'AUDIT_FILTER_INVALID');
  }
  const paged: string[] = [];
  let cursor: string | null = null;
  do {
    const res = await get('owner', `${ROUTES[0]}?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
    paged.push(...res.body.data.events.map((event: { id: string }) => event.id));
    cursor = res.body.data.nextCursor;
  } while (cursor);
  assert.deepEqual(paged, all.map((event) => event.id));

  const filters = await get('admin', ROUTES[1]);
  const actions = filters.body.data.categories.flatMap((category: { actions: Array<{ value: string }> }) => category.actions.map((action) => action.value));
  assert.ok(actions.includes('auth.login.failed') && actions.includes('support_access.used'));
  assert.equal(actions.includes('auth.refresh.rotated'), false);
  assert.deepEqual(filters.body.data.supportActor, { value: 'support', label: 'RFPilot Support' });
});

test('the CSV export carries the same rows as the list and neutralizes formula cells', async () => {
  const res = await get('owner', `${ROUTES[2]}?actor=${users.owner.id}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/csv/);
  assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-audit-export-truncated'), 'false');
  const listed = await events('owner', `?actor=${users.owner.id}&limit=100`);
  const lines = res.text.trimEnd().split('\r\n');
  assert.equal(lines.length - 1, listed.length);
  assert.equal(res.headers.get('x-audit-export-rows'), String(listed.length));
  for (const event of listed) assert.ok(res.text.includes(`"${event.id}"`));
  // The Owner's name starts with "=": it is exported with a leading apostrophe, never bare.
  assert.ok(res.text.includes(`"'=HYPERLINK(""http://evil.test"",""Owner"")"`));
  assert.equal(/(^|,)"\s*[=+\-@]/m.test(res.text), false);
});
