import { TEST_MONGODB_URL, TEST_MONGODB_DB_NAME } from './env';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import mongoose from 'mongoose';
import OrganizationMembership from '../modal/organizationMembershipModel';

const organizationId = new mongoose.Types.ObjectId();
const otherOrganizationId = new mongoose.Types.ObjectId();
const member = (orgId: mongoose.Types.ObjectId, roles: string[], status = 'active') =>
  OrganizationMembership.create({ organizationId: orgId, userId: new mongoose.Types.ObjectId(), roles, status });

before(async () => {
  await mongoose.connect(TEST_MONGODB_URL, { dbName: TEST_MONGODB_DB_NAME, serverSelectionTimeoutMS: 5000 });
  assert.equal(mongoose.connection.name, 'rfpilot_test');
  await OrganizationMembership.init();
});
after(async () => {
  if (mongoose.connection.readyState === 1) await OrganizationMembership.deleteMany({ organizationId: { $in: [organizationId, otherOrganizationId] } });
  await mongoose.disconnect();
});

test('an organization can have only one active owner', async () => {
  await member(organizationId, ['owner']);
  await assert.rejects(member(organizationId, ['owner', 'organization_admin']), { code: 11000 });
});

test('inactive owners and other organizations do not count against the limit', async () => {
  await member(organizationId, ['owner'], 'suspended');
  await member(organizationId, ['owner'], 'removed');
  await member(organizationId, ['organization_admin']);
  await member(otherOrganizationId, ['owner']);
  assert.equal(await OrganizationMembership.countDocuments({ organizationId, roles: 'owner', status: 'active' }), 1);
});
