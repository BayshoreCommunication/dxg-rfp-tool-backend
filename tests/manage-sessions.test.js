const assert = require("node:assert/strict");
const test = require("node:test");
const { createSessionManager, hashOpaqueToken } = require("../src/modules/auth/application/manageSessions");
const crypto = require('node:crypto');
const operationKey = 'a'.repeat(64);
const {
  generateAccessToken,
  generateNotificationSocketTicket,
  TOKEN_EXPIRY_MS,
  verifyAccessToken,
  verifyNotificationSocketTicket,
} = require("../config/jwt");

const account = {
  userId: "u1",
  email: "planner@example.com",
  organizationId: "o1",
  role: "customer",
  roles: ["planner"],
  rolesVersion: 1,
};
const fixedNow = new Date("2026-07-16T00:00:00.000Z");

const setup = (overrides = {}) => {
  const calls = [];
  const records = new Map();
  let sequence = 0;
  const sessions = {
    async create(input) {
      calls.push(["create", input]);
      records.set(input.tokenHash, {
        id: `db-${input.tokenId}`,
        organizationId: input.organizationId,
        userId: input.userId,
        sessionId: input.sessionId,
        familyId: input.familyId,
        tokenId: input.tokenId,
        tokenHash: input.tokenHash,
        consumedTokenHashes: [],
        rotationCount: 0,
        status: "active",
        expiresAt: input.expiresAt,
        idleExpiresAt: input.idleExpiresAt,
      });
    },
    async findByTokenHash(hash) {
      const record = [...records.values()].find(item => item.tokenHash === hash || item.consumedTokenHashes.includes(hash));
      return record ? structuredClone(record) : null;
    },
    async rotateActive(input) {
      if (overrides.beforeRotate) await overrides.beforeRotate();
      const {id, now, previousHash} = input;
      const record = [...records.values()].find((item) => item.id === id);
      if (!record || record.status !== "active" || record.tokenHash !== previousHash || record.expiresAt <= now || record.idleExpiresAt <= now || record.rotationCount >= input.maxRotations) return false;
      record.consumedTokenHashes.push(previousHash);
      record.tokenHash = input.tokenHash;
      record.tokenId = input.tokenId;
      record.rotationCount += 1;
      record.lastRotation = {previousHash, keyHash: input.keyHash, at: now};
      calls.push(["rotate", input]);
      return true;
    },
    async revokeFamily(input) {
      calls.push(["revokeFamily", input]);
      let count = 0;
      for (const record of records.values()) if (record.familyId === input.familyId) { record.status = "revoked"; count += 1; }
      return count;
    },
    async revokeSession(input) {
      calls.push(["revokeSession", input]);
      let count = 0;
      for (const record of records.values()) {
        if (
          record.sessionId === input.sessionId &&
          record.userId === input.userId &&
          record.status !== "revoked"
        ) {
          record.status = "revoked";
          count += 1;
        }
      }
      return count;
    },
    async revokeAll() { return 0; },
    async listActive() { return []; },
    ...overrides.sessions,
  };
  const dependencies = {
    sessions,
    accounts: { load: async () => account, ...overrides.accounts },
    accessTokens: { issue: (_account, sessionId) => ({ accessToken: `access-${sessionId}`, expiresAt: 1, expiresIn: 900 }) },
    audit: { append: async (input) => calls.push(["audit", input]) },
    now: () => typeof overrides.now === 'function' ? overrides.now() : overrides.now ?? fixedNow,
    opaqueToken: () => `refresh-${++sequence}`,
    id: () => `id-${++sequence}`,
    deriveRefreshToken: (previous, key) => crypto.createHmac('sha256', 'test-only-server-secret').update(JSON.stringify([previous, key])).digest('base64url'),
  };
  const manager = createSessionManager(dependencies);
  return { manager, calls, records, secondManager: createSessionManager({...dependencies, ...(overrides.secondNow ? {now:overrides.secondNow} : {})}) };
};

test("begin stores only the refresh hash and returns one raw token", async () => {
  const { manager, calls } = setup();
  const result = await manager.begin({ account, correlationId: "c1", userAgent: "browser", ip: "127.0.0.1" });
  assert.equal(result.refreshToken, "refresh-1");
  assert.equal(result.expiresIn, 900);
  const created = calls.find(([kind]) => kind === "create")[1];
  assert.equal(created.tokenHash, hashOpaqueToken("refresh-1"));
  assert.equal(JSON.stringify(created).includes("refresh-1"), false);
  assert.equal(
    created.expiresAt.getTime() - fixedNow.getTime(),
    30 * 24 * 60 * 60 * 1000,
  );
  assert.equal(
    created.idleExpiresAt.getTime() - fixedNow.getTime(),
    30 * 24 * 60 * 60 * 1000,
  );
  assert.equal(result.refreshExpiresAt, created.expiresAt.getTime());
  assert.equal(calls.at(-1)[1].action, "auth.session.created");
});

