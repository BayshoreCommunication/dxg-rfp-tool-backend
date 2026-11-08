// ORG-306: someone signing up with an email on an organization's verified domain is offered
// "Request access" instead of silently getting a separate organization. Owners and Admins approve
// (which sends an invitation) or deny; auto-approve sends the invitation at once. Creating a
// separate organization stays possible but must be chosen. Drives the real app.
import { TEST_MONGODB_DB_NAME } from './env';
import { connectMongo, disconnectMongo, ensureMigrated, ensureServices, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import mongoose from 'mongoose';
import app from '../server';
import AccessRequest from '../modal/accessRequestModel';
import Invitation from '../modal/invitationModel';
import Notification from '../modal/notificationModel';
import Organization from '../modal/organizationModel';
import Otp from '../modal/otpModel';
import User from '../modal/userModel';
import { closePostgres } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';
import { hmacOtpCodeHasher } from '../src/modules/auth/infrastructure/security/hmacOtpCodeHasher';
import { cleanupOrganizations, seedOrganization, type Fixture } from './memberFixtures';

let server: http.Server;
let baseUrl: string;
let org: Fixture;
let other: Fixture;
let proven: Fixture;
const tag = randomMongoId().slice(0, 8);
const memberDomain = `mem${tag}.example.org`;
const domain = `acc${tag}.example.org`;
const unverified = `unv${tag}.example.org`;
const emails: string[] = [];
const address = (local: string, at = domain) => {
  const email = `${local}-${randomMongoId().slice(0, 6)}@${at}`;
  emails.push(email);
  return email;
};

const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};
// What the signup code step leaves behind.
const verifiedSignupEmail = async (email: string) => {
  await Otp.create({ email, type: 'signup', codeHash: 'x'.repeat(64), verified: true, attempts: 0, maxAttempts: 5, expiresAt: new Date(Date.now() + 600_000) });
};
const admin = () => org.members.organization_admin.accessToken;

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  await Promise.all([AccessRequest.init(), Invitation.init(), Otp.init()]);
  org = await seedOrganization('Bayshore Test');
  other = await seedOrganization('Unverified Claim Org');
  proven = await seedOrganization('Email Proven Org');
  // No verified domain; one active member proved an address on memberDomain.
  await User.updateOne({ _id: proven.members.planner.userId }, { $set: { email: `planner-${tag}@${memberDomain}` } });
  await Organization.updateOne({ _id: org.organizationId }, { $set: { verifiedDomains: [domain] } });
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await Organization.updateOne({ _id: org.organizationId }, { $set: { autoApproveDomain: false } });
  await Organization.updateOne({ _id: proven.organizationId }, { $set: { autoApproveDomain: false, verifiedDomains: [] } });
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    const ids = [org.organizationId, other.organizationId, proven.organizationId];
    await Promise.all([
      AccessRequest.deleteMany({ organizationId: { $in: ids } }),
      Invitation.deleteMany({ organizationId: { $in: ids } }),
      Notification.deleteMany({ type: 'access_request', 'metadata.organizationId': { $in: ids } }),
      Otp.deleteMany({ email: { $in: emails } }),
    ]);
    const created = await User.find({ email: { $in: emails } }).select('organizationId').lean();
    await Organization.deleteMany({ _id: { $in: created.map((u) => u.organizationId) }, slug: { $not: /^intg-members-/ } });
    await User.deleteMany({ email: { $in: emails } });
    await cleanupOrganizations();
  }
  await closeSecurityRateLimitRedis();
  await closePostgres();
  await disconnectMongo();
});

test('the signup code step names the organization that verified the domain, and only that one', async () => {
  const codeFor = async (email: string) => {
    await Otp.create({ email, type: 'signup', codeHash: hmacOtpCodeHasher.hash('482913'), verified: false, attempts: 0, maxAttempts: 5, expiresAt: new Date(Date.now() + 600_000) });
    return call('POST', '/api/auth/verify-otp', { email, otp: '482913' });
  };
  const matched = await codeFor(address('laiba'));
  assert.equal(matched.status, 200, JSON.stringify(matched.body));
  assert.deepEqual(matched.body.organizationMatch, { name: 'Bayshore Test' });

  // An organization that only claimed (not verified) a domain is never revealed.
  await Organization.updateOne({ _id: other.organizationId }, { $set: { verifiedDomains: [] } });
  const unmatched = await codeFor(address('stranger', unverified));
  assert.equal(unmatched.body.organizationMatch, null);
  const publicProvider = await codeFor(`gmailer-${tag}@gmail.com`);
  emails.push(`gmailer-${tag}@gmail.com`);
  assert.equal(publicProvider.body.organizationMatch, null);
});

