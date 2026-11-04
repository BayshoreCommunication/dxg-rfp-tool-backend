// ORG-304: an organization's "require 2FA" setting routes non-enrolled members to enrolment
// (and signs them out when it's turned on), and an Admin's reset of a member's 2FA revokes the
// member's sessions and is audited. Drives the real app against the integration stack.
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
import { base32Decode, hotp, totpStep } from '../src/modules/twoFactor/domain/totp';
import { closePostgres } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';

let server: http.Server;
let baseUrl: string;
const tag = randomMongoId().slice(0, 10);
const PASSWORD = 'correct-horse-battery-staple';

type Res = { status: number; body: Record<string, any> };
const call = async (method: string, path: string, body?: unknown, token?: string): Promise<Res> => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};
type Member = { email: string; userId: string; organizationId: string; secret?: string; lastStep?: number };
// Each accepted code must be for a later TOTP step than the last (replay protection), and the server
// accepts one step either side of now. Use the oldest acceptable unused step; wait when all are spent.
const nextCode = async (m: Member): Promise<string> => {
  for (;;) {
    const current = totpStep(new Date());
    const step = Math.max(current - 1, (m.lastStep ?? -Infinity) + 1);
    if (step <= current + 1) {
      m.lastStep = step;
      return hotp(base32Decode(m.secret!), step);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
};
const members: Record<string, Member> = {};
const login = (m: Member) => call('POST', '/api/auth/login', { email: m.email, password: PASSWORD });

const createOrg = async (name: string) => String((await Organization.create({ name, slug: `intg-2fa-org-${name}-${tag}` }))._id);
const createMember = async (organizationId: string, who: string, role: string): Promise<Member> => {
  const user = await User.create({ name: who, email: `twofa-org-${who}-${tag}@example.com`, password: PASSWORD, role: 'customer', organizationId });
  await OrganizationMembership.create({ organizationId, userId: user._id, roles: [role], status: 'active' });
  return { email: user.email, userId: String(user._id), organizationId };
};
// Signs in with a password (and the current code if already enrolled).
const signIn = async (m: Member): Promise<string> => {
  const first = await login(m);
  if (first.body.accessToken) return first.body.accessToken;
  assert.equal(first.body.nextStep, 'two_factor_challenge', JSON.stringify(first.body));
  const done = await call('POST', '/api/auth/2fa/challenge', { challengeToken: first.body.challengeToken, code: await nextCode(m) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return done.body.accessToken;
};
const enrol = async (m: Member) => {
  const token = await signIn(m);
  const started = await call('POST', '/api/auth/2fa/enrol/start', {}, token);
  m.secret = started.body.secret;
  assert.equal((await call('POST', '/api/auth/2fa/enrol/confirm', { code: await nextCode(m) }, token)).status, 200);
};

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  await Promise.all([User.init(), Organization.init(), OrganizationMembership.init(), UserTwoFactor.init(), TwoFactorChallenge.init()]);
  const redis = new Redis(TEST_REDIS_URL);
  const keys = await redis.keys('rfpilot:rate:2fa-*');
  if (keys.length) await redis.del(...keys);
  await redis.quit();
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const org = await createOrg('main');
  const other = await createOrg('other');
  members.owner = await createMember(org, 'owner', 'owner');
  members.admin = await createMember(org, 'admin', 'organization_admin');
  members.planner = await createMember(org, 'planner', 'planner');
  members.outsider = await createMember(other, 'outsider', 'owner');
  await enrol(members.owner);
  await enrol(members.outsider);
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    const orgs = await Organization.find({ slug: new RegExp(`^intg-2fa-org-.*-${tag}$`) }).select('_id').lean();
    const ids = orgs.map((o) => o._id);
    await Promise.all([
      UserTwoFactor.deleteMany({ organizationId: { $in: ids } }),
      TwoFactorChallenge.deleteMany({ organizationId: { $in: ids } }),
      RefreshSession.deleteMany({ organizationId: { $in: ids } }),
      OrganizationMembership.deleteMany({ organizationId: { $in: ids } }),
      User.deleteMany({ organizationId: { $in: ids } }),
      Organization.deleteMany({ _id: { $in: ids } }),
    ]);
  }
  await closeSecurityRateLimitRedis();
  await disconnectMongo();
  await closePostgres();
});

test('only Owner and Admin manage the setting, and an Admin without 2FA cannot require it', async () => {
  const plannerToken = await signIn(members.planner);
  assert.equal((await call('GET', '/api/organization/security', undefined, plannerToken)).status, 403);
  assert.equal((await call('PUT', '/api/organization/security', { requireTwoFactor: true }, plannerToken)).status, 403);
  const adminToken = await signIn(members.admin);
  const refused = await call('PUT', '/api/organization/security', { requireTwoFactor: true }, adminToken);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'TWO_FACTOR_REQUIRED_FOR_ACTOR');
  assert.equal((await call('PUT', '/api/organization/security', { requireTwoFactor: 'yes' }, adminToken)).status, 400);
});