test("rotation replaces the credential atomically and preserves the session family", async () => {
  const { manager, calls, records } = setup();
  const first = await manager.begin({ account, correlationId: "c1" });
  const result = await manager.rotate({ refreshToken: first.refreshToken, correlationId: "c2" });
  assert.equal(result.kind, "rotated");
  assert.notEqual(result.refreshToken, first.refreshToken);
  const creates = calls.filter(([kind]) => kind === "create").map(([, value]) => value);
  assert.equal(creates.length, 1);
  const row = [...records.values()][0];
  assert.equal(row.familyId, creates[0].familyId);
  assert.equal(row.sessionId, creates[0].sessionId);
  assert.equal(row.tokenHash, hashOpaqueToken(result.refreshToken));
  assert.deepEqual(row.consumedTokenHashes, [hashOpaqueToken(first.refreshToken)]);
  assert.equal(result.refreshExpiresAt, first.refreshExpiresAt);
});

test('independent managers return one successor for concurrent BFF operations', async () => {
  const {manager, secondManager, records, calls} = setup();
  const first = await manager.begin({account, correlationId:'start'});
  const input = {refreshToken:first.refreshToken, rotationKey:operationKey, correlationId:'refresh'};
  const results = await Promise.all([manager.rotate(input), secondManager.rotate(input)]);
  assert.deepEqual(results.map(row => row.kind), ['rotated', 'rotated']);
  assert.equal(results[0].refreshToken, results[1].refreshToken);
  assert.equal([...records.values()][0].rotationCount, 1);
  assert.equal([...records.values()][0].status, 'active');
  assert.equal(calls.some(([kind]) => kind === 'revokeFamily'), false);
  assert.equal(JSON.stringify([...records.values()]).includes(results[0].refreshToken), false);
});

test('retry window starts at the first rotation, never at the latest retry', async () => {
  let time = new Date(fixedNow);
  const {manager, records} = setup({now:() => time});
  const first = await manager.begin({account, correlationId:'start'});
  const input = {refreshToken:first.refreshToken, rotationKey:operationKey, correlationId:'refresh'};
  const winner = await manager.rotate(input);
  time = new Date(fixedNow.getTime() + 29_999);
  assert.equal((await manager.rotate(input)).refreshToken, winner.refreshToken);
  time = new Date(fixedNow.getTime() + 30_000);
  assert.equal((await manager.rotate(input)).kind, 'reuse_detected');
  assert.equal([...records.values()][0].status, 'revoked');
});

test('small server clock skew does not revoke an identical in-flight operation', async () => {
  const {manager, secondManager} = setup({secondNow:() => new Date(fixedNow.getTime() - 1000)});
  const first = await manager.begin({account,correlationId:'start'});
  const input = {refreshToken:first.refreshToken,rotationKey:operationKey,correlationId:'r'};
  const winner = await manager.rotate(input);
  assert.equal((await secondManager.rotate(input)).refreshToken, winner.refreshToken);
});

for (const key of [undefined, 'b'.repeat(64)]) test(`a missing or different operation key revokes reused credentials (${key?.[0] ?? 'none'})`, async () => {
  const {manager, records} = setup();
  const first = await manager.begin({account, correlationId:'start'});
  await manager.rotate({refreshToken:first.refreshToken, rotationKey:operationKey, correlationId:'r1'});
  assert.equal((await manager.rotate({refreshToken:first.refreshToken, rotationKey:key, correlationId:'r2'})).kind, 'reuse_detected');
  assert.equal([...records.values()][0].status, 'revoked');
});

test('an older generation cannot recover after its successor also rotates', async () => {
  const {manager} = setup();
  const first = await manager.begin({account, correlationId:'start'});
  const second = await manager.rotate({refreshToken:first.refreshToken, rotationKey:operationKey, correlationId:'r1'});
  await manager.rotate({refreshToken:second.refreshToken, rotationKey:'b'.repeat(64), correlationId:'r2'});
  assert.equal((await manager.rotate({refreshToken:first.refreshToken, rotationKey:operationKey, correlationId:'r3'})).kind, 'reuse_detected');
});

for (const reason of ['logout', 'logout_all', 'family']) test(`revocation during account loading cannot be undone (${reason})`, async () => {
  let revoke;
  const {manager, records} = setup({beforeRotate:async () => revoke()});
  const first = await manager.begin({account, correlationId:'start'});
  revoke = async () => {
    if (reason === 'logout') await manager.revokePresented({refreshToken:first.refreshToken, correlationId:'out'});
    else for (const row of records.values()) row.status = 'revoked';
  };
  assert.equal((await manager.rotate({refreshToken:first.refreshToken, rotationKey:operationKey, correlationId:'r'})).kind, 'reuse_detected');
  assert.equal(records.size, 1);
  assert.equal([...records.values()][0].status, 'revoked');
});

test('historical-token logout revokes the current credential', async () => {
  const {manager, records} = setup();
  const first = await manager.begin({account, correlationId:'start'});
  await manager.rotate({refreshToken:first.refreshToken, rotationKey:operationKey, correlationId:'r'});
  await manager.revokePresented({refreshToken:first.refreshToken, correlationId:'out'});
  assert.equal([...records.values()][0].status, 'revoked');
  assert.equal((await manager.rotate({refreshToken:first.refreshToken, rotationKey:operationKey, correlationId:'retry'})).kind, 'reuse_detected');
});

