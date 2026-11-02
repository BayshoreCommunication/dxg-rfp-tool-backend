// ORG-201/202/208: teams, team assignment and sharing, through the real app (routes, authenticate
// middleware and its actor lookups, controllers, repositories) against Mongo.
import { TEST_MONGODB_DB_NAME } from './env';
import { connectMongo, disconnectMongo, randomMongoId } from './setup';
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
import SecurityAuditEvent from '../modal/securityAuditEventModel';
import Team from '../modal/teamModel';
import TeamMembership from '../modal/teamMembershipModel';
import User from '../modal/userModel';
import RfpShare from '../modal/rfpShareModel';
import VendorResponse from '../modal/vendorResponseModel';
import { actorFor } from '../src/modules/identity/application/proposalAccess';
import { authenticationSessions } from '../src/modules/auth/composition';
import { closePostgres } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';

let server: http.Server;
let baseUrl: string;
const orgIds: mongoose.Types.ObjectId[] = [];
const tokens: Record<string, string> = {};
const userIds: Record<string, string> = {};

const member = async (organizationId: mongoose.Types.ObjectId, key: string, roles: string[]) => {
  const user = await User.create({ name: key, email: `${key}-${randomMongoId().slice(0, 10)}@example.com`, password: 'not-a-real-hash', role: 'customer', organizationId });
  const membership = await OrganizationMembership.create({ organizationId, userId: user._id, roles, status: 'active' });
  const session = await authenticationSessions.begin({
    account: { userId: String(user._id), accountType: 'planner', email: user.email, organizationId: String(organizationId), role: 'customer', roles, rolesVersion: membership.version },
    correlationId: randomMongoId(),
  });
  tokens[key] = session.accessToken;
  userIds[key] = String(user._id);
  return user._id;
};
const call = async (who: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};
const listedIds = async (who: string) =>
  ((await call(who, 'GET', '/api/proposals?limit=50')).body.data as Array<{ _id: string }>).map((p) => String(p._id)).sort();
const auditActions = async (organizationId: mongoose.Types.ObjectId, targetId: string) =>
  (await SecurityAuditEvent.find({ organizationId, targetId }).sort({ createdAt: 1, _id: 1 }).lean()).map((e) => e.action);

let orgA: mongoose.Types.ObjectId;
let orgB: mongoose.Types.ObjectId;

before(async () => {
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  await Promise.all([Team.init(), TeamMembership.init(), RfpShare.init()]);
  orgA = (await Organization.create({ name: 'Teams A', slug: `intg-teams-${randomMongoId().slice(0, 10)}` }))._id;
  orgB = (await Organization.create({ name: 'Teams B', slug: `intg-teams-${randomMongoId().slice(0, 10)}` }))._id;
  orgIds.push(orgA, orgB);
  await member(orgA, 'owner', ['owner']);
  await member(orgA, 'admin', ['organization_admin']);
  await member(orgA, 'manager', ['team_manager']);
  await member(orgA, 'planner', ['planner']);
  await member(orgA, 'colleague', ['planner']);
  await member(orgA, 'viewer', ['viewer']);
  await member(orgA, 'leaver', ['planner']);
  await member(orgB, 'foreignAdmin', ['organization_admin']);
  await member(orgB, 'foreigner', ['planner']);
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    await Promise.all([
      Proposal.deleteMany({ organizationId: { $in: orgIds } }),
      RfpShare.deleteMany({ organizationId: { $in: orgIds } }),
      VendorResponse.deleteMany({ organizationId: { $in: orgIds } }),
      Team.deleteMany({ organizationId: { $in: orgIds } }),
      TeamMembership.deleteMany({ organizationId: { $in: orgIds } }),
      OrganizationMembership.deleteMany({ organizationId: { $in: orgIds } }),
      RefreshSession.deleteMany({ organizationId: { $in: orgIds } }),
      User.deleteMany({ organizationId: { $in: orgIds } }),
      Organization.deleteMany({ _id: { $in: orgIds } }),
    ]);
  }
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
});

