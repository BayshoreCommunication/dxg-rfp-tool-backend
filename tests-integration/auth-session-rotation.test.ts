import { TEST_MONGODB_URL, TEST_MONGODB_DB_NAME } from './env';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { before, after, test } from 'node:test';
import mongoose from 'mongoose';
import RefreshSession from '../modal/refreshSessionModel';
import { createSessionManager, hashOpaqueToken } from '../src/modules/auth/application/manageSessions';
import { mongoRefreshSessionRepository as sessions } from '../src/modules/auth/infrastructure/mongo/mongoRefreshSessionRepository';

const account = {userId:new mongoose.Types.ObjectId().toString(), organizationId:new mongoose.Types.ObjectId().toString(), email:'auth-cas@example.test', role:'customer', roles:['planner'], rolesVersion:1};
const makeManager = () => createSessionManager({ sessions, accounts:{load:async () => account},
  accessTokens:{issue:(_account, sessionId) => ({accessToken:`synthetic-${sessionId}`,expiresAt:Date.now()+60000,expiresIn:60})},
  audit:{append:async () => undefined},
  deriveRefreshToken:(previous, key) => crypto.createHmac('sha256','integration-test-only').update(JSON.stringify([previous,key])).digest('base64url'),
});
before(async () => {
  await mongoose.connect(TEST_MONGODB_URL, {dbName:TEST_MONGODB_DB_NAME, serverSelectionTimeoutMS:5000});
  assert.equal(mongoose.connection.name, 'rfpilot_test');
  await RefreshSession.init();
});
after(async () => {
  // Delete only the random synthetic account's sessions, never the database.
  if (mongoose.connection.readyState === 1) await RefreshSession.deleteMany({userId:account.userId});
  await mongoose.disconnect();
});

test('20 independent managers share one atomic successor without revoking the session', async () => {
  const first = await makeManager().begin({account, correlationId:'begin'});
  const input = {refreshToken:first.refreshToken, rotationKey:'a'.repeat(64), correlationId:'refresh'};
  const results = await Promise.all(Array.from({length:20}, () => makeManager().rotate(input)));
  assert.ok(results.every(result => result.kind === 'rotated'));
  const winner = results[0];
  assert.equal(winner.kind, 'rotated');
  if (winner.kind !== 'rotated') return;
  assert.ok(results.every(result => result.kind === 'rotated' && result.refreshToken === winner.refreshToken));
  const rows = await RefreshSession.find({sessionId:first.sessionId}).select('+tokenHash +consumedTokenHashes +lastRotation').lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'active');
  assert.equal(rows[0].rotationCount, 1);
  assert.equal(rows[0].expiresAt.getTime(), first.refreshExpiresAt);
  assert.deepEqual(rows[0].consumedTokenHashes, [hashOpaqueToken(first.refreshToken)]);
  assert.equal(JSON.stringify(rows).includes(first.refreshToken), false);
  assert.equal(JSON.stringify(rows).includes(winner.refreshToken), false);
  await makeManager().revokePresented({refreshToken:first.refreshToken, correlationId:'logout'});
  assert.equal(await RefreshSession.countDocuments({sessionId:first.sessionId,status:'active'}), 0);
  assert.equal((await makeManager().rotate(input)).kind, 'reuse_detected');
});

for (const mode of ['session','family','all'] as const) test(`atomic rotation cannot resurrect ${mode} revocation`, async () => {
  for (let run = 0; run < 10; run += 1) {
    const first = await makeManager().begin({account, correlationId:'begin'});
    const stored = await sessions.findByTokenHash(hashOpaqueToken(first.refreshToken));
    assert.ok(stored);
    const revoke = () => mode === 'session'
      ? sessions.revokeSession({sessionId:first.sessionId,userId:account.userId,reason:'integration_logout',now:new Date()})
      : mode === 'family' ? sessions.revokeFamily({familyId:stored.familyId,reason:'integration_logout',now:new Date()})
      : sessions.revokeAll({userId:account.userId,organizationId:account.organizationId,reason:'integration_logout',now:new Date()});
    await Promise.all([makeManager().rotate({refreshToken:first.refreshToken,rotationKey:'a'.repeat(64),correlationId:'race'}),revoke()]);
    assert.equal(await RefreshSession.countDocuments({sessionId:first.sessionId,status:'active'}),0);
  }
});

test('old consumed rows remain replay-detectable during schema migration', async () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const familyId = crypto.randomUUID();
  await RefreshSession.create({userId:account.userId,organizationId:account.organizationId,sessionId:crypto.randomUUID(),familyId,tokenId:crypto.randomUUID(),tokenHash:hashOpaqueToken(raw),status:'consumed',expiresAt:new Date(Date.now()+60000),idleExpiresAt:new Date(Date.now()+60000),lastUsedAt:new Date()});
  assert.equal((await makeManager().rotate({refreshToken:raw,rotationKey:'a'.repeat(64),correlationId:'legacy'})).kind,'reuse_detected');
  assert.equal(await RefreshSession.countDocuments({familyId,status:'revoked'}),1);
});
