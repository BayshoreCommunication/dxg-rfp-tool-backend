// ORG-206: membership management through the real middleware, router and Mongo (replica set,
// so the deactivation transaction runs for real).
import { TEST_MONGODB_DB_NAME } from "./env";
import { connectMongo, disconnectMongo } from "./setup";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type http from "node:http";
import mongoose from "mongoose";
import { closePostgres } from "../config/postgres";
import OrganizationMembership from "../modal/organizationMembershipModel";
import Proposal from "../modal/proposalsModel";
import Team from "../modal/teamModel";
import TeamMembership from "../modal/teamMembershipModel";
import { auditEvents, cleanupOrganizations, createProposals, membershipOf, seedOrganization, startApp, stopApp, type Fixture } from "./memberFixtures";

let server: http.Server;
let call: ReturnType<typeof startApp>["call"];
let org: Fixture;

before(async () => {
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  ({ server, call } = startApp());
});

beforeEach(async () => {
  org = await seedOrganization();
});

after(async () => {
  stopApp(server);
  if (mongoose.connection.readyState === 1) await cleanupOrganizations();
  await disconnectMongo();
  await closePostgres();
});

test("Owners and Admins list members with role, teams, status and last login", async () => {
  const { status, body } = await call(org.members.organization_admin.accessToken, "GET", "/api/organization/members");
  assert.equal(status, 200);
  const members = body.data.members as Array<Record<string, unknown>>;
  assert.equal(members.length, 5);
  const planner = members.find((m) => m.userId === org.members.planner.userId)!;
  assert.equal(planner.role, "planner");
  assert.equal(planner.status, "active");
  assert.deepEqual(planner.teams, []);
  assert.equal(planner.email, org.members.planner.email);
  assert.equal(planner.version, 1);
  assert.ok("lastSignedInAt" in planner);

  assert.equal((await call(org.members.owner.accessToken, "GET", "/api/organization/members?role=viewer")).body.data.members.length, 1);
});

test("Planners, Team Managers and Viewers are refused with 403 by the API", async () => {
  for (const role of ["planner", "team_manager", "viewer"] as const) {
    const token = org.members[role].accessToken;
    assert.equal((await call(token, "GET", "/api/organization/members")).status, 403, role);
    assert.equal((await call(token, "PATCH", `/api/organization/members/${org.members.viewer.userId}/role`, { role: "planner", version: 1 })).status, 403, role);
    assert.equal((await call(token, "POST", `/api/organization/members/${org.members.viewer.userId}/deactivate`, { version: 1 })).status, 403, role);
  }
  assert.equal((await membershipOf(org.organizationId, org.members.viewer.userId))!.roles[0], "viewer");
});

test("a role change uses the membership version and a stale version is a 409", async () => {
  const path = `/api/organization/members/${org.members.planner.userId}/role`;
  const changed = await call(org.members.organization_admin.accessToken, "PATCH", path, { role: "team_manager", version: 1 });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.data.member.role, "team_manager");
  assert.equal(changed.body.data.member.version, 2);

  const stale = await call(org.members.organization_admin.accessToken, "PATCH", path, { role: "viewer", version: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "STALE_VERSION");
  assert.equal(stale.body.currentVersion, 2);

  const [event] = await auditEvents(org.organizationId, "organization.member.role_changed");
  assert.equal(event.decision, "allowed");
  assert.equal(String(event.actorUserId), org.members.organization_admin.userId);
  assert.equal(event.targetId, org.members.planner.userId);
  assert.deepEqual(event.metadata, { previousRole: "planner", role: "team_manager", version: 2 });
});

test("only the Owner touches the owner role", async () => {
  const admin = org.members.organization_admin.accessToken;
  const demoteOwner = await call(admin, "PATCH", `/api/organization/members/${org.members.owner.userId}/role`, { role: "planner", version: 1 });
  assert.equal(demoteOwner.status, 403);
  assert.equal(demoteOwner.body.code, "OWNER_ONLY");
  const grantOwner = await call(admin, "PATCH", `/api/organization/members/${org.members.planner.userId}/role`, { role: "owner", version: 1 });
  assert.equal(grantOwner.status, 403);

  const selfDemote = await call(org.members.owner.accessToken, "PATCH", `/api/organization/members/${org.members.owner.userId}/role`, { role: "organization_admin", version: 1 });
  assert.equal(selfDemote.status, 409);
  assert.equal(selfDemote.body.code, "LAST_OWNER");
  const denied = await auditEvents(org.organizationId, "organization.member.role_changed");
  assert.deepEqual(denied.map((e) => [e.decision, e.reason]), [["denied", "owner_only"], ["denied", "owner_only"], ["denied", "last_owner"]]);
});

