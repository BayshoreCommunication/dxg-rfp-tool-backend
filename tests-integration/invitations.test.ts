// ORG-203: invitations end to end through the real app, Mongo transactions and the real session
// manager. Email goes to the recording mailer (NODE_ENV=test), never to a provider.
import { TEST_MONGODB_DB_NAME } from './env';
import { connectMongo, disconnectMongo, ensureMigrated, ensureServices, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import mongoose from 'mongoose';
import express from 'express';
import app from '../server';
import Invitation from '../modal/invitationModel';
import InvitationEmailQuota from '../modal/invitationEmailQuotaModel';
import Team from '../modal/teamModel';
import TeamMembership from '../modal/teamMembershipModel';
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
import { mongoInvitationEmailQuota } from '../src/modules/invitations/infrastructure/mongoInvitationEmailQuota';
import { createInvitationModule } from '../src/modules/invitations/composition';
import { createInvitationController } from '../controller/invitationController';
import { createInvitationRouter } from '../routes/invitationRoute';
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
  await Promise.all([User.init(), Organization.init(), OrganizationMembership.init(), Invitation.init(), InvitationEmailQuota.init(), Team.init(), TeamMembership.init()]);
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
      InvitationEmailQuota.deleteMany({ organizationId: { $in: orgIds } }),
      Team.deleteMany({ organizationId: { $in: orgIds } }),
      TeamMembership.deleteMany({ organizationId: { $in: orgIds } }),
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
  const tooSoon = await request('POST', `/api/v1/organization/invitations/${created.body.invitation.id}/resend`, {}, ownerToken);
  assert.equal(tooSoon.status, 429);
  assert.equal(tooSoon.body.code, 'INVITATION_RESEND_COOLDOWN');
  assert.equal(lastLinkTo(to), first, 'nothing was sent');
  await Invitation.updateOne({ _id: created.body.invitation.id }, { $set: { emailQueuedAt: new Date(Date.now() - 6 * 60_000) } });
  const resent = await request('POST', `/api/v1/organization/invitations/${created.body.invitation.id}/resend`, {}, ownerToken);
  assert.equal(resent.status, 200, JSON.stringify(resent.body));
  const second = lastLinkTo(to);
  assert.notEqual(first, second);
  const old = await request('POST', '/api/v1/invitations/lookup', { token: first });
  assert.equal(old.status, 410);
  assert.equal(old.body.code, 'INVITATION_SUPERSEDED');
  assert.equal((await request('POST', '/api/v1/invitations/lookup', { token: second })).status, 200);
  const stamped = await Invitation.findById(created.body.invitation.id).lean();
  assert.ok(stamped!.emailQueuedAt && Date.now() - stamped!.emailQueuedAt.getTime() < 60_000, 'the cooldown restarts from the resend');
  assert.equal((await request('POST', `/api/v1/organization/invitations/${created.body.invitation.id}/resend`, {}, ownerToken)).status, 429);

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
  const [ownTeam, otherTeam] = await Team.create([
    { organizationId: owner.organizationId, name: 'Weddings' },
    { organizationId: owner.organizationId, name: 'Conferences' },
  ]);
  await TeamMembership.create({ organizationId: owner.organizationId, teamId: ownTeam._id, userId: manager._id, isManager: true });
  const managerToken = await signIn({ id: String(manager._id), organizationId: String(owner.organizationId) });

  const off = await invite({ email: email('m1'), role: 'planner', teamId: String(ownTeam._id) }, managerToken);
  assert.equal(off.status, 403);
  assert.equal(off.body.code, 'MANAGER_INVITES_DISABLED');

  await Organization.updateOne({ _id: owner.organizationId }, { $set: { allowManagerInvites: true } });
  // Managed team ids come from the real actor lookups (TeamMembership.isManager on an active team).
  const own = await invite({ email: email('m2'), role: 'planner', teamId: String(ownTeam._id) }, managerToken);
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.invitation.teamId, String(ownTeam._id));
  assert.equal(recordedInvitationEmails().at(-1)!.teamName, 'Weddings');
  const notTheirs = await invite({ email: email('m3'), role: 'planner', teamId: String(otherTeam._id) }, managerToken);
  assert.equal(notTheirs.status, 403);
  assert.equal(notTheirs.body.code, 'TEAM_NOT_MANAGED');
  const listed = await request('GET', '/api/v1/organization/invitations', undefined, managerToken);
  assert.deepEqual(listed.body.invitations.map((i: { id: string }) => i.id), [own.body.invitation.id]);

  // Archiving the team ends the manager's scope on their next request.
  await Team.updateOne({ _id: ownTeam._id }, { $set: { archived: true, archivedAt: new Date() } });
  const archived = await invite({ email: email('m4'), role: 'planner', teamId: String(ownTeam._id) }, managerToken);
  assert.equal(archived.status, 403);
  assert.equal(archived.body.code, 'TEAM_NOT_MANAGED');

  const plannerEmail = email('plain-planner');
  const planner = await User.create({ name: 'Plain Planner', email: plannerEmail, password: 'x'.repeat(20), organizationId: owner.organizationId });
  await OrganizationMembership.create({ organizationId: owner.organizationId, userId: planner._id, roles: ['planner'], status: 'active' });
  const plannerToken = await signIn({ id: String(planner._id), organizationId: String(owner.organizationId) });
  assert.equal((await invite({ email: email('p1'), role: 'planner' }, plannerToken)).status, 403);
  assert.equal((await request('GET', '/api/v1/organization/invitations', undefined, plannerToken)).status, 403);
});

