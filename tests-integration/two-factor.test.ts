// ORG-303: TOTP enrolment, the sign-in challenge, recovery codes, replay refusal, the shared
// rate limiter, and disable with re-authentication. Drives the real app (routes, controllers,
// Mongo repositories, session manager) against the integration stack.
import { TEST_MONGODB_DB_NAME, TEST_REDIS_URL } from './env';
import { connectMongo, disconnectMongo, ensureMigrated, ensureServices, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import app from '../server';
import Organization from '../modal/organizationModel';
import OrganizationMembership from '../modal/organizationMembershipModel';
import RefreshSession from '../modal/refreshSessionModel';
import SecurityAuditEvent from '../modal/securityAuditEventModel';
import TwoFactorChallenge from '../modal/twoFactorChallengeModel';
import User from '../modal/userModel';
import UserTwoFactor from '../modal/userTwoFactorModel';
import { totpAt } from '../src/modules/twoFactor/domain/totp';
import { closePostgres } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';

let server: http.Server;
let baseUrl: string;
const tag = randomMongoId().slice(0, 10);
const PASSWORD = 'correct-horse-battery-staple';

const post = async (path: string, body: unknown, token?: string) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};
const get = async (path: string, token: string) => {
  const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};

// Codes from the previous, current and next 30s step are all accepted once each, in increasing
// order. Start each test early in a step so the window doesn't move under it.
const freshStep = async () => {
  const intoStep = (Date.now() / 1000) % 30;
  if (intoStep > 18) await new Promise((resolve) => setTimeout(resolve, (30 - intoStep + 0.5) * 1000));
};
const code = (secret: string, stepOffset: number) => totpAt(secret, new Date(Date.now() + stepOffset * 30_000));

const createMember = async (who: string) => {
  const organization = await Organization.create({ name: `2FA ${who}`, slug: `intg-2fa-${who}-${tag}` });
  const user = await User.create({
    name: `2FA ${who}`,
    email: `twofa-${who}-${tag}@example.com`,
    password: PASSWORD,
    role: 'customer',
    organizationId: organization._id,
  });
  await OrganizationMembership.create({ organizationId: organization._id, userId: user._id, roles: ['owner'], status: 'active' });
  return { email: user.email, userId: String(user._id), organizationId: String(organization._id) };
};
const login = (email: string) => post('/api/auth/login', { email, password: PASSWORD });

const enrolSignedIn = async (email: string) => {
  const session = await login(email);
  assert.equal(session.status, 200);
  const started = await post('/api/auth/2fa/enrol/start', {}, session.body.accessToken);
  assert.equal(started.status, 200);
  const confirmed = await post('/api/auth/2fa/enrol/confirm', { code: code(started.body.secret, -1) }, session.body.accessToken);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  return { secret: started.body.secret as string, recoveryCodes: confirmed.body.recoveryCodes as string[], accessToken: session.body.accessToken as string };
};

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  await Promise.all([User.init(), Organization.init(), OrganizationMembership.init(), UserTwoFactor.init(), TwoFactorChallenge.init()]);
  // The per-IP 2FA limiter keys on 127.0.0.1, so clear only those counters from earlier runs.
  const redis = new Redis(TEST_REDIS_URL);
  const keys = await redis.keys('rfpilot:rate:2fa-*');
  if (keys.length) await redis.del(...keys);
  await redis.quit();
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    const orgs = await Organization.find({ slug: new RegExp(`^intg-2fa-.*-${tag}$`) }).select('_id').lean();
    const ids = orgs.map((o) => o._id);
    const users = await User.find({ organizationId: { $in: ids } }).select('_id').lean();
    await Promise.all([
      UserTwoFactor.deleteMany({ organizationId: { $in: ids } }),
      TwoFactorChallenge.deleteMany({ organizationId: { $in: ids } }),
      RefreshSession.deleteMany({ organizationId: { $in: ids } }),
      OrganizationMembership.deleteMany({ organizationId: { $in: ids } }),
      User.deleteMany({ _id: { $in: users.map((u) => u._id) } }),
      Organization.deleteMany({ _id: { $in: ids } }),
    ]);
  }
  await closeSecurityRateLimitRedis();
  await disconnectMongo();
  await closePostgres();
});

test('a member without 2FA still signs in with a password alone', async () => {
  const member = await createMember('plain');
  const res = await login(member.email);
  assert.equal(res.status, 200);
  assert.ok(res.body.accessToken);
  assert.equal(res.body.twoFactorRequired, undefined);
  const status = await get('/api/auth/2fa/status', res.body.accessToken);
  assert.deepEqual(
    { enabled: status.body.enabled, requiredByOrganization: status.body.requiredByOrganization },
    { enabled: false, requiredByOrganization: false },
  );
});