test("deactivating a member who owns RFPs is a 409 with the count", async () => {
  await createProposals(org.organizationId, org.members.planner.userId, 3);
  const refused = await call(org.members.owner.accessToken, "POST", `/api/organization/members/${org.members.planner.userId}/deactivate`, { version: 1 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "OWNER_HAS_RFPS");
  assert.equal(refused.body.ownedRfpCount, 3);
  const membership = await membershipOf(org.organizationId, org.members.planner.userId);
  assert.equal(membership!.status, "active");
  assert.equal(membership!.version, 1);
});

test("deactivation takes effect on the member's next request; reactivation is audited", async () => {
  const target = org.members.viewer;
  assert.equal((await call(target.accessToken, "GET", "/me")).status, 200);
  const deactivated = await call(org.members.organization_admin.accessToken, "POST", `/api/organization/members/${target.userId}/deactivate`, { version: 1 });
  assert.equal(deactivated.status, 200);
  assert.equal(deactivated.body.data.member.status, "deactivated");

  const refused = await call(target.accessToken, "GET", "/me");
  assert.equal(refused.status, 401);
  assert.equal(refused.body.code, "MEMBERSHIP_INACTIVE");

  const reactivated = await call(org.members.organization_admin.accessToken, "POST", `/api/organization/members/${target.userId}/reactivate`, { version: 2 });
  assert.equal(reactivated.status, 200);
  assert.equal(reactivated.body.data.member.status, "active");
  assert.equal((await auditEvents(org.organizationId, "organization.member.deactivated")).length, 1);
  assert.equal((await auditEvents(org.organizationId, "organization.member.reactivated")).length, 1);
});

test("the Owner can't be deactivated, by themselves or by an Admin", async () => {
  const self = await call(org.members.owner.accessToken, "POST", `/api/organization/members/${org.members.owner.userId}/deactivate`, { version: 1 });
  assert.equal(self.body.code, "LAST_OWNER");
  const byAdmin = await call(org.members.organization_admin.accessToken, "POST", `/api/organization/members/${org.members.owner.userId}/deactivate`, { version: 1 });
  assert.equal(byAdmin.body.code, "OWNER_ONLY");
  assert.equal((await membershipOf(org.organizationId, org.members.owner.userId))!.status, "active");
});

test("another organization's member is not found", async () => {
  const other = await seedOrganization("Other Org");
  const res = await call(org.members.owner.accessToken, "PATCH", `/api/organization/members/${other.members.planner.userId}/role`, { role: "viewer", version: 1 });
  assert.equal(res.status, 404);
  assert.equal((await membershipOf(other.organizationId, other.members.planner.userId))!.roles[0], "planner");
});

const activeOwners = async (organizationId: string) =>
  (await OrganizationMembership.find({ organizationId, status: "active", roles: "owner" }).lean()).map((m) => String(m.userId));

test("ownership transfer is atomic: exactly one active Owner before and after", async () => {
  assert.deepEqual(await activeOwners(org.organizationId), [org.members.owner.userId]);
  const res = await call(org.members.owner.accessToken, "POST", "/api/organization/ownership/transfer", { toUserId: org.members.planner.userId, version: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.owner.role, "owner");
  assert.equal(res.body.data.previousOwner.role, "organization_admin");
  assert.deepEqual(await activeOwners(org.organizationId), [org.members.planner.userId]);
  const [event] = await auditEvents(org.organizationId, "organization.ownership.transferred");
  assert.equal(event.decision, "allowed");
  assert.equal(event.targetId, org.members.planner.userId);
  assert.equal(String(event.actorUserId), org.members.owner.userId);
});

test("only the Owner can transfer, and only to an active member at the version they saw", async () => {
  const path = "/api/organization/ownership/transfer";
  const byAdmin = await call(org.members.organization_admin.accessToken, "POST", path, { toUserId: org.members.planner.userId, version: 1 });
  assert.equal(byAdmin.status, 403);
  const stale = await call(org.members.owner.accessToken, "POST", path, { toUserId: org.members.planner.userId, version: 7 });
  assert.equal(stale.body.code, "STALE_VERSION");
  await OrganizationMembership.updateOne({ organizationId: org.organizationId, userId: org.members.viewer.userId }, { $set: { status: "suspended" } });
  const inactive = await call(org.members.owner.accessToken, "POST", path, { toUserId: org.members.viewer.userId, version: 1 });
  assert.equal(inactive.body.code, "MEMBER_INACTIVE");
  assert.deepEqual(await activeOwners(org.organizationId), [org.members.owner.userId]);
  assert.equal((await auditEvents(org.organizationId, "organization.ownership.transferred")).every((e) => e.decision === "denied"), true);
});

test("concurrent transfers to two members leave exactly one Owner", async () => {
  const path = "/api/organization/ownership/transfer";
  const results = await Promise.all([
    call(org.members.owner.accessToken, "POST", path, { toUserId: org.members.planner.userId, version: 1 }),
    call(org.members.owner.accessToken, "POST", path, { toUserId: org.members.team_manager.userId, version: 1 }),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.body.code)));
  const owners = await activeOwners(org.organizationId);
  assert.equal(owners.length, 1);
  assert.notEqual(owners[0], org.members.owner.userId);
});

test("changing a member's teams uses real Teams: active teams of the organization only", async () => {
  const member = org.members.planner;
  const path = `/api/organization/members/${member.userId}/teams`;
  const [east, west, archived] = await Team.create([
    { organizationId: org.organizationId, name: "East" },
    { organizationId: org.organizationId, name: "West" },
    { organizationId: org.organizationId, name: "Old", archived: true, archivedAt: new Date() },
  ]);
  const other = await seedOrganization("Other Teams Org");
  const foreign = await Team.create({ organizationId: other.organizationId, name: "Foreign" });
  // A manager flag on a team the member stays on is kept.
  await TeamMembership.create({ organizationId: org.organizationId, teamId: east._id, userId: member.userId, isManager: true });
  await TeamMembership.create({ organizationId: org.organizationId, teamId: archived._id, userId: member.userId, isManager: false });

  const changed = await call(org.members.organization_admin.accessToken, "PUT", path, { teamIds: [String(east._id), String(west._id)], version: 1 });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(changed.body.data.member.teams.map((t: { name: string }) => t.name), ["East", "West"]);
  assert.equal(changed.body.data.member.version, 2);
  assert.equal((await TeamMembership.findOne({ teamId: east._id, userId: member.userId }).lean())?.isManager, true);
  assert.ok(await TeamMembership.exists({ teamId: archived._id, userId: member.userId }), "archived history is kept");
  const event = (await auditEvents(org.organizationId, "organization.member.teams_changed")).at(-1)!;
  assert.deepEqual(event.metadata, { previousTeamIds: [String(east._id)], teamIds: [String(east._id), String(west._id)], version: 2 });

  for (const teamId of [archived._id, foreign._id]) {
    const refused = await call(org.members.organization_admin.accessToken, "PUT", path, { teamIds: [String(teamId)], version: 2 });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "UNKNOWN_TEAMS");
    assert.deepEqual(refused.body.unknownTeamIds, [String(teamId)]);
  }
  assert.equal(await TeamMembership.exists({ teamId: foreign._id, userId: member.userId }), null);

  const cleared = await call(org.members.owner.accessToken, "PUT", path, { teamIds: [String(west._id)], version: 2 });
  assert.equal(cleared.status, 200);
  assert.equal(await TeamMembership.exists({ teamId: east._id, userId: member.userId }), null);
  const listed = await call(org.members.owner.accessToken, "GET", "/api/organization/members");
  assert.deepEqual(listed.body.data.members.find((m: { userId: string }) => m.userId === member.userId).teams, [{ id: String(west._id), name: "West" }]);
});

test("a member never ends up a Viewer who owns RFPs, even racing a reassignment", async () => {
  for (let round = 0; round < 4; round++) {
    const fresh = await seedOrganization(`Viewer Race ${round}`);
    const [from, to] = [fresh.members.planner, fresh.members.team_manager];
    await createProposals(fresh.organizationId, from.userId, 2);
    const [toViewer] = await Promise.all([
      call(fresh.members.organization_admin.accessToken, "PATCH", `/api/organization/members/${to.userId}/role`, { role: "viewer", version: 1 }),
      call(fresh.members.organization_admin.accessToken, "POST", `/api/organization/members/${from.userId}/reassign-rfps`, { toUserId: to.userId }),
    ]);
    const membership = await membershipOf(fresh.organizationId, to.userId);
    const owned = await Proposal.countDocuments({ organizationId: fresh.organizationId, userId: to.userId });
    assert.ok(!(membership!.roles.includes("viewer") && owned > 0), `round ${round}: viewer owns ${owned}`);
    if (toViewer.status !== 200) assert.equal(toViewer.body.code, "OWNER_HAS_RFPS");
  }
});
