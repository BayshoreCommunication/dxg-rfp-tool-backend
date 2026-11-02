// ORG-307: role change, deactivation and 2FA reset revoke the member's other refresh sessions;
// a role change applies on the next request with no sign-out; the acting session survives.
import { TEST_MONGODB_DB_NAME } from "./env";
import { connectMongo, disconnectMongo, randomMongoId } from "./setup";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type http from "node:http";
import mongoose from "mongoose";
import { closePostgres } from "../config/postgres";
import RefreshSession from "../modal/refreshSessionModel";
import { authenticationSessions, membershipSessions } from "../src/modules/auth/composition";
import { cleanupOrganizations, seedOrganization, signIn, startApp, stopApp, type Fixture, type Member } from "./memberFixtures";

let server: http.Server;
let call: ReturnType<typeof startApp>["call"];
let org: Fixture;

const sessionStatus = async (sessionId: string) => (await RefreshSession.findOne({ sessionId }).lean())?.status;
const secondSession = (member: Member) => signIn(org.organizationId, member.userId, member.email);
const canRefresh = async (refreshToken: string) =>
  (await authenticationSessions.rotate({ refreshToken, correlationId: randomMongoId() })).kind === "rotated";

before(async () => {
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  ({ server, call } = startApp());
});

beforeEach(async () => {
  org = await seedOrganization("Session Hardening Org");
});

after(async () => {
  stopApp(server);
  if (mongoose.connection.readyState === 1) await cleanupOrganizations();
  await disconnectMongo();
  await closePostgres();
});

test("a role change applies on the member's next request and revokes their other sessions", async () => {
  const member = org.members.planner;
  const other = await secondSession(member);
  const admin = org.members.organization_admin;

  const changed = await call(admin.accessToken, "PATCH", `/api/organization/members/${member.userId}/role`, { role: "team_manager", version: 1 });
  assert.equal(changed.status, 200);

  // Same access token, no sign-out, new role.
  const me = await call(member.accessToken, "GET", "/me");
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.roles, ["team_manager"]);

  assert.equal(await sessionStatus(member.sessionId), "active");
  assert.equal(await sessionStatus(other.sessionId), "revoked");
  assert.equal(await canRefresh(other.refreshToken), false);
  assert.notEqual((await call(other.accessToken, "GET", "/me")).status, 200);
  // The acting Admin's session is untouched.
  assert.equal(await sessionStatus(admin.sessionId), "active");
  assert.equal((await call(admin.accessToken, "GET", "/me")).status, 200);
  // The kept session still refreshes.
  assert.equal(await canRefresh(member.refreshToken), true);
});

test("deactivation revokes every session of the member at once", async () => {
  const member = org.members.viewer;
  const other = await secondSession(member);
  const res = await call(org.members.owner.accessToken, "POST", `/api/organization/members/${member.userId}/deactivate`, { version: 1 });
  assert.equal(res.status, 200);
  assert.equal(await sessionStatus(member.sessionId), "revoked");
  assert.equal(await sessionStatus(other.sessionId), "revoked");
  assert.equal(await sessionStatus(org.members.owner.sessionId), "active");
});

test("an ownership transfer keeps the former Owner's acting session and ends their others", async () => {
  const owner = org.members.owner;
  const ownerOther = await secondSession(owner);
  const res = await call(owner.accessToken, "POST", "/api/organization/ownership/transfer", { toUserId: org.members.organization_admin.userId, version: 1 });
  assert.equal(res.status, 200);
  assert.equal(await sessionStatus(owner.sessionId), "active");
  assert.equal(await sessionStatus(ownerOther.sessionId), "revoked");
  const me = await call(owner.accessToken, "GET", "/me");
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.roles, ["organization_admin"]);
});

test("a 2FA reset revokes the member's other sessions, keeping the acting one", async () => {
  const member = org.members.team_manager;
  const other = await secondSession(member);
  // Reset by an Admin: every session of the member ends.
  const byAdmin = await membershipSessions.afterTwoFactorReset({
    organizationId: org.organizationId, userId: member.userId, actorUserId: org.members.organization_admin.userId,
    actorSessionId: org.members.organization_admin.sessionId, correlationId: randomMongoId(),
  });
  assert.equal(byAdmin, 2);
  assert.equal(await sessionStatus(org.members.organization_admin.sessionId), "active");

  // Reset by the member themselves: their acting session survives.
  const planner = org.members.planner;
  const plannerOther = await secondSession(planner);
  await membershipSessions.afterTwoFactorReset({
    organizationId: org.organizationId, userId: planner.userId, actorUserId: planner.userId,
    actorSessionId: planner.sessionId, correlationId: randomMongoId(),
  });
  assert.equal(await sessionStatus(planner.sessionId), "active");
  assert.equal(await sessionStatus(plannerOther.sessionId), "revoked");
  assert.equal(await sessionStatus(other.sessionId), "revoked");
});
