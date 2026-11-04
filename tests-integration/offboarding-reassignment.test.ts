// ORG-207: reassign all or selected RFPs from a leaving member, then deactivate them. ORG-109's
// orphan checker must find no RFP owned by an inactive member at any point.
import { TEST_MONGODB_DB_NAME } from "./env";
import { connectMongo, disconnectMongo } from "./setup";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type http from "node:http";
import mongoose from "mongoose";
import { closePostgres } from "../config/postgres";
import Proposal from "../modal/proposalsModel";
import { findOrphanedProposals } from "../src/modules/tenancy/migrationVerification";
import { auditEvents, cleanupOrganizations, createProposals, membershipOf, seedOrganization, startApp, stopApp, type Fixture } from "./memberFixtures";

let server: http.Server;
let call: ReturnType<typeof startApp>["call"];
let org: Fixture;

const ownerOf = async (ids: string[]) =>
  (await Proposal.collection.find({ _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } }).toArray()).map((p) => String(p.userId));
const orphansIn = async (organizationId: string) =>
  (await findOrphanedProposals()).byOrganization.find((o) => o.organizationId === organizationId)?.count ?? 0;

before(async () => {
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  ({ server, call } = startApp());
});

beforeEach(async () => {
  org = await seedOrganization("Offboarding Org");
});

after(async () => {
  stopApp(server);
  if (mongoose.connection.readyState === 1) await cleanupOrganizations();
  await disconnectMongo();
  await closePostgres();
});

test("reassign all, then deactivation goes through and no RFP is orphaned", async () => {
  const leaving = org.members.planner;
  const receiving = org.members.team_manager;
  const rfps = await createProposals(org.organizationId, leaving.userId, 3);
  const admin = org.members.organization_admin.accessToken;

  const blocked = await call(admin, "POST", `/api/organization/members/${leaving.userId}/deactivate`, { version: 1 });
  assert.equal(blocked.body.code, "OWNER_HAS_RFPS");
  assert.equal(blocked.body.ownedRfpCount, 3);

  const moved = await call(admin, "POST", `/api/organization/members/${leaving.userId}/reassign-rfps`, { toUserId: receiving.userId });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.data.reassignedCount, 3);
  assert.deepEqual(await ownerOf(rfps), [receiving.userId, receiving.userId, receiving.userId]);

  const audits = await auditEvents(org.organizationId, "proposal.owner.reassigned");
  assert.equal(audits.length, 3);
  assert.deepEqual(audits.map((e) => e.targetId).sort(), [...rfps].sort());
  assert.ok(audits.every((e) => e.targetType === "proposal" && e.decision === "allowed"));

  const deactivated = await call(admin, "POST", `/api/organization/members/${leaving.userId}/deactivate`, { version: 1 });
  assert.equal(deactivated.status, 200);
  assert.equal(await orphansIn(org.organizationId), 0);
});

test("reassign a selection; the rest stay with the member", async () => {
  const leaving = org.members.planner;
  const rfps = await createProposals(org.organizationId, leaving.userId, 3);
  const res = await call(org.members.owner.accessToken, "POST", `/api/organization/members/${leaving.userId}/reassign-rfps`, {
    toUserId: org.members.organization_admin.userId, rfpIds: [rfps[0], rfps[2]],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.reassignedCount, 2);
  assert.deepEqual(await ownerOf(rfps), [org.members.organization_admin.userId, leaving.userId, org.members.organization_admin.userId]);
  assert.equal((await auditEvents(org.organizationId, "proposal.owner.reassigned")).length, 2);
  const stillBlocked = await call(org.members.owner.accessToken, "POST", `/api/organization/members/${leaving.userId}/deactivate`, { version: 1 });
  assert.equal(stillBlocked.body.ownedRfpCount, 1);
});

test("RFPs can't go to a Viewer or an inactive member", async () => {
  const leaving = org.members.planner;
  const rfps = await createProposals(org.organizationId, leaving.userId, 2);
  const admin = org.members.organization_admin.accessToken;
  const toViewer = await call(admin, "POST", `/api/organization/members/${leaving.userId}/reassign-rfps`, { toUserId: org.members.viewer.userId });
  assert.equal(toViewer.status, 409);
  assert.equal(toViewer.body.code, "REASSIGN_TARGET_INELIGIBLE");

  await call(admin, "POST", `/api/organization/members/${org.members.team_manager.userId}/deactivate`, { version: 1 });
  const toInactive = await call(admin, "POST", `/api/organization/members/${leaving.userId}/reassign-rfps`, { toUserId: org.members.team_manager.userId });
  assert.equal(toInactive.body.code, "REASSIGN_TARGET_INELIGIBLE");
  assert.deepEqual(await ownerOf(rfps), [leaving.userId, leaving.userId]);
  assert.equal(await orphansIn(org.organizationId), 0);
});

test("a selection with another member's or another organization's RFP moves nothing", async () => {
  const leaving = org.members.planner;
  const [mine] = await createProposals(org.organizationId, leaving.userId, 1);
  const [colleagues] = await createProposals(org.organizationId, org.members.team_manager.userId, 1);
  const other = await seedOrganization("Other Offboarding Org");
  const [foreign] = await createProposals(other.organizationId, other.members.planner.userId, 1);

  for (const intruder of [colleagues, foreign]) {
    const res = await call(org.members.owner.accessToken, "POST", `/api/organization/members/${leaving.userId}/reassign-rfps`, {
      toUserId: org.members.organization_admin.userId, rfpIds: [mine, intruder],
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "RFPS_NOT_OWNED_BY_MEMBER");
  }
  assert.deepEqual(await ownerOf([mine, colleagues, foreign]), [leaving.userId, org.members.team_manager.userId, other.members.planner.userId]);
});

test("a deactivation and a reassignment to the same member never leave an orphan", async () => {
  const leaving = org.members.planner;
  const receiving = org.members.team_manager;
  await createProposals(org.organizationId, leaving.userId, 2);
  const admin = org.members.organization_admin.accessToken;
  await Promise.all([
    call(admin, "POST", `/api/organization/members/${leaving.userId}/reassign-rfps`, { toUserId: receiving.userId }),
    call(org.members.owner.accessToken, "POST", `/api/organization/members/${receiving.userId}/deactivate`, { version: 1 }),
  ]);
  assert.equal(await orphansIn(org.organizationId), 0);
  const receiver = await membershipOf(org.organizationId, receiving.userId);
  const owned = await Proposal.collection.countDocuments({ organizationId: new mongoose.Types.ObjectId(org.organizationId), userId: new mongoose.Types.ObjectId(receiving.userId) });
  assert.ok(receiver!.status === "active" || owned === 0, "a deactivated member must own nothing");
});

test("Planners can't reassign", async () => {
  const res = await call(org.members.planner.accessToken, "POST", `/api/organization/members/${org.members.planner.userId}/reassign-rfps`, { toUserId: org.members.team_manager.userId });
  assert.equal(res.status, 403);
});
