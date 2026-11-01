// ORG-103: deactivating a member takes effect on their next request, not when the access token
// expires. Security audit events are append-only, so the rows this writes stay. Drives the real session manager and the real authenticate middleware against Mongo.
import { TEST_MONGODB_DB_NAME } from './env';
import { connectMongo, disconnectMongo, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import mongoose from 'mongoose';
import Organization from '../modal/organizationModel';
import OrganizationMembership from '../modal/organizationMembershipModel';
import RefreshSession from '../modal/refreshSessionModel';
import SecurityAuditEvent from '../modal/securityAuditEventModel';
import User from '../modal/userModel';
import { authenticate, AuthRequest } from '../middleware/auth';
import { authenticationSessions } from '../src/modules/auth/composition';
import { closePostgres } from '../config/postgres';

let server: http.Server;
let baseUrl: string;
let organizationId: string;
let userId: string;
let accessToken: string;
let refreshToken: string;

const me = (token = accessToken) =>
  fetch(`${baseUrl}/me`, { headers: { authorization: `Bearer ${token}` } }).then(async (res) => ({ status: res.status, body: (await res.json()) as Record<string, any> }));
const setStatus = (status: string) => OrganizationMembership.updateOne({ organizationId, userId }, { $set: { status } });
const revocationAudits = () =>
  SecurityAuditEvent.countDocuments({ organizationId, actorUserId: userId, action: 'auth.sessions.revoked_all', reason: 'membership_inactive' });

before(async () => {
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  const app = express();
  app.get('/me', authenticate, (req: AuthRequest, res) => {
    const actor = req.rfpActor!;
    res.json({ roles: actor.roles, membershipStatus: actor.membershipStatus, organizationId: String(actor.organizationId), managedTeamIds: actor.managedTeamIds, shares: actor.shares.size });
  });
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  const organization = await Organization.create({ name: 'Deactivation Org', slug: `intg-deact-${randomMongoId().slice(0, 10)}` });
  organizationId = String(organization._id);
  const user = await User.create({
    name: 'Leaving Planner',
    email: `leaving-${randomMongoId().slice(0, 12)}@example.test`,
    password: 'not-a-real-hash',
    role: 'customer',
    organizationId: organization._id,
    isBlocked: false,
  });
  userId = String(user._id);
  const membership = await OrganizationMembership.create({ organizationId, userId, roles: ['planner'], status: 'active' });
  const session = await authenticationSessions.begin({
    account: { userId, accountType: 'planner', email: user.email, organizationId, role: 'customer', roles: ['planner'], rolesVersion: membership.version },
    correlationId: randomMongoId(),
  });
  accessToken = session.accessToken;
  refreshToken = session.refreshToken;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    const orgs = await Organization.find({ slug: /^intg-deact-/ }).select('_id').lean();
    const ids = orgs.map((o) => o._id);
    await Promise.all([
      OrganizationMembership.deleteMany({ organizationId: { $in: ids } }),
      RefreshSession.deleteMany({ organizationId: { $in: ids } }),
      User.deleteMany({ organizationId: { $in: ids } }),
      Organization.deleteMany({ _id: { $in: ids } }),
    ]);
  }
  await disconnectMongo();
  await closePostgres();
});

test('an active member gets the access-policy actor resolved once per request', async () => {
  const { status, body } = await me();
  assert.equal(status, 200);
  assert.deepEqual(body, { roles: ['planner'], membershipStatus: 'active', organizationId, managedTeamIds: [], shares: 0 });
});

test('deactivation takes effect on the next request with the same unexpired token', async () => {
  assert.equal((await me()).status, 200);
  await setStatus('suspended');

  const refused = await me();
  assert.equal(refused.status, 401);
  assert.equal(refused.body.code, 'MEMBERSHIP_INACTIVE');

  const sessions = await RefreshSession.find({ organizationId, userId }).lean();
  assert.ok(sessions.length > 0);
  assert.ok(sessions.every((s) => s.status === 'revoked' && s.revokeReason === 'membership_inactive'));
  assert.equal(await revocationAudits(), 1);

  // The refresh token can no longer mint a new access token.
  const rotated = await authenticationSessions.rotate({ refreshToken, correlationId: randomMongoId() });
  assert.notEqual(rotated.kind, 'rotated');
});

test('repeat requests stay refused without writing another audit event', async () => {
  await setStatus('suspended');
  assert.equal((await me()).status, 401);
  assert.equal((await me()).status, 401);
  assert.equal(await revocationAudits(), 1);
});

test('removed and deleted memberships are refused the same way', async () => {
  await setStatus('removed');
  assert.equal((await me()).body.code, 'MEMBERSHIP_INACTIVE');

  await OrganizationMembership.deleteOne({ organizationId, userId });
  assert.equal((await me()).body.code, 'MEMBERSHIP_INACTIVE');
});

test('reactivating the member does not revive the revoked session', async () => {
  await setStatus('suspended');
  assert.equal((await me()).status, 401);
  await setStatus('active');
  const after = await me();
  assert.notEqual(after.status, 200, 'the member must sign in again');
});