test('team administration is Owner/Admin only, audited, and scoped to the organization', async () => {
  for (const who of ['manager', 'planner', 'viewer']) {
    assert.equal((await call(who, 'POST', '/api/v1/teams', { name: `Nope ${who}` })).status, 403, who);
  }
  const created = await call('owner', 'POST', '/api/v1/teams', { name: 'Galas' });
  assert.equal(created.status, 201);
  const teamId = created.body.data.id as string;
  assert.equal((await call('admin', 'POST', '/api/v1/teams', { name: 'galas' })).status, 409);
  assert.equal((await call('admin', 'PATCH', `/api/v1/teams/${teamId}`, { name: 'Gala Dinners' })).body.data.name, 'Gala Dinners');
  assert.equal((await call('admin', 'POST', `/api/v1/teams/${teamId}/members`, { userId: userIds.planner })).status, 201);
  assert.equal((await call('admin', 'POST', `/api/v1/teams/${teamId}/members`, { userId: userIds.foreigner })).status, 404);
  assert.equal((await call('admin', 'POST', `/api/v1/teams/${teamId}/members`, { userId: userIds.planner })).status, 409);
  assert.equal((await call('admin', 'POST', `/api/v1/teams/${teamId}/members`, { userId: userIds.colleague, isManager: true })).status, 422);
  assert.equal((await call('admin', 'PATCH', `/api/v1/teams/${teamId}/members/${userIds.planner}`, { isManager: true })).status, 422);
  assert.equal((await call('admin', 'DELETE', `/api/v1/teams/${teamId}/members/${userIds.planner}`)).status, 200);

  // Another organization's admin can neither see nor change the team.
  assert.equal((await call('foreignAdmin', 'GET', `/api/v1/teams/${teamId}`)).status, 404);
  assert.equal((await call('foreignAdmin', 'PATCH', `/api/v1/teams/${teamId}`, { name: 'Taken' })).status, 404);
  assert.ok(!((await call('foreignAdmin', 'GET', '/api/v1/teams')).body.data as Array<{ id: string }>).some((t) => t.id === teamId));

  // Planners see active team names only.
  const plannerView = (await call('planner', 'GET', '/api/v1/teams')).body.data as Array<Record<string, unknown>>;
  assert.deepEqual(plannerView.find((t) => t.id === teamId), { id: teamId, name: 'Gala Dinners' });

  assert.deepEqual(await auditActions(orgA, teamId), ['team.created', 'team.renamed', 'team.member_added', 'team.member_removed']);
});

test('a team manager reaches the team\'s proposals until the team is archived; Admins and the Owner keep them', async () => {
  const teamId = (await call('admin', 'POST', '/api/v1/teams', { name: 'Conferences' })).body.data.id as string;
  assert.equal((await call('admin', 'POST', `/api/v1/teams/${teamId}/members`, { userId: userIds.manager, isManager: true })).status, 201);
  // Assigned directly here; ORG-202 covers assignment through the proposal routes.
  const proposal = await Proposal.create({ organizationId: orgA, userId: userIds.colleague, event: { eventName: 'Team RFP' } });
  await Proposal.collection.updateOne({ _id: proposal._id }, { $set: { teamId: new mongoose.Types.ObjectId(teamId) } });
  const id = String(proposal._id);

  assert.ok((await listedIds('manager')).includes(id));
  assert.equal((await call('manager', 'GET', `/api/proposals/${id}`)).status, 200);

  // Demoting the manager ends the scope on the next request.
  await call('admin', 'PATCH', `/api/v1/teams/${teamId}/members/${userIds.manager}`, { isManager: false });
  assert.equal((await call('manager', 'GET', `/api/proposals/${id}`)).status, 403);
  await call('admin', 'PATCH', `/api/v1/teams/${teamId}/members/${userIds.manager}`, { isManager: true });
  assert.equal((await call('manager', 'GET', `/api/proposals/${id}`)).status, 200);

  const archived = await call('admin', 'POST', `/api/v1/teams/${teamId}/archive`);
  assert.equal(archived.status, 200);
  assert.equal(archived.body.data.archived, true);
  assert.ok(!(await listedIds('manager')).includes(id));
  assert.equal((await call('manager', 'GET', `/api/proposals/${id}`)).status, 403);
  for (const who of ['admin', 'owner', 'colleague']) {
    assert.ok((await listedIds(who)).includes(id), who);
    assert.equal((await call(who, 'GET', `/api/proposals/${id}`)).status, 200, who);
  }
  assert.equal((await call('admin', 'PATCH', `/api/v1/teams/${teamId}`, { name: 'Revived' })).status, 409);
  const actions = await auditActions(orgA, teamId);
  assert.deepEqual(actions, ['team.created', 'team.member_added', 'team.manager_changed', 'team.manager_changed', 'team.archived']);
});

