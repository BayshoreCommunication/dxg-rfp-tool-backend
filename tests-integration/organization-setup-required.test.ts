// An account created before Organization Accounts waits in a legacy holding tenant until DXG
// places it (ORG-110). Until then sign-in is refused with ORGANIZATION_SETUP_REQUIRED, and a
// session issued earlier is ended on its next request, so the dashboard signs the person out
// and tells them to contact DXG. Drives the real app against the integration stack.
import { TEST_MONGODB_DB_NAME } from './env';
import { connectMongo, disconnectMongo, ensureMigrated, ensureServices, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import mongoose from 'mongoose';
import app from '../server';
import Organization from '../modal/organizationModel';
import OrganizationMembership from '../modal/organizationMembershipModel';
import RefreshSession from '../modal/refreshSessionModel';
import SecurityAuditEvent from '../modal/securityAuditEventModel';
import User from '../modal/userModel';
import { beginAuthenticatedSession } from '../src/modules/auth/composition';
import { closePostgres } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';

let server: http.Server;
let baseUrl: string;
const tag = randomMongoId().slice(0, 10);
const PASSWORD = 'correct-horse-battery-staple';

const login = async (email: string) => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};
const me = async (token: string) => {
  const res = await fetch(`${baseUrl}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};

const createAccount = async (who: string, kind: 'legacy_holding' | 'customer') => {
  const organization = await Organization.create({ name: `Setup ${who}`, slug: `intg-setup-${who}-${tag}`, kind });
  const user = await User.create({
    name: `Setup ${who}`,
    email: `setup-${who}-${tag}@example.com`,
    password: PASSWORD,
    role: 'customer',
    organizationId: organization._id,
  });
  await OrganizationMembership.create({
    organizationId: organization._id, userId: user._id, roles: [kind === 'customer' ? 'owner' : 'planner'], status: 'active',
  });
  return { email: user.email, userId: String(user._id), organizationId: String(organization._id) };
};

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  await Promise.all([User.init(), Organization.init(), OrganizationMembership.init()]);
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    const ids = (await Organization.find({ slug: new RegExp(`^intg-setup-.*-${tag}$`) }).select('_id').lean()).map((o) => o._id);
    await Promise.all([
      RefreshSession.deleteMany({ organizationId: { $in: ids } }),
      OrganizationMembership.deleteMany({ organizationId: { $in: ids } }),
      User.deleteMany({ organizationId: { $in: ids } }),
      Organization.deleteMany({ _id: { $in: ids } }),
    ]);
  }
  await closeSecurityRateLimitRedis();
  await closePostgres();
  await disconnectMongo();
});

test('an account waiting for DXG is refused at sign-in and told what to do', async () => {
  const account = await createAccount('signin', 'legacy_holding');
  const refused = await login(account.email);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'ORGANIZATION_SETUP_REQUIRED');
  assert.match(refused.body.message, /isn't part of an organization yet/);
  assert.equal(refused.body.accessToken, undefined);
  assert.equal(await RefreshSession.countDocuments({ userId: account.userId }), 0, 'no session is created');
});

test('a wrong password still answers as a wrong password, not with the account\'s placement state', async () => {
  const account = await createAccount('wrong', 'legacy_holding');
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: 'not-the-password' }),
  });
  const body = (await res.json()) as Record<string, any>;
  assert.equal(res.status, 401);
  assert.notEqual(body.code, 'ORGANIZATION_SETUP_REQUIRED');
});

test('a session issued before the rule is ended on its next request', async () => {
  const account = await createAccount('session', 'legacy_holding');
  const session = await beginAuthenticatedSession({ userId: account.userId, organizationId: account.organizationId, correlationId: randomMongoId() });
  const first = await me(session.accessToken);
  assert.equal(first.status, 401);
  assert.equal(first.body.code, 'ORGANIZATION_SETUP_REQUIRED');
  assert.equal(await RefreshSession.countDocuments({ userId: account.userId, status: 'active' }), 0, 'every session is revoked');
  assert.equal(
    await SecurityAuditEvent.countDocuments({ actorUserId: account.userId, action: 'auth.sessions.revoked_all', reason: 'organization_setup_required' }),
    1,
  );
  // Idempotent: a repeat request is refused the same way and writes no second audit event.
  assert.equal((await me(session.accessToken)).body.code, 'ORGANIZATION_SETUP_REQUIRED');
  assert.equal(await SecurityAuditEvent.countDocuments({ actorUserId: account.userId, action: 'auth.sessions.revoked_all' }), 1);
});

test('once DXG has placed the account it signs in as usual', async () => {
  const account = await createAccount('placed', 'legacy_holding');
  assert.equal((await login(account.email)).status, 403);
  // What placement leaves behind as far as sign-in is concerned: a membership in a customer organization.
  await Organization.updateOne({ _id: account.organizationId }, { $set: { kind: 'customer' } });
  const signedIn = await login(account.email);
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.equal((await me(signedIn.body.accessToken)).status, 200);
});

test('accounts in a customer organization are unaffected', async () => {
  const account = await createAccount('customer', 'customer');
  const signedIn = await login(account.email);
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.equal((await me(signedIn.body.accessToken)).status, 200);
});