test('enrolment returns an otpauth URI, stores the seed encrypted and ten hashed recovery codes, and is audited', async () => {
  await freshStep();
  const member = await createMember('enrol');
  const { secret, recoveryCodes, accessToken } = await enrolSignedIn(member.email);
  assert.equal(recoveryCodes.length, 10);
  const row = await UserTwoFactor.findOne({ userId: member.userId }).select('+secretCiphertext +recoveryCodes').lean();
  assert.equal(row?.status, 'enabled');
  assert.ok(row!.secretCiphertext.startsWith('v1.'));
  assert.ok(!row!.secretCiphertext.includes(secret));
  assert.equal(row!.recoveryCodes.length, 10);
  const stored = JSON.stringify(row!.recoveryCodes);
  for (const recoveryCode of recoveryCodes) assert.ok(!stored.includes(recoveryCode) && !stored.includes(recoveryCode.replace(/-/g, '')));
  assert.equal(await SecurityAuditEvent.countDocuments({ actorUserId: member.userId, action: 'auth.two_factor.enrolled' }), 1);
  const status = await get('/api/auth/2fa/status', accessToken);
  assert.equal(status.body.enabled, true);
  assert.equal(status.body.recoveryCodesRemaining, 10);
});

test('sign-in with 2FA returns only a challenge; a code completes it once; a replayed code is refused', async () => {
  await freshStep();
  const member = await createMember('challenge');
  const { secret } = await enrolSignedIn(member.email);

  const first = await login(member.email);
  assert.equal(first.status, 200);
  assert.equal(first.body.twoFactorRequired, true);
  assert.equal(first.body.nextStep, 'two_factor_challenge');
  assert.equal(first.body.accessToken, undefined);
  assert.equal(first.body.refreshToken, undefined);
  assert.equal(first.body.user, undefined);
  // The challenge token is not an access token.
  assert.equal((await get('/api/auth/2fa/status', first.body.challengeToken)).status, 401);

  const now = code(secret, 0);
  const done = await post('/api/auth/2fa/challenge', { challengeToken: first.body.challengeToken, code: now });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(done.body.accessToken);
  assert.equal(done.body.user._id, member.userId);
  assert.equal((await get('/api/auth/2fa/status', done.body.accessToken)).status, 200);

  // The challenge token is single-use.
  assert.equal((await post('/api/auth/2fa/challenge', { challengeToken: first.body.challengeToken, code: code(secret, 1) })).body.code, 'TWO_FACTOR_CHALLENGE_INVALID');

  // The same code on a new sign-in is a replay.
  const second = await login(member.email);
  const replay = await post('/api/auth/2fa/challenge', { challengeToken: second.body.challengeToken, code: now });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.code, 'TWO_FACTOR_INVALID_CODE');
  assert.ok(await SecurityAuditEvent.exists({ actorUserId: member.userId, action: 'auth.two_factor.challenge_failed' }));
});

test('a recovery code signs in once', async () => {
  await freshStep();
  const member = await createMember('recovery');
  const { recoveryCodes } = await enrolSignedIn(member.email);
  const a = await login(member.email);
  const used = await post('/api/auth/2fa/challenge', { challengeToken: a.body.challengeToken, recoveryCode: recoveryCodes[3] });
  assert.equal(used.status, 200);
  assert.equal(used.body.recoveryCodesRemaining, 9);
  const b = await login(member.email);
  const again = await post('/api/auth/2fa/challenge', { challengeToken: b.body.challengeToken, recoveryCode: recoveryCodes[3] });
  assert.equal(again.status, 401);
});

test('guessing is stopped by the shared rate limiter', async () => {
  await freshStep();
  const member = await createMember('brute');
  await enrolSignedIn(member.email);
  const challenge = await login(member.email);
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) {
    statuses.push((await post('/api/auth/2fa/challenge', { challengeToken: challenge.body.challengeToken, code: String(100000 + i) })).status);
  }
  // Five wrong codes, then the challenge is spent, then the limiter answers.
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(statuses[10], 429);
});

test('disable requires the password and a current code, and is audited', async () => {
  await freshStep();
  const member = await createMember('disable');
  const { secret, accessToken } = await enrolSignedIn(member.email);
  const wrongPassword = await post('/api/auth/2fa/disable', { password: 'nope', code: code(secret, 0) }, accessToken);
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.body.code, 'REAUTHENTICATION_FAILED');
  const noCode = await post('/api/auth/2fa/disable', { password: PASSWORD }, accessToken);
  assert.equal(noCode.status, 401);
  assert.equal(noCode.body.code, 'TWO_FACTOR_INVALID_CODE');
  const ok = await post('/api/auth/2fa/disable', { password: PASSWORD, code: code(secret, 0) }, accessToken);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await UserTwoFactor.countDocuments({ userId: member.userId }), 0);
  assert.equal(await SecurityAuditEvent.countDocuments({ actorUserId: member.userId, action: 'auth.two_factor.disabled' }), 1);
  const plain = await login(member.email);
  assert.ok(plain.body.accessToken);
});
