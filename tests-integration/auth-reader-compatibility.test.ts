import { TEST_MONGODB_URL, TEST_MONGODB_DB_NAME } from './env';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { before, after, test } from 'node:test';
import mongoose from 'mongoose';
import RefreshSession from '../modal/refreshSessionModel';
import { createSessionManager, hashOpaqueToken } from '../src/modules/auth/application/manageSessions';
import { mongoRefreshSessionRepository as sessions } from '../src/modules/auth/infrastructure/mongo/mongoRefreshSessionRepository';

const userId = new mongoose.Types.ObjectId().toString();
const organizationId = new mongoose.Types.ObjectId().toString();
const manager = createSessionManager({sessions, accounts:{load:async () => null}, audit:{append:async () => undefined}, accessTokens:{issue:() => {throw new Error('Historical token must never issue access');}}});
before(async () => {
  await mongoose.connect(TEST_MONGODB_URL,{dbName:TEST_MONGODB_DB_NAME,serverSelectionTimeoutMS:5000});
  assert.equal(mongoose.connection.name,'rfpilot_test');
  await RefreshSession.init();
});
after(async () => {
  if (mongoose.connection.readyState === 1) await RefreshSession.deleteMany({userId});
  await mongoose.disconnect();
});
for (const operation of ['logout','replay'] as const) test(`compatibility reader handles ${operation} after a future in-place rotation`, async () => {
  const previous = crypto.randomBytes(32).toString('base64url');
  const current = crypto.randomBytes(32).toString('base64url');
  const familyId = crypto.randomUUID();
  await RefreshSession.create({userId,organizationId,sessionId:crypto.randomUUID(),familyId,tokenId:crypto.randomUUID(),tokenHash:hashOpaqueToken(current),consumedTokenHashes:[hashOpaqueToken(previous)],status:'active',expiresAt:new Date(Date.now()+60000),idleExpiresAt:new Date(Date.now()+60000),lastUsedAt:new Date()});
  if (operation === 'logout') assert.equal((await manager.revokePresented({refreshToken:previous,correlationId:'compatibility'})).kind,'revoked');
  else assert.equal((await manager.rotate({refreshToken:previous,correlationId:'compatibility'})).kind,'reuse_detected');
  assert.equal(await RefreshSession.countDocuments({familyId,status:'active'}),0);
});