test('an invitation names only an active team of the organization, and accept places the member in it', async () => {
  const rival = await signUpOwner(`teamrival-${randomMongoId().slice(0, 6)}`, 'Rival Co');
  const [team, archivedTeam] = await Team.create([
    { organizationId: owner.organizationId, name: 'Field Ops' },
    { organizationId: owner.organizationId, name: 'Old Team', archived: true, archivedAt: new Date() },
  ]);
  const foreignTeam = await Team.create({ organizationId: rival.organizationId, name: 'Rival Team' });
  for (const teamId of [archivedTeam._id, foreignTeam._id, randomMongoId()]) {
    const refused = await invite({ email: email(`noteam-${randomMongoId().slice(0, 4)}`), role: 'planner', teamId: String(teamId) });
    assert.equal(refused.status, 404, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'TEAM_NOT_FOUND');
  }

  const to = email('teamed');
  assert.equal((await invite({ email: to, role: 'planner', teamId: String(team._id) })).status, 201);
  const token = lastLinkTo(to);
  assert.equal((await request('POST', '/api/v1/invitations/lookup', { token })).body.invitation.teamName, 'Field Ops');
  const accepted = await request('POST', '/api/v1/invitations/accept/register', { token, name: 'Tia Teamed', password: PASSWORD });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const user = await User.findOne({ email: to }).lean();
  const placed = await TeamMembership.findOne({ teamId: team._id, userId: user!._id }).lean();
  assert.ok(placed, 'placed in the team');
  assert.equal(String(placed!.organizationId), String(owner.organizationId));
  assert.equal(placed!.isManager, false);

  // A team archived between invite and accept: the accept still succeeds, without the team.
  const late = email('late-team');
  const laterTeam = await Team.create({ organizationId: owner.organizationId, name: 'Short Lived' });
  const lateInvite = await invite({ email: late, role: 'viewer', teamId: String(laterTeam._id) });
  const lateToken = lastLinkTo(late);
  await Team.updateOne({ _id: laterTeam._id }, { $set: { archived: true, archivedAt: new Date() } });
  const lateAccepted = await request('POST', '/api/v1/invitations/accept/register', { token: lateToken, name: 'Lee Late', password: PASSWORD });
  assert.equal(lateAccepted.status, 200, JSON.stringify(lateAccepted.body));
  const lateUser = await User.findOne({ email: late }).lean();
  assert.equal(await TeamMembership.countDocuments({ userId: lateUser!._id }), 0);
  assert.equal((await OrganizationMembership.findOne({ userId: lateUser!._id }).lean())!.status, 'active');
  const audit = await SecurityAuditEvent.findOne({ targetId: lateInvite.body.invitation.id, action: 'organization.invitation.accepted' }).lean();
  assert.equal((audit!.metadata as Record<string, unknown>).placedInTeam, false);
});

