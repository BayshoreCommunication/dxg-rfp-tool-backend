import { TEST_MONGODB_URL, TEST_MONGODB_DB_NAME } from './env';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import mongoose from 'mongoose';
import Proposal from '../modal/proposalsModel';
import Team from '../modal/teamModel';
import TeamMembership from '../modal/teamMembershipModel';
import RfpShare from '../modal/rfpShareModel';
import { RFP_ACTIONS, RfpActor, canAccessRfp, rfpListScope } from '../src/modules/identity/domain/rfpAccessPolicy';
import { resolveRfpActor } from '../src/modules/identity/application/resolveRfpActor';
import { mongoActorLookups } from '../src/modules/identity/application/mongoActorLookups';

const { ObjectId } = mongoose.Types;
const organizationId = new ObjectId();
const foreignOrganizationId = new ObjectId();
const users = Array.from({ length: 5 }, () => new ObjectId());
const teams = Array.from({ length: 3 }, () => new ObjectId());

// Seeded PRNG so a failure reproduces.
let seed = 4242;
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(values: T[]) => values[Math.floor(random() * values.length)];

const proposals = Array.from({ length: 60 }, () => ({
  _id: new ObjectId(),
  organizationId: random() < 0.8 ? organizationId : foreignOrganizationId,
  userId: pick(users),
  // Raw insert: teamId isn't on the schema until ORG-2xx, the query must still honour it.
  ...(random() < 0.6 ? { teamId: pick(teams) } : {}),
}));

before(async () => {
  await mongoose.connect(TEST_MONGODB_URL, { dbName: TEST_MONGODB_DB_NAME, serverSelectionTimeoutMS: 5000 });
  assert.equal(mongoose.connection.name, 'rfpilot_test');
  await Proposal.collection.insertMany(proposals);
});
after(async () => {
  if (mongoose.connection.readyState === 1) {
    await Proposal.collection.deleteMany({ _id: { $in: proposals.map((p) => p._id) } });
    for (const model of [Team, TeamMembership, RfpShare] as const) {
      await (model as typeof Team).deleteMany({ organizationId: { $in: [organizationId, foreignOrganizationId] } });
    }
  }
  await mongoose.disconnect();
});

test('real Mongo list scope returns exactly the proposals the decision allows', async () => {
  const roles = ['owner', 'organization_admin', 'team_manager', 'planner', 'viewer'];
  const actors: RfpActor[] = [
    ...roles.map((role) => ({ organizationId, userId: users[0], roles: [role], membershipStatus: 'active', managedTeamIds: [teams[0]], shares: new Map() })),
    ...Array.from({ length: 40 }, (): RfpActor => ({
      organizationId: organizationId.toHexString(),
      userId: pick(users).toHexString(),
      roles: roles.filter(() => random() < 0.3),
      membershipStatus: random() < 0.9 ? 'active' : 'suspended',
      managedTeamIds: teams.filter(() => random() < 0.4).map(String),
      shares: new Map(proposals.filter(() => random() < 0.15).map((p) => [p._id.toHexString(), pick(['view', 'edit'] as const)])),
    })),
  ];
  const universe = { _id: { $in: proposals.map((p) => p._id) } };
  let compared = 0;
  for (const actor of actors) {
    for (const action of RFP_ACTIONS) {
      const listed = await Proposal.find({ $and: [universe, rfpListScope(actor, action)] }).select('_id').lean();
      const listedIds = listed.map((p) => String(p._id)).sort();
      const allowedIds = proposals
        .filter((p) => canAccessRfp(actor, { id: p._id, organizationId: p.organizationId, ownerUserId: p.userId, teamId: p.teamId ?? null }, action).allowed)
        .map((p) => String(p._id))
        .sort();
      assert.deepEqual(listedIds, allowedIds, `${action} for ${JSON.stringify(actor.roles)}`);
      compared++;
    }
  }
  assert.equal(compared, actors.length * RFP_ACTIONS.length);
});

test('another organization never appears in any scope', async () => {
  const admin: RfpActor = { organizationId, userId: users[0], roles: ['owner'], membershipStatus: 'active', managedTeamIds: teams, shares: new Map() };
  const listed = await Proposal.find(rfpListScope(admin)).select('organizationId').lean();
  assert.ok(listed.length > 0);
  assert.ok(listed.every((p) => String(p.organizationId) === String(organizationId)));
});

test('actors resolved from real team and share records: list scope and decision agree', async () => {
  // Teams 0 and 1 are active, team 2 is archived.
  await Team.collection.insertMany([
    { _id: teams[0], organizationId, name: 'Scope team 0', archived: false },
    { _id: teams[1], organizationId, name: 'Scope team 1', archived: false },
    { _id: teams[2], organizationId, name: 'Scope team 2', archived: true },
  ]);
  const roles = ['owner', 'organization_admin', 'team_manager', 'planner', 'viewer'];
  const memberships = users.map((userId) => ({ userId, roles: [pick(roles)], status: random() < 0.85 ? 'active' : 'suspended' }));
  await TeamMembership.collection.insertMany(
    users.flatMap((userId) => teams.filter(() => random() < 0.6).map((teamId) => ({ organizationId, teamId, userId, isManager: random() < 0.6 }))),
  );
  const shareRows = proposals.flatMap((p) => users.filter(() => random() < 0.2).map((userId) => ({
    organizationId: p.organizationId, proposalId: p._id, userId, permission: pick(['view', 'edit']), grantedBy: users[0],
  })));
  if (shareRows.length) await RfpShare.collection.insertMany(shareRows);

  const universe = { _id: { $in: proposals.map((p) => p._id) } };
  let compared = 0;
  for (const membership of memberships) {
    const actor = await resolveRfpActor({ organizationId: String(organizationId), userId: String(membership.userId), roles: membership.roles, status: membership.status }, mongoActorLookups);
    assert.ok(actor.managedTeamIds.every((id) => String(id) !== String(teams[2])), 'archived team never managed');
    assert.ok([...actor.shares.keys()].every((id) => proposals.find((p) => String(p._id) === id)?.organizationId === organizationId), 'only in-organization shares');
    if (membership.status !== 'active') assert.equal(actor.shares.size + actor.managedTeamIds.length, 0, 'inactive members carry nothing');
    for (const action of RFP_ACTIONS) {
      const listed = (await Proposal.find({ $and: [universe, rfpListScope(actor, action)] }).select('_id').lean()).map((p) => String(p._id)).sort();
      const allowed = proposals
        .filter((p) => canAccessRfp(actor, { id: p._id, organizationId: p.organizationId, ownerUserId: p.userId, teamId: p.teamId ?? null }, action).allowed)
        .map((p) => String(p._id))
        .sort();
      assert.deepEqual(listed, allowed, `${action} for ${JSON.stringify(membership)}`);
      compared++;
    }
  }
  assert.equal(compared, memberships.length * RFP_ACTIONS.length);
});
