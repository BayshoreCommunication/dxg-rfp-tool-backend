// Per-row permissions on the two proposal lists (GET /api/v1/rfps for the dashboard home and
// GET /api/proposals for the Proposals page), through the real app against Mongo. The flags must
// be exactly what the mutation endpoints then enforce, so the last test uses every flag on every
// listed row and compares it with what the endpoint answers.
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
import RfpShare from '../modal/rfpShareModel';
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
const userIds: Record<string, mongoose.Types.ObjectId> = {};
const proposals: Record<string, string> = {};
const teamOf: Record<string, string | null> = {};

type Permissions = { canEdit: boolean; canDuplicate: boolean; canArchive: boolean };
const ALL: Permissions = { canEdit: true, canDuplicate: true, canArchive: true };
const NONE: Permissions = { canEdit: false, canDuplicate: false, canArchive: false };
const VIEW_SHARE: Permissions = { canEdit: false, canDuplicate: true, canArchive: false };
const EDIT_SHARE: Permissions = { canEdit: true, canDuplicate: true, canArchive: false };

// What each member lists, and what they may do to each row. Written out, not derived.
const expected: Record<string, Record<string, Permissions>> = {
  owner: { team: ALL, other: ALL, own: ALL },
  admin: { team: ALL, other: ALL, own: ALL },
  manager: { team: ALL },
  plannerOne: { own: ALL },
  plannerTwo: { team: ALL, other: ALL },
  viewShare: { team: VIEW_SHARE },
  editShare: { team: EDIT_SHARE },
  viewer: { team: NONE },
  foreigner: { foreign: ALL },
};

const member = async (organizationId: mongoose.Types.ObjectId, key: string, roles: string[]) => {
  const user = await User.create({ name: key, email: `${key}-${randomMongoId().slice(0, 10)}@example.test`, password: 'not-a-real-hash', role: 'customer', organizationId });
  const membership = await OrganizationMembership.create({ organizationId, userId: user._id, roles, status: 'active' });
  const session = await authenticationSessions.begin({
    account: { userId: String(user._id), accountType: 'planner', email: user.email, organizationId: String(organizationId), role: 'customer', roles, rolesVersion: membership.version },
    correlationId: randomMongoId(),
  });
  tokens[key] = session.accessToken;
  userIds[key] = user._id as mongoose.Types.ObjectId;
};
const proposal = async (key: string, organizationId: mongoose.Types.ObjectId, owner: string, teamId: mongoose.Types.ObjectId | null) => {
  const created = await Proposal.create({ organizationId, userId: userIds[owner], event: { eventName: `Row ${key}` } });
  if (teamId) await Proposal.collection.updateOne({ _id: created._id }, { $set: { teamId } });
  proposals[key] = String(created._id);
  teamOf[key] = teamId ? String(teamId) : null;
};
const call = async (who: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};
const keyOf = (id: string) => Object.keys(proposals).find((key) => proposals[key] === id) ?? `unknown ${id}`;

