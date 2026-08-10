// Reproduces the reported production failure end to end and proves it is fixed.
//
// A newly created account exists only in MongoDB. Every governed AI surface
// resolves its tenant through rfpilot.users in PostgreSQL, so before the
// sign-in projection existed the account authenticated fine and then got
// 503 ASSISTANT_ACTOR_NOT_READY from the assistant. This drives the real
// beginAuthenticatedSession against real MongoDB and PostgreSQL, then calls the
// real assistant repository to confirm the error is gone.
import { TEST_MONGODB_DB_NAME } from "./env";
import {
  connectMongo,
  disconnectMongo,
  ensureMigrated,
  ensureServices,
  randomMongoId,
} from "./setup";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { closePostgres, postgresPool } from "../config/postgres";
import Organization from "../modal/organizationModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import User from "../modal/userModel";
import { beginAuthenticatedSession } from "../src/modules/auth/composition";
import { postgresAssistantRepository } from "../src/modules/platformAssistant/postgresAssistantRepository";

let organizationMongoId: string;

/* Mirrors production: the tenant organization is already projected (that is why
   the live error was ASSISTANT_ACTOR_NOT_READY and not ORGANIZATION_NOT_READY),
   but nothing projects the users. */
const seedMongoTenant = async () => {
  const slug = `intg-${randomMongoId().slice(0, 10)}`;
  const organization = await Organization.create({
    name: "Integration Sign-in Org",
    slug,
    status: "active",
  });
  organizationMongoId = String(organization._id);
  await postgresPool().query(
    "INSERT INTO rfpilot.organizations(external_mongo_id,name) VALUES($1,$2) ON CONFLICT (external_mongo_id) DO NOTHING",
    [organizationMongoId, "Integration Sign-in Org"],
  );
};

const signUpInMongoOnly = async () => {
  const user = await User.create({
    name: "New Planner",
    email: `planner-${randomMongoId().slice(0, 12)}@example.test`,
    password: "not-a-real-hash",
    role: "customer",
    organizationId: new mongoose.Types.ObjectId(organizationMongoId),
    isBlocked: false,
  });
  await OrganizationMembership.create({
    organizationId: new mongoose.Types.ObjectId(organizationMongoId),
    userId: user._id,
    roles: ["planner"],
    status: "active",
    version: 1,
    activatedAt: new Date(),
  });
  return String(user._id);
};

const projectedUsers = async (userMongoId: string) => {
  const result = await postgresPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM rfpilot.users u
     JOIN rfpilot.organizations o ON o.id = u.organization_id
     WHERE o.external_mongo_id=$1 AND u.external_mongo_id=$2 AND u.status='active'`,
    [organizationMongoId, userMongoId],
  );
  return Number(result.rows[0].count);
};

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  // Every identifier below is freshly random, so this suite never needs to
  // clear the database out from under another test file.
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  await seedMongoTenant();
});

after(async () => {
  await disconnectMongo();
  await closePostgres();
});

test("signing in provisions the data foundation row that MongoDB signup does not create", async () => {
  const userMongoId = await signUpInMongoOnly();
  assert.equal(
    await projectedUsers(userMongoId),
    0,
    "precondition: a fresh signup has no PostgreSQL identity row",
  );

  const session = await beginAuthenticatedSession({
    userId: userMongoId,
    organizationId: organizationMongoId,
    correlationId: "integration-signin",
  });
  assert.ok(session.accessToken, "sign-in must still succeed");
  assert.equal(await projectedUsers(userMongoId), 1);
});

test("the assistant no longer answers ASSISTANT_ACTOR_NOT_READY after sign-in", async () => {
  const userMongoId = await signUpInMongoOnly();

  await assert.rejects(
    postgresAssistantRepository.listThreads({
      organizationMongoId,
      actorUserMongoId: userMongoId,
      correlationId: "integration-before",
      limit: 25,
    }),
    (error: Error & { code?: string }) => error.code === "ASSISTANT_ACTOR_NOT_READY",
    "precondition: this is the exact failure reported from production",
  );

  await beginAuthenticatedSession({
    userId: userMongoId,
    organizationId: organizationMongoId,
    correlationId: "integration-signin-2",
  });

  const threads = await postgresAssistantRepository.listThreads({
    organizationMongoId,
    actorUserMongoId: userMongoId,
    correlationId: "integration-after",
    limit: 25,
  });
  assert.deepEqual(threads, [], "the assistant must now answer for a brand-new account");
});

test("a blocked account cannot open a session, so nothing is projected for it", async () => {
  const userMongoId = await signUpInMongoOnly();
  await User.updateOne({ _id: userMongoId }, { $set: { isBlocked: true } });

  await assert.rejects(
    beginAuthenticatedSession({
      userId: userMongoId,
      organizationId: organizationMongoId,
      correlationId: "integration-blocked",
    }),
    /Active organization membership is required/,
  );
  assert.equal(await projectedUsers(userMongoId), 0);
});
