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
  await Promise.all([Team.init(), TeamMembership.init()]);
  orgA = (await Organization.create({ name: 'Teams A', slug: `intg-teams-${randomMongoId().slice(0, 10)}` }))._id;
  orgB = (await Organization.create({ name: 'Teams B', slug: `intg-teams-${randomMongoId().slice(0, 10)}` }))._id;
  orgIds.push(orgA, orgB);
  await member(orgA, 'owner', ['owner']);
  await member(orgA, 'admin', ['organization_admin']);
  await member(orgA, 'manager', ['team_manager']);
  await member(orgA, 'planner', ['planner']);
  await member(orgA, 'colleague', ['planner']);
  await member(orgA, 'viewer', ['viewer']);
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