// Both lists as { proposal key: permissions }.
const dashboardRows = async (who: string): Promise<Record<string, Permissions>> => {
  const res = await call(who, 'GET', '/api/v1/rfps?limit=100');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return Object.fromEntries((res.body.data.items as Array<{ id: string; permissions: Permissions }>).map((item) => [keyOf(item.id), item.permissions]));
};
const proposalListRows = async (who: string, query = ''): Promise<Record<string, Permissions>> => {
  const res = await call(who, 'GET', `/api/proposals?limit=100${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return Object.fromEntries((res.body.data as Array<{ _id: string; permissions: Permissions }>).map((item) => [keyOf(String(item._id)), item.permissions]));
};

before(async () => {
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  await Promise.all([Team.init(), TeamMembership.init(), RfpShare.init()]);
  const orgA = (await Organization.create({ plan: 'full_access', name: 'Rows A', slug: `intg-rows-${randomMongoId().slice(0, 10)}` }))._id as mongoose.Types.ObjectId;
  const orgB = (await Organization.create({ plan: 'full_access', name: 'Rows B', slug: `intg-rows-${randomMongoId().slice(0, 10)}` }))._id as mongoose.Types.ObjectId;
  orgIds.push(orgA, orgB);

  await member(orgA, 'owner', ['owner']);
  await member(orgA, 'admin', ['organization_admin']);
  await member(orgA, 'manager', ['team_manager']);
  await member(orgA, 'plannerOne', ['planner']);
  await member(orgA, 'plannerTwo', ['planner']);
  await member(orgA, 'viewShare', ['planner']);
  await member(orgA, 'editShare', ['planner']);
  await member(orgA, 'viewer', ['viewer']);
  await member(orgB, 'foreigner', ['organization_admin']);

  const managedTeam = (await Team.create({ organizationId: orgA, name: 'Managed' }))._id as mongoose.Types.ObjectId;
  const otherTeam = (await Team.create({ organizationId: orgA, name: 'Other' }))._id as mongoose.Types.ObjectId;
  await TeamMembership.create({ organizationId: orgA, teamId: managedTeam, userId: userIds.manager, isManager: true });

  await proposal('team', orgA, 'plannerTwo', managedTeam);
  await proposal('other', orgA, 'plannerTwo', otherTeam);
  await proposal('own', orgA, 'plannerOne', null);
  await proposal('foreign', orgB, 'foreigner', null);
  const shared = new mongoose.Types.ObjectId(proposals.team);
  await RfpShare.create([
    { organizationId: orgA, proposalId: shared, userId: userIds.viewShare, permission: 'view', grantedBy: userIds.admin },
    { organizationId: orgA, proposalId: shared, userId: userIds.editShare, permission: 'edit', grantedBy: userIds.admin },
    { organizationId: orgA, proposalId: shared, userId: userIds.viewer, permission: 'view', grantedBy: userIds.admin },
  ]);

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

test('a team manager may edit a managed team\'s proposal; a view-only share may not', async () => {
  for (const rows of [await dashboardRows('manager'), await proposalListRows('manager')]) {
    assert.equal(rows.team.canEdit, true);
    assert.equal(rows.team.canArchive, true);
  }
  for (const rows of [await dashboardRows('viewShare'), await proposalListRows('viewShare')]) {
    assert.equal(rows.team.canEdit, false);
    assert.equal(rows.team.canArchive, false);
  }
  for (const rows of [await dashboardRows('editShare'), await proposalListRows('editShare')]) {
    assert.equal(rows.team.canEdit, true);
    assert.equal(rows.team.canArchive, false);
  }
});

test('both lists carry the same permissions on exactly the rows each member may see', async () => {
  for (const [who, rows] of Object.entries(expected)) {
    assert.deepEqual(await dashboardRows(who), rows, `GET /api/v1/rfps as ${who}`);
    assert.deepEqual(await proposalListRows(who), rows, `GET /api/proposals as ${who}`);
  }
});

test('no row of another organization appears, with or without permissions', async () => {
  for (const who of Object.keys(expected).filter((key) => key !== 'foreigner')) {
    for (const rows of [await dashboardRows(who), await proposalListRows(who)]) assert.equal('foreign' in rows, false, who);
  }
  for (const rows of [await dashboardRows('foreigner'), await proposalListRows('foreigner')]) assert.deepEqual(Object.keys(rows), ['foreign']);
});

test('the list items keep their other fields and gain nothing but permissions', async () => {
  const item = (await call('admin', 'GET', '/api/v1/rfps?limit=100')).body.data.items[0];
  assert.deepEqual(Object.keys(item).sort(), [
    'awardedAt', 'createdAt', 'eventEndDate', 'eventName', 'eventStartDate', 'id', 'isDraft', 'ownerName', 'ownerUserId',
    'permissions', 'reviewStartedAt', 'stage', 'status', 'teamId', 'teamName', 'updatedAt', 'vendorsInvited', 'vendorsResponded', 'venueCity',
  ]);
  const legacy = (await call('admin', 'GET', '/api/proposals?limit=100')).body.data[0];
  assert.deepEqual(Object.keys(legacy.permissions).sort(), ['canArchive', 'canDuplicate', 'canEdit']);
  // The owner, team and organization read to decide the flags are not added to this list.
  for (const field of ['userId', 'teamId', 'organizationId']) assert.equal(field in legacy, false, field);
});

test('every flag is what the mutation endpoint then answers', async () => {
  for (const [who, rows] of Object.entries(expected)) {
    const listed = await dashboardRows(who);
    for (const key of Object.keys(rows)) {
      const id = proposals[key];
      const permissions = listed[key];
      const admin = who === 'foreigner' ? 'foreigner' : 'admin';
      const label = `${who} on ${key}`;

      // Edit: resending the proposal's current team is the smallest valid edit.
      const edit = await call(who, 'PUT', `/api/proposals/${id}`, { teamId: teamOf[key] });
      assert.equal(edit.status, permissions.canEdit ? 200 : 403, `${label}: edit ${JSON.stringify(edit.body)}`);

      const copy = await call(who, 'POST', `/api/proposals/${id}/copy`, { eventName: `Copy by ${who}`, isDraft: true });
      assert.equal(copy.status, permissions.canDuplicate ? 201 : 403, `${label}: copy ${JSON.stringify(copy.body)}`);

      const archive = await call(who, 'DELETE', `/api/proposals/${id}`);
      assert.equal(archive.status, permissions.canArchive ? 200 : 403, `${label}: archive ${JSON.stringify(archive.body)}`);
      // Restore is the same permission. When the member couldn't archive, an Admin does it so
      // the restore is tried against an archived proposal.
      if (!permissions.canArchive) assert.equal((await call(admin, 'DELETE', `/api/proposals/${id}`)).status, 200, `${label}: admin archives`);
      // An archived proposal still lists (on the Archive tab) with the same permissions.
      assert.deepEqual((await proposalListRows(who, '&archived=true'))[key], permissions, `${label}: archived row`);
      const restore = await call(who, 'PATCH', `/api/proposals/${id}/restore`);
      assert.equal(restore.status, permissions.canArchive ? 200 : 403, `${label}: restore ${JSON.stringify(restore.body)}`);
      if (!permissions.canArchive) assert.equal((await call(admin, 'PATCH', `/api/proposals/${id}/restore`)).status, 200, `${label}: admin restores`);
    }
  }
});