test('re-inviting an email whose invitation lapsed before the sweep ran creates a new invitation', async () => {
  const to = email('lapsed');
  const first = await invite({ email: to, role: 'planner' });
  await Invitation.updateOne({ _id: first.body.invitation.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const again = await invite({ email: to, role: 'viewer' });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.notEqual(again.body.invitation.id, first.body.invitation.id);
  const old = await Invitation.findById(first.body.invitation.id).lean();
  assert.equal(old!.status, 'expired');
  assert.ok(old!.expiredAt);
  assert.equal((await invite({ email: to, role: 'viewer' })).body.code, 'ALREADY_INVITED');
});

test('sending is rate limited per inviting user', async () => {
  // Rows that are all invalid send nothing, so this measures requests only.
  let last = { status: 0, body: {} as Record<string, any> };
  for (let i = 0; i < 31; i++) {
    last = await request('POST', '/api/v1/organization/invitations/bulk', { emails: 'not-an-email', role: 'planner' }, ownerToken);
    if (i < 30) assert.equal(last.status, 200, `request ${i + 1}: ${JSON.stringify(last.body)}`);
  }
  assert.equal(last.status, 429);
});

test('the daily email allowance is all or nothing and holds under concurrent requests', async () => {
  const organizationId = String(owner.organizationId);
  const now = new Date();
  assert.deepEqual(await mongoInvitationEmailQuota.reserve({ organizationId, count: 11, limit: 10, now }), { ok: false, remaining: 10 });
  assert.deepEqual(await mongoInvitationEmailQuota.reserve({ organizationId, count: 7, limit: 10, now }), { ok: true });
  assert.deepEqual(await mongoInvitationEmailQuota.reserve({ organizationId, count: 4, limit: 10, now }), { ok: false, remaining: 3 });
  const results = await Promise.all(Array.from({ length: 6 }, () => mongoInvitationEmailQuota.reserve({ organizationId, count: 1, limit: 10, now })));
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal((await InvitationEmailQuota.findOne({ organizationId }).lean())!.count, 10);
  // Another organization, and the next day, start from zero; first-of-day inserts race safely.
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const firsts = await Promise.all(Array.from({ length: 4 }, () => mongoInvitationEmailQuota.reserve({ organizationId, count: 3, limit: 10, now: tomorrow })));
  assert.equal(firsts.filter((r) => r.ok).length, 3);
});

test('the daily cap answers 429 with what is left, and a bulk paste counts every recipient', async () => {
  const limited = createInvitationModule({ dailyEmailLimit: 3 });
  const limitedApp = express();
  limitedApp.use(express.json());
  limitedApp.use('/api/v1', createInvitationRouter(createInvitationController(limited.service)));
  const limitedServer = http.createServer(limitedApp).listen(0);
  try {
    const url = `http://127.0.0.1:${(limitedServer.address() as AddressInfo).port}/api/v1/organization/invitations/bulk`;
    const post = async (emailsToSend: string[]) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ emails: emailsToSend, role: 'planner' }),
      });
      return { status: res.status, retryAfter: res.headers.get('retry-after'), body: (await res.json()) as Record<string, any> };
    };
    const tooMany = await post([email('cap1'), email('cap2'), email('cap3'), email('cap4')]);
    assert.equal(tooMany.status, 429);
    assert.equal(tooMany.body.code, 'INVITATION_DAILY_LIMIT');
    assert.equal(tooMany.body.remaining, 3);
    assert.ok(Number(tooMany.retryAfter) > 0);
    assert.equal(await Invitation.countDocuments({ organizationId: owner.organizationId }), 0);
    assert.equal((await post([email('cap5'), email('cap6'), email('cap7')])).status, 200);
    const spent = await post([email('cap8')]);
    assert.equal(spent.status, 429);
    assert.equal(spent.body.remaining, 0);
  } finally {
    limitedServer.closeAllConnections();
    limitedServer.close();
  }
});

