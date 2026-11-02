// ORG-203: invitations end to end through the real app, Mongo transactions and the real session
// manager. Email goes to the recording mailer (NODE_ENV=test), never to a provider.
import { TEST_MONGODB_DB_NAME } from './env';
import { connectMongo, disconnectMongo, ensureMigrated, ensureServices, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import mongoose from 'mongoose';
import app from '../server';
import Invitation from '../modal/invitationModel';
import Organization from '../modal/organizationModel';
import OrganizationMembership from '../modal/organizationMembershipModel';
import Proposal from '../modal/proposalsModel';
import RefreshSession from '../modal/refreshSessionModel';
import SecurityAuditEvent from '../modal/securityAuditEventModel';
import User from '../modal/userModel';
import { beginAuthenticatedSession } from '../src/modules/auth/composition';
import { mongoAuthAccountRepository } from '../src/modules/auth/infrastructure/mongo/mongoAuthAccountRepository';
import { bcryptPasswordHasher } from '../src/shared/security/bcryptPasswordHasher';
import { hashInvitationToken } from '../src/modules/invitations/domain/invitationRules';
import { clearRecordedInvitationEmails, recordedInvitationEmails } from '../src/modules/invitations/infrastructure/invitationMailer';
import { closePostgres } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';

let server: http.Server;
let baseUrl: string;
const tag = randomMongoId().slice(0, 10);
const emails: string[] = [];
const organizationIds: string[] = [];
const PASSWORD = 'Correct-horse-battery-1';
let passwordHash = '';
// The shared rate limiter keys public routes by IP; a fresh address per run keeps re-runs apart.
const clientIp = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

const email = (who: string) => { const value = `inv-${who}-${tag}@example.com`; emails.push(value); return value; };

const request = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': clientIp, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};

const signUpOwner = async (who: string, company: string) => {
  const user = await mongoAuthAccountRepository.createCustomer({ name: `Owner ${who}`, email: email(who), company, passwordHash } as any);
  organizationIds.push(String(user.organizationId));
  return user;
};
const signIn = async (user: { id: string; organizationId?: string }) =>
  (await beginAuthenticatedSession({ userId: user.id, organizationId: String(user.organizationId), correlationId: randomMongoId() })).accessToken;
const lastLinkTo = (to: string) => {
  const sent = recordedInvitationEmails().filter((entry) => entry.to === to).at(-1);
  assert.ok(sent, `no invitation email recorded for ${to}`);
  return sent.acceptUrl.split('/invite/')[1];
};

let owner: Awaited<ReturnType<typeof signUpOwner>>;
let ownerToken: string;

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  await Promise.all([User.init(), Organization.init(), OrganizationMembership.init(), Invitation.init()]);
  passwordHash = await bcryptPasswordHasher.hash(PASSWORD);
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  clearRecordedInvitationEmails();
  owner = await signUpOwner(`owner-${randomMongoId().slice(0, 6)}`, 'Acme Events');
  ownerToken = await signIn(owner);
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    const users = await User.find({ email: { $in: emails } }).select('_id organizationId').lean();
    const orgIds = [...new Set([...organizationIds, ...users.map((u) => String(u.organizationId))])];
    await Promise.all([
      Invitation.deleteMany({ organizationId: { $in: orgIds } }),
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

const invite = (body: Record<string, unknown>, token = ownerToken) => request('POST', '/api/v1/organization/invitations', body, token);

test('a new planner accepts by creating an account, lands in the inviting organization, and sees only their own proposals', async () => {
  const to = email('planner');
  const created = await invite({ email: to, role: 'planner' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.invitation.emailDelivery, 'sent');
  const token = lastLinkTo(to);
  assert.ok(recordedInvitationEmails().at(-1)!.acceptUrl.startsWith('http'), 'links point at the dashboard');

  const stored = await Invitation.findById(created.body.invitation.id).lean();
  assert.equal(stored!.tokenHash, hashInvitationToken(token));
  assert.ok(!JSON.stringify(stored).includes(token), 'the raw token is never stored');

  const lookup = await request('POST', '/api/v1/invitations/lookup', { token });
  assert.equal(lookup.status, 200);
  assert.deepEqual(
    { ...lookup.body.invitation, expiresAt: undefined },
    { email: to, role: 'planner', organizationName: 'Acme Events', inviterName: owner.name, teamName: null, accountExists: false, expiresAt: undefined },
  );

  // Role and organization in the request body are ignored: they come from the invitation.
  const accepted = await request('POST', '/api/v1/invitations/accept/register', {
    token, name: 'Pat Planner', password: PASSWORD, role: 'organization_admin', organizationId: randomMongoId(),
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.role, 'planner');
  assert.ok(accepted.body.accessToken);

  const user = await User.findOne({ email: to }).lean();
  assert.equal(String(user!.organizationId), String(owner.organizationId));
  const membership = await OrganizationMembership.findOne({ userId: user!._id }).lean();
  assert.deepEqual([...membership!.roles], ['planner']);
  assert.equal(membership!.status, 'active');
  assert.equal(String(membership!.organizationId), String(owner.organizationId));
  assert.equal(await Organization.countDocuments({ _id: user!.organizationId }), 1);
  assert.equal(await OrganizationMembership.countDocuments({ userId: user!._id }), 1, 'no organization of their own');
  assert.equal((await Invitation.findById(created.body.invitation.id).lean())!.status, 'accepted');

  const audits = await SecurityAuditEvent.find({ targetType: 'invitation', targetId: created.body.invitation.id }).sort({ createdAt: 1 }).lean();
  assert.deepEqual(audits.map((a) => [a.action, a.decision, String(a.actorUserId)]), [
    ['organization.invitation.sent', 'created', owner.id],
    ['organization.invitation.accepted', 'allowed', String(user!._id)],
  ]);

  const mine = await Proposal.create({ organizationId: owner.organizationId, userId: user!._id, event: { eventName: 'Planner summit' } });
  await Proposal.create({ organizationId: owner.organizationId, userId: owner.id, event: { eventName: 'Owner gala' } });
  const list = await request('GET', '/api/proposals?limit=50', undefined, accepted.body.accessToken);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map((p: { _id: string }) => String(p._id)), [String(mine._id)]);

  // The link was single use.
  const again = await request('POST', '/api/v1/invitations/accept/register', { token, name: 'Pat Again', password: PASSWORD });
  assert.equal(again.status, 410);
  assert.equal(again.body.code, 'INVITATION_ALREADY_USED');
  assert.equal((await request('POST', '/api/v1/invitations/lookup', { token })).body.code, 'INVITATION_ALREADY_USED');
});

test('two accepts of one link race and exactly one wins', async () => {
  const to = email('race');
  await invite({ email: to, role: 'viewer' });
  const token = lastLinkTo(to);
  const results = await Promise.all([
    request('POST', '/api/v1/invitations/accept/register', { token, name: 'Racer One', password: PASSWORD }),
    request('POST', '/api/v1/invitations/accept/register', { token, name: 'Racer Two', password: PASSWORD }),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.body)));
  assert.equal(await User.countDocuments({ email: to }), 1);
});

test('an email with an active membership in another organization, or in a holding tenant, cannot be invited', async () => {
  const other = await signUpOwner(`other-${randomMongoId().slice(0, 6)}`, 'Other Co');
  const refused = await invite({ email: other.email, role: 'planner' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'EMAIL_IN_ANOTHER_ORGANIZATION');
  assert.ok(!JSON.stringify(refused.body).includes('Other Co'), 'the other organization is never named');

  const holding = await Organization.create({ name: 'Holding', slug: `intg-hold-${randomMongoId().slice(0, 10)}`, kind: 'legacy_holding' });
  organizationIds.push(String(holding._id));
  const legacyEmail = email('legacy');
  const legacy = await User.create({ name: 'Legacy', email: legacyEmail, password: 'x'.repeat(20), organizationId: holding._id });
  await OrganizationMembership.create({ organizationId: holding._id, userId: legacy._id, roles: ['planner'], status: 'active' });
  const held = await invite({ email: legacyEmail, role: 'planner' });
  assert.equal(held.status, 409);
  assert.equal(held.body.code, 'LEGACY_ACCOUNT_PENDING_PLACEMENT');

  const member = await invite({ email: owner.email, role: 'planner' });
  assert.equal(member.body.code, 'ALREADY_MEMBER');
  assert.equal(await Invitation.countDocuments({ organizationId: owner.organizationId }), 0);
});

test('an existing account accepts by signing in with the invited email; a different email is refused', async () => {
  // Someone who left another organization: their old membership is removed.
  const former = await signUpOwner(`former-${randomMongoId().slice(0, 6)}`, 'Former Co');
  await OrganizationMembership.updateOne({ userId: former.id, organizationId: former.organizationId }, { $set: { status: 'removed', removedAt: new Date() } });
  const someoneElse = await signUpOwner(`else-${randomMongoId().slice(0, 6)}`, 'Else Co');

  const created = await invite({ email: former.email, role: 'viewer' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const token = lastLinkTo(former.email);
  assert.equal((await request('POST', '/api/v1/invitations/lookup', { token })).body.invitation.accountExists, true);

  const mismatch = await request('POST', '/api/v1/invitations/accept', { token, email: someoneElse.email, password: PASSWORD });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.body.code, 'INVITATION_EMAIL_MISMATCH');
  const wrong = await request('POST', '/api/v1/invitations/accept', { token, email: former.email, password: 'not-the-password' });
  assert.equal(wrong.status, 401);
  const exists = await request('POST', '/api/v1/invitations/accept/register', { token, name: 'Dup', password: PASSWORD });
  assert.equal(exists.body.code, 'ACCOUNT_EXISTS');

  const accepted = await request('POST', '/api/v1/invitations/accept', { token, email: former.email.toUpperCase(), password: PASSWORD });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.role, 'viewer');
  const user = await User.findById(former.id).lean();
  assert.equal(String(user!.organizationId), String(owner.organizationId));
  const me = await request('GET', '/api/auth/me', undefined, accepted.body.accessToken);
  assert.equal(me.status, 200);
  const membership = await OrganizationMembership.findOne({ userId: former.id, organizationId: owner.organizationId }).lean();
  assert.deepEqual([...membership!.roles], ['viewer']);
});

test('accept is refused when the account joined another organization after being invited', async () => {
  const to = email('late-joiner');
  await invite({ email: to, role: 'planner' });
  const token = lastLinkTo(to);
  const elsewhere = await signUpOwner(`elsewhere-${randomMongoId().slice(0, 6)}`, 'Elsewhere Co');
  // Point the invited email at an account that is active in Elsewhere Co.
  await User.updateOne({ _id: elsewhere.id }, { $set: { email: to } });
  const refused = await request('POST', '/api/v1/invitations/accept', { token, email: to, password: PASSWORD });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'EMAIL_IN_ANOTHER_ORGANIZATION');
  assert.equal((await Invitation.findOne({ organizationId: owner.organizationId, email: to }).lean())!.status, 'pending');
});

test('resend kills the old link; revoke and expiry each get their own refusal', async () => {
  const to = email('rotate');
  const created = await invite({ email: to, role: 'planner' });
  const first = lastLinkTo(to);
  const resent = await request('POST', `/api/v1/organization/invitations/${created.body.invitation.id}/resend`, {}, ownerToken);
  assert.equal(resent.status, 200, JSON.stringify(resent.body));
  const second = lastLinkTo(to);
  assert.notEqual(first, second);
  const old = await request('POST', '/api/v1/invitations/lookup', { token: first });
  assert.equal(old.status, 410);
  assert.equal(old.body.code, 'INVITATION_SUPERSEDED');
  assert.equal((await request('POST', '/api/v1/invitations/lookup', { token: second })).status, 200);

  const revoked = await request('POST', `/api/v1/organization/invitations/${created.body.invitation.id}/revoke`, {}, ownerToken);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.invitation.status, 'revoked');
  const afterRevoke = await request('POST', '/api/v1/invitations/accept/register', { token: second, name: 'Too Late', password: PASSWORD });
  assert.equal(afterRevoke.status, 410);
  assert.equal(afterRevoke.body.code, 'INVITATION_REVOKED');
  assert.equal(await User.countDocuments({ email: to }), 0);

  const expiring = email('expiring');
  const expiringInvite = await invite({ email: expiring, role: 'planner' });
  const expiringToken = lastLinkTo(expiring);
  await Invitation.updateOne({ _id: expiringInvite.body.invitation.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await request('POST', '/api/v1/invitations/accept/register', { token: expiringToken, name: 'Late', password: PASSWORD });
  assert.equal(expired.status, 410);
  assert.equal(expired.body.code, 'INVITATION_EXPIRED');

  const garbage = await request('POST', '/api/v1/invitations/lookup', { token: 'A'.repeat(43) });
  assert.equal(garbage.status, 404);
  assert.equal(garbage.body.code, 'INVITATION_INVALID');
  for (const body of [old.body, afterRevoke.body, expired.body, garbage.body]) {
    assert.deepEqual(Object.keys(body).sort(), ['code', 'message', 'success']);
    assert.ok(!body.message.includes('Acme') && !body.message.includes('@'));
  }
});

test('bulk paste of 200 entries reports per row and sends each new invitation once', async () => {
  const fresh = Array.from({ length: 180 }, (_, i) => email(`bulk${i}`));
  const entries = [
    ...fresh,
    ...fresh.slice(0, 12).map((e) => e.toUpperCase()),
    ...Array.from({ length: 7 }, (_, i) => `broken-${i}@`),
    owner.email,
  ];
  assert.equal(entries.length, 200);
  const res = await request('POST', '/api/v1/organization/invitations/bulk', { emails: entries.join('\n'), role: 'planner' }, ownerToken);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 500));
  assert.deepEqual(res.body.summary, { total: 200, invited: 180, refused: 20 });
  const codes = res.body.rows.filter((r: any) => r.outcome === 'refused').map((r: any) => r.code);
  assert.equal(codes.filter((c: string) => c === 'DUPLICATE_IN_LIST').length, 12);
  assert.equal(codes.filter((c: string) => c === 'INVALID_EMAIL').length, 7);
  assert.equal(res.body.rows[199].code, 'ALREADY_MEMBER');
  assert.equal(await Invitation.countDocuments({ organizationId: owner.organizationId, status: 'pending' }), 180);

  // Delivery runs after the response; wait for it to drain.
  for (let i = 0; i < 100 && await Invitation.countDocuments({ organizationId: owner.organizationId, 'delivery.state': { $ne: 'sent' } }) > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await Invitation.countDocuments({ organizationId: owner.organizationId, 'delivery.state': 'sent' }), 180);
  assert.equal(new Set(recordedInvitationEmails().map((e) => e.to)).size, 180);

  const listed = await request('GET', '/api/v1/organization/invitations?status=pending', undefined, ownerToken);
  assert.equal(listed.body.invitations.length, 180);
});

test('Team Managers need the organization setting and a team they manage; planners cannot invite', async () => {
  const managerEmail = email('manager');
  const manager = await User.create({ name: 'Mia Manager', email: managerEmail, password: 'x'.repeat(20), organizationId: owner.organizationId });
  await OrganizationMembership.create({ organizationId: owner.organizationId, userId: manager._id, roles: ['team_manager'], status: 'active' });
  const managerToken = await signIn({ id: String(manager._id), organizationId: String(owner.organizationId) });
  const teamId = randomMongoId();

  const off = await invite({ email: email('m1'), role: 'planner', teamId }, managerToken);
  assert.equal(off.status, 403);
  assert.equal(off.body.code, 'MANAGER_INVITES_DISABLED');

  await Organization.updateOne({ _id: owner.organizationId }, { $set: { allowManagerInvites: true } });
  // Until ORG-201 wires team lookups the manager manages no team, so every team is someone else's.
  const notTheirs = await invite({ email: email('m2'), role: 'planner', teamId }, managerToken);
  assert.equal(notTheirs.status, 403);
  assert.equal(notTheirs.body.code, 'TEAM_NOT_MANAGED');

  const plannerEmail = email('plain-planner');
  const planner = await User.create({ name: 'Plain Planner', email: plannerEmail, password: 'x'.repeat(20), organizationId: owner.organizationId });
  await OrganizationMembership.create({ organizationId: owner.organizationId, userId: planner._id, roles: ['planner'], status: 'active' });
  const plannerToken = await signIn({ id: String(planner._id), organizationId: String(owner.organizationId) });
  assert.equal((await invite({ email: email('p1'), role: 'planner' }, plannerToken)).status, 403);
  assert.equal((await request('GET', '/api/v1/organization/invitations', undefined, plannerToken)).status, 403);

  // An admin's team invitation stores the team for ORG-201 to place on accept.
  const withTeam = await invite({ email: email('teamed'), role: 'planner', teamId });
  assert.equal(withTeam.status, 201);
  assert.equal(withTeam.body.invitation.teamId, teamId);
});

test("one organization's admin cannot see, resend or revoke another's invitations", async () => {
  const to = email('private');
  const created = await invite({ email: to, role: 'planner' });
  const rival = await signUpOwner(`rival-${randomMongoId().slice(0, 6)}`, 'Rival Co');
  const rivalToken = await signIn(rival);
  assert.deepEqual((await request('GET', '/api/v1/organization/invitations', undefined, rivalToken)).body.invitations, []);
  assert.equal((await request('POST', `/api/v1/organization/invitations/${created.body.invitation.id}/resend`, {}, rivalToken)).status, 404);
  assert.equal((await request('POST', `/api/v1/organization/invitations/${created.body.invitation.id}/revoke`, {}, rivalToken)).status, 404);
  assert.equal((await Invitation.findById(created.body.invitation.id).lean())!.status, 'pending');
});