test('requiring 2FA signs out non-enrolled members, who can then only reach enrolment', async () => {
  const plannerToken = await signIn(members.planner);
  assert.equal((await call('GET', '/api/auth/2fa/status', undefined, plannerToken)).status, 200);

  const ownerToken = await signIn(members.owner);
  const on = await call('PUT', '/api/organization/security', { requireTwoFactor: true }, ownerToken);
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.requireTwoFactor, true);
  assert.ok(on.body.signedOutMembers >= 1);
  assert.ok(await SecurityAuditEvent.exists({ organizationId: members.owner.organizationId, actorUserId: members.owner.userId, action: 'organization.settings.updated' }));
  const settings = await call('GET', '/api/organization/security', undefined, ownerToken);
  assert.deepEqual([settings.body.requireTwoFactor, settings.body.membersWithoutTwoFactor], [true, 2]);
  // The enrolled owner keeps their session; the planner's is gone.
  assert.equal((await call('GET', '/api/auth/2fa/status', undefined, ownerToken)).status, 200);
  assert.notEqual((await call('GET', '/api/auth/2fa/status', undefined, plannerToken)).status, 200);

  // Sign-in now yields only an enrolment challenge: no tokens, and it isn't a verification challenge.
  const routed = await login(members.planner);
  assert.equal(routed.body.nextStep, 'two_factor_enrolment');
  assert.equal(routed.body.accessToken, undefined);
  assert.equal((await call('POST', '/api/auth/2fa/challenge', { challengeToken: routed.body.challengeToken, code: '123456' })).status, 401);
  assert.equal((await call('GET', '/api/proposals', undefined, routed.body.challengeToken)).status, 401);

  const started = await call('POST', '/api/auth/2fa/enrolment/start', { challengeToken: routed.body.challengeToken });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.ok(started.body.otpauthUri.startsWith('otpauth://totp/'));
  members.planner.secret = started.body.secret;
  const confirmed = await call('POST', '/api/auth/2fa/enrolment/confirm', { challengeToken: routed.body.challengeToken, code: await nextCode(members.planner) });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.ok(confirmed.body.accessToken);
  assert.equal(confirmed.body.recoveryCodes.length, 10);
  assert.equal((await call('GET', '/api/auth/2fa/status', undefined, confirmed.body.accessToken)).body.enabled, true);

  // While required, the member can't turn 2FA off.
  const disable = await call('POST', '/api/auth/2fa/disable', { password: PASSWORD, code: await nextCode(members.planner) }, confirmed.body.accessToken);
  assert.equal(disable.status, 403);
  assert.equal(disable.body.code, 'TWO_FACTOR_REQUIRED_BY_ORGANIZATION');

  assert.equal((await login(members.planner)).body.nextStep, 'two_factor_challenge');
});

test("an Admin reset revokes the member's sessions, is audited, and sends them back to enrolment", async () => {
  const plannerToken = await signIn(members.planner);
  const ownerToken = await signIn(members.owner);
  const before = await RefreshSession.countDocuments({ userId: members.planner.userId, status: 'active' });
  assert.ok(before >= 1);

  const reset = await call('POST', `/api/organization/members/${members.planner.userId}/two-factor/reset`, {}, ownerToken);
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.body.wasEnrolled, true);
  assert.equal(reset.body.revokedSessions, before);
  assert.equal(await RefreshSession.countDocuments({ userId: members.planner.userId, status: 'active' }), 0);
  assert.notEqual((await call('GET', '/api/auth/2fa/status', undefined, plannerToken)).status, 200);
  assert.equal(await UserTwoFactor.countDocuments({ userId: members.planner.userId }), 0);
  const audit = await SecurityAuditEvent.findOne({ action: 'auth.two_factor.reset', targetId: members.planner.userId }).lean();
  assert.equal(String(audit?.actorUserId), members.owner.userId);
  assert.equal(String(audit?.organizationId), members.owner.organizationId);

  assert.equal((await login(members.planner)).body.nextStep, 'two_factor_enrolment');
});

test('reset is limited to members of the organization, never yourself, and the Owner only by the Owner', async () => {
  // Turn the requirement off so the admin can sign in without enrolling first.
  const ownerToken = await signIn(members.owner);
  assert.equal((await call('PUT', '/api/organization/security', { requireTwoFactor: false }, ownerToken)).status, 200);
  const adminToken = await signIn(members.admin);

  const onOwner = await call('POST', `/api/organization/members/${members.owner.userId}/two-factor/reset`, {}, adminToken);
  assert.equal(onOwner.status, 403);
  const onOutsider = await call('POST', `/api/organization/members/${members.outsider.userId}/two-factor/reset`, {}, adminToken);
  assert.equal(onOutsider.status, 404);
  assert.equal(await UserTwoFactor.countDocuments({ userId: members.outsider.userId }), 1);
  assert.equal((await call('POST', `/api/organization/members/not-an-id/two-factor/reset`, {}, adminToken)).status, 404);
  assert.equal((await call('POST', `/api/organization/members/${members.owner.userId}/two-factor/reset`, {}, ownerToken)).status, 400);
});
