// ORG-106: every signup creates its own organization with the new user as Owner, in one Mongo
// transaction, and two customers who sign up separately can't see each other's proposals.
// Drives the real account repositories, the real sign-in (with the Postgres identity projection)
// and the real app against the integration stack.
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
import Proposal from '../modal/proposalsModel';
import RefreshSession from '../modal/refreshSessionModel';
import User from '../modal/userModel';
import { beginAuthenticatedSession } from '../src/modules/auth/composition';
import { mongoAuthAccountRepository } from '../src/modules/auth/infrastructure/mongo/mongoAuthAccountRepository';
import { mongoGoogleAccountRepository } from '../src/modules/auth/infrastructure/mongo/mongoGoogleAccountRepository';
import { closePostgres, postgresPool } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';

let server: http.Server;
let baseUrl: string;
const tag = randomMongoId().slice(0, 10);
const emails: string[] = [];
const email = (who: string) => { const value = `signup-${who}-${tag}@example.test`; emails.push(value); return value; };

const signUp = (who: string, company?: string) =>
  mongoAuthAccountRepository.createCustomer({ name: `Signup ${who}`, email: email(who), company, passwordHash: '$2b$12$not-a-real-hash-but-long-enough' } as any);
const signIn = async (user: { id: string; organizationId?: string }) =>
  (await beginAuthenticatedSession({ userId: user.id, organizationId: String(user.organizationId), correlationId: randomMongoId() })).accessToken;
const call = async (token: string, path: string) => {
  const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
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
    const users = await User.find({ email: { $in: emails } }).select('_id organizationId').lean();
    const orgIds = users.map((u) => u.organizationId).filter(Boolean);
    await Promise.all([
      Proposal.deleteMany({ organizationId: { $in: orgIds } }),
      OrganizationMembership.deleteMany({ organizationId: { $in: orgIds } }),
      RefreshSession.deleteMany({ organizationId: { $in: orgIds } }),
      User.deleteMany({ email: { $in: emails } }),
      Organization.deleteMany({ _id: { $in: orgIds } }),
    ]);
  }
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
});

test('a password signup creates a customer organization with the user as its only Owner', async () => {
  const user = await signUp('owner', 'Acme Events');
  const organization = await Organization.findById(user.organizationId).lean();
  assert.ok(organization);
  assert.equal(organization.name, 'Acme Events');
  assert.equal(organization.kind, 'customer');
  assert.equal(organization.plan, 'free_trial');
  assert.equal(organization.slug.startsWith('acme-events-'), true);
  const memberships = await OrganizationMembership.find({ organizationId: user.organizationId }).lean();
  assert.equal(memberships.length, 1);
  assert.deepEqual([...memberships[0].roles], ['owner']);
  assert.equal(memberships[0].status, 'active');
  assert.equal(String(memberships[0].userId), user.id);
});

test('a Google signup also gets an organization of its own', async () => {
  const user = await mongoGoogleAccountRepository.createGoogleAccount({
    identity: { subject: `google-${tag}`, email: email('google'), name: 'Gail Google', emailVerified: true } as any,
    fallbackPasswordHash: '$2b$12$not-a-real-hash-but-long-enough',
  });
  const organization = await Organization.findById(user.organizationId).lean();
  assert.equal(organization?.name, "Gail Google's organization");
  const membership = await OrganizationMembership.findOne({ organizationId: user.organizationId, userId: user.id }).lean();
  assert.deepEqual([...(membership?.roles ?? [])], ['owner']);
});

test('a failed signup leaves no organization behind', async () => {
  const taken = email('duplicate');
  await mongoAuthAccountRepository.createCustomer({ name: 'First', email: taken, passwordHash: '$2b$12$not-a-real-hash-but-long-enough' } as any);
  const before = await Organization.countDocuments({ name: 'Second Try Co' });
  await assert.rejects(
    mongoAuthAccountRepository.createCustomer({ name: 'Second', email: taken, company: 'Second Try Co', passwordHash: '$2b$12$not-a-real-hash-but-long-enough' } as any),
  );
  assert.equal(await Organization.countDocuments({ name: 'Second Try Co' }), before);
  assert.equal(await User.countDocuments({ email: taken }), 1);
});

test('two separate signups land in different organizations and cannot see each other\'s proposals', async () => {
  const ana = await signUp('ana');
  const ben = await signUp('ben');
  assert.notEqual(ana.organizationId, ben.organizationId);

  const anaProposal = await Proposal.create({ organizationId: ana.organizationId, userId: ana.id, event: { eventName: 'Ana summit' } });
  const benProposal = await Proposal.create({ organizationId: ben.organizationId, userId: ben.id, event: { eventName: 'Ben gala' } });
  const [anaToken, benToken] = [await signIn(ana), await signIn(ben)];

  const list = async (token: string) => ((await call(token, '/api/proposals?limit=50')).body.data as Array<{ _id: string }>).map((p) => String(p._id));
  assert.deepEqual(await list(anaToken), [String(anaProposal._id)]);
  assert.deepEqual(await list(benToken), [String(benProposal._id)]);
  assert.equal((await call(anaToken, `/api/proposals/${benProposal._id}`)).status, 404);
  assert.equal((await call(benToken, `/api/proposals/${anaProposal._id}`)).status, 404);
  assert.equal((await call(anaToken, `/api/proposals/${anaProposal._id}`)).status, 200);
});

test('first sign-in projects the new organization into Postgres so AI features are available', async () => {
  const user = await signUp('projected', 'Projected Org');
  await signIn(user);
  const { rows } = await postgresPool().query(
    "SELECT o.name, o.status FROM rfpilot.organizations o WHERE o.external_mongo_id = $1",
    [String(user.organizationId)],
  );
  assert.deepEqual(rows, [{ name: 'Projected Org', status: 'active' }]);
  const users = await postgresPool().query('SELECT status FROM rfpilot.users WHERE external_mongo_id = $1', [user.id]);
  assert.equal(users.rows[0]?.status, 'active');
});