test('signup on a verified domain refuses to create an organization unless that is chosen', async () => {
  const email = address('blocked');
  await verifiedSignupEmail(email);
  const blocked = await call('POST', '/api/auth/register', { name: 'Blocked', email, password: 'long-enough-pass' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'ORGANIZATION_DOMAIN_MATCH');
  assert.equal(blocked.body.organizationName, 'Bayshore Test');
  assert.equal(await User.exists({ email }), null);
});

test('creating a separate organization is still possible when chosen', async () => {
  const email = address('separate');
  await verifiedSignupEmail(email);
  const created = await call('POST', '/api/auth/register', { name: 'Separate', email, password: 'long-enough-pass', separateOrganization: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const user = await User.findOne({ email }).lean();
  assert.notEqual(String(user?.organizationId), org.organizationId, 'their own organization, not the matched one');
});

test('a request needs the signup code, and lands with the Owners and Admins', async () => {
  const email = address('requester');
  const unverifiedCall = await call('POST', '/api/auth/access-requests', { email, name: 'Laiba Test' });
  assert.equal(unverifiedCall.status, 403);
  assert.equal(unverifiedCall.body.code, 'EMAIL_NOT_VERIFIED');

  await verifiedSignupEmail(email);
  const requested = await call('POST', '/api/auth/access-requests', { email, name: 'Laiba Test' });
  assert.equal(requested.status, 201, JSON.stringify(requested.body));
  assert.equal(requested.body.status, 'pending');
  assert.equal(requested.body.organizationName, 'Bayshore Test');
  assert.equal(await User.exists({ email }), null, 'no account until the invitation is accepted');
  assert.equal(await Otp.exists({ email, type: 'signup', verified: true }), null, 'the verified code is used up');

  const notified = await Notification.find({ type: 'access_request', 'metadata.organizationId': org.organizationId }).lean();
  const recipients = new Set(notified.map((n) => String(n.userId)));
  assert.ok(recipients.has(org.members.owner.userId));
  assert.ok(recipients.has(org.members.organization_admin.userId));
  assert.ok(!recipients.has(org.members.planner.userId), 'planners are not notified');

  // A repeat request is idempotent.
  await verifiedSignupEmail(email);
  const again = await call('POST', '/api/auth/access-requests', { email, name: 'Laiba Test' });
  assert.equal(again.body.status, 'pending');
  assert.equal(await AccessRequest.countDocuments({ organizationId: org.organizationId, email }), 1);
});

test('only Owners and Admins see and decide requests', async () => {
  assert.equal((await call('GET', '/api/v1/organization/access-requests', undefined, org.members.planner.accessToken)).status, 403);
  const listed = await call('GET', '/api/v1/organization/access-requests', undefined, admin());
  assert.equal(listed.status, 200);
  assert.ok(listed.body.data.length >= 1);
  // Another organization never sees them.
  const foreign = await call('GET', '/api/v1/organization/access-requests', undefined, other.members.owner.accessToken);
  assert.equal(foreign.body.data.length, 0);
});

test('approving sends an invitation with the chosen role; deciding twice is refused', async () => {
  const email = address('approve');
  await verifiedSignupEmail(email);
  await call('POST', '/api/auth/access-requests', { email, name: 'Approve Me' });
  const request = await AccessRequest.findOne({ email }).lean();
  const approved = await call('POST', `/api/v1/organization/access-requests/${request!._id}/approve`, { role: 'team_manager' }, admin());
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.data.status, 'approved');
  const invitation = await Invitation.findOne({ organizationId: org.organizationId, email }).lean();
  assert.equal(invitation?.role, 'team_manager');
  assert.equal(invitation?.status, 'pending');

  const again = await call('POST', `/api/v1/organization/access-requests/${request!._id}/deny`, {}, admin());
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'ACCESS_REQUEST_NOT_PENDING');
  // Not reachable from another organization.
  const foreign = await call('POST', `/api/v1/organization/access-requests/${request!._id}/approve`, {}, other.members.owner.accessToken);
  assert.equal(foreign.status, 404);
});

test('denying closes the request; the person can still create their own organization', async () => {
  const email = address('deny');
  await verifiedSignupEmail(email);
  await call('POST', '/api/auth/access-requests', { email, name: 'Deny Me' });
  const request = await AccessRequest.findOne({ email }).lean();
  const denied = await call('POST', `/api/v1/organization/access-requests/${request!._id}/deny`, {}, admin());
  assert.equal(denied.status, 200);
  assert.equal(denied.body.data.status, 'denied');
  assert.equal(await Invitation.exists({ organizationId: org.organizationId, email }), null);

  await verifiedSignupEmail(email);
  const created = await call('POST', '/api/auth/register', { name: 'Deny Me', email, password: 'long-enough-pass', separateOrganization: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
});

test('with auto-approve on, a request sends the invitation at once', async () => {
  assert.equal((await call('PUT', '/api/v1/organization/access-requests/settings', { autoApproveDomain: true }, org.members.planner.accessToken)).status, 403);
  const set = await call('PUT', '/api/v1/organization/access-requests/settings', { autoApproveDomain: true }, admin());
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.data, { autoApproveDomain: true, verifiedDomains: [domain] });

  const email = address('auto');
  await verifiedSignupEmail(email);
  const requested = await call('POST', '/api/auth/access-requests', { email, name: 'Auto Join' });
  assert.equal(requested.status, 201, JSON.stringify(requested.body));
  assert.equal(requested.body.status, 'invited');
  const invitation = await Invitation.findOne({ organizationId: org.organizationId, email }).lean();
  assert.equal(invitation?.role, 'planner');
  assert.equal(String(invitation?.invitedBy), org.members.owner.userId, 'sent in the Owner\'s name');
  const request = await AccessRequest.findOne({ email }).lean();
  assert.equal(request?.status, 'approved');
  assert.equal(request?.autoApproved, true);
});

test('a domain without a verified organization can\'t be used to file a request', async () => {
  const email = address('nomatch', unverified);
  await verifiedSignupEmail(email);
  const res = await call('POST', '/api/auth/access-requests', { email, name: 'No Match' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'NO_ORGANIZATION_MATCH');
});

// Before anyone verifies the domain by DNS, a colleague of an existing member is still asked first.
test('an organization with a member on the domain matches before the domain is verified', async () => {
  const email = address('colleague', memberDomain);
  await Otp.create({ email, type: 'signup', codeHash: hmacOtpCodeHasher.hash('551199'), verified: false, attempts: 0, maxAttempts: 5, expiresAt: new Date(Date.now() + 600_000) });
  const verified = await call('POST', '/api/auth/verify-otp', { email, otp: '551199' });
  assert.deepEqual(verified.body.organizationMatch, { name: 'Email Proven Org' });

  const blocked = await call('POST', '/api/auth/register', { name: 'Colleague', email, password: 'long-enough-pass' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.organizationName, 'Email Proven Org');

  // Auto-approve never applies without DNS proof, even if the flag were set.
  await Organization.updateOne({ _id: proven.organizationId }, { $set: { autoApproveDomain: true } });
  const requested = await call('POST', '/api/auth/access-requests', { email, name: 'Colleague' });
  assert.equal(requested.status, 201, JSON.stringify(requested.body));
  assert.equal(requested.body.status, 'pending');
  assert.equal(await Invitation.exists({ organizationId: proven.organizationId, email }), null);
  const listed = await call('GET', '/api/v1/organization/access-requests', undefined, proven.members.owner.accessToken);
  assert.ok(listed.body.data.some((r: { email: string }) => r.email === email));
});

test('a DNS-verified organization wins over one that only has members on the domain', async () => {
  const email = address('dnswins', memberDomain);
  await Organization.updateOne({ _id: org.organizationId }, { $set: { verifiedDomains: [domain, memberDomain] } });
  try {
    await verifiedSignupEmail(email);
    const blocked = await call('POST', '/api/auth/register', { name: 'Dns Wins', email, password: 'long-enough-pass' });
    assert.equal(blocked.body.organizationName, 'Bayshore Test');
  } finally {
    await Organization.updateOne({ _id: org.organizationId }, { $set: { verifiedDomains: [domain] } });
  }
});

test('auto-approve can only be turned on with a verified domain', async () => {
  const refused = await call('PUT', '/api/v1/organization/access-requests/settings', { autoApproveDomain: true }, proven.members.owner.accessToken);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'NO_VERIFIED_DOMAIN');
  const off = await call('PUT', '/api/v1/organization/access-requests/settings', { autoApproveDomain: false }, proven.members.owner.accessToken);
  assert.equal(off.status, 200);
});

test('members on public or reserved example domains never make a match', async () => {
  // Every fixture member is on example.com; that must not turn example.com into a company.
  for (const at of ['example.com', 'gmail.com']) {
    const email = address('nobody', at);
    await verifiedSignupEmail(email);
    const res = await call('POST', '/api/auth/access-requests', { email, name: 'Nobody' });
    assert.equal(res.status, 409, `${at}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'NO_ORGANIZATION_MATCH', at);
  }
});