test('rotation history ends safely at its storage limit without pruning replay evidence', async () => {
  const {manager, records, calls} = setup();
  const first = await manager.begin({account, correlationId:'start'});
  [...records.values()][0].rotationCount = 10000;
  assert.equal((await manager.rotate({refreshToken:first.refreshToken, rotationKey:operationKey, correlationId:'r'})).kind, 'expired');
  assert.ok(calls.some(([kind, input]) => kind === 'revokeFamily' && input.reason === 'refresh_rotation_limit'));
});

test("presenting a consumed refresh token revokes its entire family", async () => {
  const { manager, calls } = setup();
  const first = await manager.begin({ account, correlationId: "c1" });
  assert.equal((await manager.rotate({ refreshToken: first.refreshToken, correlationId: "c2" })).kind, "rotated");
  assert.equal((await manager.rotate({ refreshToken: first.refreshToken, correlationId: "c3" })).kind, "reuse_detected");
  assert.ok(calls.some(([kind, input]) => kind === "revokeFamily" && input.reason === "refresh_reuse"));
  assert.ok(calls.some(([kind, input]) => kind === "audit" && input.action === "auth.refresh.reuse_detected"));
});

test("expired tokens fail closed and revoke the family", async () => {
  const { manager, records, calls } = setup();
  const first = await manager.begin({ account, correlationId: "c1" });
  records.get(hashOpaqueToken(first.refreshToken)).idleExpiresAt = new Date("2026-07-15T00:00:00.000Z");
  assert.equal((await manager.rotate({ refreshToken: first.refreshToken, correlationId: "c2" })).kind, "expired");
  assert.ok(calls.some(([kind, input]) => kind === "revokeFamily" && input.reason === "refresh_expired"));
});

test("inactive membership prevents rotation and revokes the family", async () => {
  const { manager, calls } = setup({ accounts: { load: async () => null } });
  const first = await manager.begin({ account, correlationId: "c1" });
  assert.equal((await manager.rotate({ refreshToken: first.refreshToken, correlationId: "c2" })).kind, "membership_inactive");
  assert.ok(calls.some(([kind, input]) => kind === "revokeFamily" && input.reason === "membership_inactive"));
});

test("logout can revoke a session using only its refresh credential", async () => {
  const { manager, calls, records } = setup();
  const first = await manager.begin({ account, correlationId: "c1" });

  assert.deepEqual(
    await manager.revokePresented({
      refreshToken: first.refreshToken,
      correlationId: "c2",
    }),
    { kind: "revoked", revoked: 1 },
  );
  assert.equal(
    records.get(hashOpaqueToken(first.refreshToken)).status,
    "revoked",
  );
  assert.ok(
    calls.some(
      ([kind, input]) =>
        kind === "revokeSession" &&
        input.sessionId === first.sessionId &&
        input.reason === "user_logout",
    ),
  );
  assert.equal(JSON.stringify(calls).includes(first.refreshToken), false);
});

test("logout with an unknown refresh credential is idempotent", async () => {
  const { manager, calls } = setup();
  assert.deepEqual(
    await manager.revokePresented({
      refreshToken: "not-a-session",
      correlationId: "c1",
    }),
    { kind: "not_found", revoked: 0 },
  );
  assert.equal(calls.length, 0);
});

test("session access tokens carry required claims and use the configured lifetime", () => {
  const issuedAt = Date.now();
  const token = generateAccessToken({
    userId: "u1",
    email: "planner@example.com",
    role: "customer",
    organizationId: "o1",
    sessionId: "s1",
    roles: ["planner"],
    rolesVersion: 1,
  });
  assert.ok(
    Math.abs(token.expiresAt - issuedAt - TOKEN_EXPIRY_MS) <= 1000,
  );
  assert.deepEqual(verifyAccessToken(token.accessToken), {
    userId: "u1",
    email: "planner@example.com",
    role: "customer",
    organizationId: "o1",
    sessionId: "s1",
    roles: ["planner"],
    rolesVersion: 1,
  });
});

test("notification socket tickets are short-lived and cannot act as access tokens", () => {
  const issuedAt = Date.now();
  const issued = generateNotificationSocketTicket({
    userId: "u1",
    organizationId: "o1",
    sessionId: "s1",
  });

  assert.ok(issued.expiresAt - issuedAt <= 31_000);
  assert.deepEqual(verifyNotificationSocketTicket(issued.ticket), {
    userId: "u1",
    organizationId: "o1",
    sessionId: "s1",
  });
  assert.throws(() => verifyAccessToken(issued.ticket));

  const access = generateAccessToken({
    userId: "u1",
    email: "planner@example.com",
    role: "customer",
    organizationId: "o1",
    sessionId: "s1",
  });
  assert.throws(() => verifyNotificationSocketTicket(access.accessToken));
});