const createTeam = async (name: string, members: Array<[string, boolean]>) => {
  const teamId = (await call('admin', 'POST', '/api/v1/teams', { name })).body.data.id as string;
  for (const [who, isManager] of members) {
    assert.equal((await call('admin', 'POST', `/api/v1/teams/${teamId}/members`, { userId: userIds[who], isManager })).status, 201);
  }
  return teamId;
};
const createProposal = async (who: string, body: Record<string, unknown> = {}) => {
  const res = await call(who, 'POST', '/api/proposals', { event: { eventName: `RFP by ${who}` }, ...body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data as { _id: string; teamId: string | null };
};

test('ORG-202: a new proposal lands on the creator\'s only team and its manager sees it without a share', async () => {
  const teamId = await createTeam('Awards', [['manager', true], ['planner', false]]);
  const created = await createProposal('planner', { teamId: new mongoose.Types.ObjectId().toHexString() });
  assert.equal(String(created.teamId), teamId, 'the creator\'s team wins over a client-picked one');
  assert.ok((await listedIds('manager')).includes(String(created._id)));
  assert.equal((await call('manager', 'GET', `/api/proposals/${created._id}`)).status, 200);

  // On two teams there is no single default.
  await createTeam('Summits', [['planner', false]]);
  const unassigned = await createProposal('planner');
  assert.equal(unassigned.teamId, null);
  assert.equal((await call('manager', 'GET', `/api/proposals/${unassigned._id}`)).status, 403);

  // A manager of one team can't see another team's proposals.
  const otherTeam = await createTeam('Retreats', [['colleague', false]]);
  const other = await createProposal('colleague');
  assert.equal(String(other.teamId), otherTeam);
  assert.ok(!(await listedIds('manager')).includes(String(other._id)));
  assert.equal((await call('manager', 'GET', `/api/proposals/${other._id}`)).status, 403);
});

test('ORG-202: anyone allowed to edit can change the team; only active teams in the organization are accepted', async () => {
  const fromTeam = await createTeam('Launches', [['colleague', false]]);
  const toTeam = await createTeam('Roadshows', [['manager', true]]);
  const foreignTeam = (await call('foreignAdmin', 'POST', '/api/v1/teams', { name: 'Foreign team' })).body.data.id as string;
  const proposal = await createProposal('colleague');
  const put = (who: string, teamId: unknown) => call(who, 'PUT', `/api/proposals/${proposal._id}`, { teamId });
  assert.equal(String((await put('colleague', fromTeam)).body.data.teamId), fromTeam);

  assert.equal((await put('colleague', foreignTeam)).status, 422);
  assert.equal((await put('colleague', 'not-an-id')).status, 422);
  assert.equal((await put('planner', toTeam)).status, 403, 'not allowed to edit');
  assert.equal((await put('viewer', toTeam)).status, 403);

  const moved = await put('colleague', toTeam);
  assert.equal(moved.status, 200);
  assert.equal(String(moved.body.data.teamId), toTeam);
  assert.equal((await call('manager', 'GET', `/api/proposals/${proposal._id}`)).status, 200, 'the new team\'s manager now reaches it');

  // Archived: can't move a proposal onto it, but an edit resending the current team still saves.
  await call('admin', 'POST', `/api/v1/teams/${fromTeam}/archive`);
  assert.equal((await put('colleague', fromTeam)).status, 422);
  await call('admin', 'POST', `/api/v1/teams/${toTeam}/archive`);
  assert.equal((await put('colleague', toTeam)).status, 200);

  const cleared = await put('colleague', null);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.teamId, null);
});

const share = (who: string, proposalId: string, target: string, permission?: string) =>
  call(who, 'PUT', `/api/v1/proposals/${proposalId}/shares/${userIds[target]}`, permission ? { permission } : {});
const unshare = (who: string, proposalId: string, target: string) => call(who, 'DELETE', `/api/v1/proposals/${proposalId}/shares/${userIds[target]}`);

test('ORG-208: owner, team manager or Admin share within the organization; viewers get view only; audited', async () => {
  const teamId = await createTeam('Sharing team', [['manager', true]]);
  const proposal = await Proposal.create({ organizationId: orgA, userId: userIds.colleague, teamId, event: { eventName: 'Shared RFP' } });
  const id = String(proposal._id);

  assert.equal((await share('colleague', id, 'planner', 'view')).status, 200, 'owner');
  assert.equal((await share('manager', id, 'planner', 'edit')).status, 200, 'team manager');
  assert.equal((await share('admin', id, 'viewer', 'view')).status, 200, 'admin');
  assert.equal((await share('planner', id, 'owner', 'view')).status, 403, 'an edit share does not let you share');
  assert.equal((await share('viewer', id, 'planner', 'view')).status, 403);
  assert.equal((await share('admin', id, 'viewer', 'edit')).body.code, 'VIEWER_VIEW_ONLY');
  assert.equal((await share('admin', id, 'foreigner', 'view')).status, 404, 'other organizations are not members');
  assert.equal((await share('foreignAdmin', id, 'foreigner', 'view')).status, 404, 'another organization cannot see the proposal');
  assert.equal((await share('admin', id, 'planner', 'owner')).status, 400);

  const listed = await call('colleague', 'GET', `/api/v1/proposals/${id}/shares`);
  assert.deepEqual(
    (listed.body.data as Array<{ userId: string; permission: string; memberActive: boolean }>).map((s) => [s.userId, s.permission, s.memberActive]).sort(),
    [[userIds.planner, 'edit', true], [userIds.viewer, 'view', true]].sort(),
  );
  assert.equal((await call('planner', 'GET', `/api/v1/proposals/${id}/shares`)).status, 403);

  // An edit share lets a planner edit; a view share does not.
  assert.equal((await call('planner', 'PUT', `/api/proposals/${id}`, { event: { eventName: 'Edited through a share' } })).status, 200);
  assert.equal((await call('viewer', 'GET', `/api/proposals/${id}`)).status, 200);
  assert.ok((await listedIds('viewer')).includes(id));
  await share('admin', id, 'planner', 'view');
  assert.equal((await call('planner', 'PUT', `/api/proposals/${id}`, { event: { eventName: 'Refused' } })).status, 403);
  assert.equal((await call('planner', 'GET', `/api/proposals/${id}`)).status, 200);

  assert.equal((await unshare('manager', id, 'planner')).status, 200);
  assert.equal((await unshare('manager', id, 'planner')).status, 404);
  assert.equal((await call('planner', 'GET', `/api/proposals/${id}`)).status, 403);
  assert.ok(!(await listedIds('planner')).includes(id));

  const events = await SecurityAuditEvent.find({ organizationId: orgA, targetType: 'proposal', targetId: id }).sort({ createdAt: 1, _id: 1 }).lean();
  assert.deepEqual(events.map((e) => [e.action, (e.metadata as any).userId, (e.metadata as any).permission]), [
    ['proposal.share_granted', userIds.planner, 'view'],
    ['proposal.share_granted', userIds.planner, 'edit'],
    ['proposal.share_granted', userIds.viewer, 'view'],
    ['proposal.share_granted', userIds.planner, 'view'],
    ['proposal.share_revoked', userIds.planner, 'view'],
  ]);
});

test('ORG-208: a vendor-response read works through a share, and only through one', async () => {
  const proposal = await Proposal.create({ organizationId: orgA, userId: userIds.colleague, event: { eventName: 'Vendor RFP' } });
  const response = await VendorResponse.create({
    organizationId: orgA, proposalId: proposal._id, proposalOwnerId: userIds.colleague, proposalTitle: 'Vendor RFP',
    vendorName: 'Vendor', submittedBy: 'Avery', email: 'vendor@example.com', message: 'Quote', emailTrackingId: `share-${randomMongoId()}`,
  });
  const read = (who: string) => call(who, 'GET', `/api/vendor-responses/${response._id}`);
  const listedResponses = async (who: string) => ((await call(who, 'GET', '/api/vendor-responses?limit=100')).body.data as Array<{ _id: string }>).map((r) => String(r._id));

  for (const who of ['planner', 'viewer']) {
    assert.equal((await read(who)).status, 403, `${who} without a share`);
    assert.ok(!(await listedResponses(who)).includes(String(response._id)));
  }
  await share('colleague', String(proposal._id), 'planner', 'view');
  await share('colleague', String(proposal._id), 'viewer', 'view');
  for (const who of ['planner', 'viewer']) {
    assert.equal((await read(who)).status, 200, `${who} with a share`);
    assert.ok((await listedResponses(who)).includes(String(response._id)));
  }
  assert.equal((await call('viewer', 'DELETE', `/api/vendor-responses/${response._id}`)).status, 403, 'a view share does not allow deleting');
  await unshare('colleague', String(proposal._id), 'planner');
  assert.equal((await read('planner')).status, 403, 'revoked');
  assert.equal((await read('foreigner')).status, 404);
});

test('ORG-208: a deactivated member\'s share is kept but grants nothing', async () => {
  const proposal = await Proposal.create({ organizationId: orgA, userId: userIds.colleague, event: { eventName: 'Leaver RFP' } });
  const id = String(proposal._id);
  await share('colleague', id, 'leaver', 'edit');
  assert.equal((await call('leaver', 'GET', `/api/proposals/${id}`)).status, 200);

  await OrganizationMembership.updateOne({ organizationId: orgA, userId: userIds.leaver }, { $set: { status: 'suspended' } });
  assert.equal((await call('leaver', 'GET', `/api/proposals/${id}`)).status, 401);
  // Jobs rebuild the actor from the membership: the share is not there either.
  const jobActor = await actorFor({ organizationId: String(orgA), userId: userIds.leaver });
  assert.equal(jobActor.shares.size, 0);
  assert.equal(await RfpShare.countDocuments({ organizationId: orgA, proposalId: proposal._id, userId: userIds.leaver }), 1, 'kept for the record');
  const listed = (await call('colleague', 'GET', `/api/v1/proposals/${id}/shares`)).body.data as Array<{ userId: string; memberActive: boolean }>;
  assert.deepEqual(listed.map((s) => [s.userId, s.memberActive]), [[userIds.leaver, false]]);
  assert.equal((await share('colleague', id, 'leaver', 'view')).body.code, 'MEMBER_INACTIVE');
});