test('an account with no usable password accepts with Google, and only with the invited email', async () => {
  // Stands in for Google: "google:<email>" verifies as that email, anything else fails.
  const google = {
    async verify(idToken: string) {
      if (!idToken.startsWith('google:')) throw new Error('invalid');
      const verified = idToken.slice('google:'.length);
      return { subject: `sub-${verified}`, email: verified, name: 'Gia Google' };
    },
  };
  const module = createInvitationModule({ google });
  const googleApp = express();
  googleApp.use(express.json());
  googleApp.use('/api/v1', createInvitationRouter(createInvitationController(module.service)));
  const googleServer = http.createServer(googleApp).listen(0);
  const googleUrl = `http://127.0.0.1:${(googleServer.address() as AddressInfo).port}/api/v1/invitations/accept/google`;
  const acceptWithGoogle = async (body: Record<string, unknown>) => {
    const res = await fetch(googleUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': clientIp }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  try {
    // A Google-created account whose old membership was removed: its password is a random secret.
    const formerOwner = await signUpOwner(`google-${randomMongoId().slice(0, 6)}`, 'Old Co');
    await User.updateOne({ _id: formerOwner.id }, { $set: { googleId: 'google-subject' } });
    await OrganizationMembership.updateOne({ userId: formerOwner.id, organizationId: formerOwner.organizationId }, { $set: { status: 'removed', removedAt: new Date() } });
    await invite({ email: formerOwner.email, role: 'planner' });
    const token = lastLinkTo(formerOwner.email);

    const register = await request('POST', '/api/v1/invitations/accept/register', { token, name: 'Dup', password: PASSWORD });
    assert.equal(register.body.code, 'ACCOUNT_EXISTS');
    const wrongEmail = await acceptWithGoogle({ token, idToken: `google:${email('not-invited')}` });
    assert.equal(wrongEmail.status, 403);
    assert.equal(wrongEmail.body.code, 'INVITATION_EMAIL_MISMATCH');
    const forged = await acceptWithGoogle({ token, idToken: 'forged' });
    assert.equal(forged.status, 401);
    assert.equal(forged.body.code, 'INVALID_GOOGLE_IDENTITY');

    const accepted = await acceptWithGoogle({ token, idToken: `google:${formerOwner.email}` });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.role, 'planner');
    assert.ok(accepted.body.accessToken);
    const me = await request('GET', '/api/auth/me', undefined, accepted.body.accessToken);
    assert.equal(me.status, 200);
    assert.equal(String((await User.findById(formerOwner.id).lean())!.organizationId), String(owner.organizationId));

    // A new invitee signs up with Google: the account lands in the inviting organization only.
    const fresh = email('google-new');
    await invite({ email: fresh, role: 'viewer' });
    const created = await acceptWithGoogle({ token: lastLinkTo(fresh), idToken: `google:${fresh}` });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const freshUser = await User.findOne({ email: fresh }).lean();
    assert.equal(freshUser!.googleId, `sub-${fresh}`);
    assert.equal(freshUser!.name, 'Gia Google');
    assert.equal(String(freshUser!.organizationId), String(owner.organizationId));
    assert.equal(await OrganizationMembership.countDocuments({ userId: freshUser!._id }), 1, 'no organization of their own');
  } finally {
    googleServer.closeAllConnections();
    googleServer.close();
  }
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
