const assert = require("node:assert/strict");
const test = require("node:test");
const { createSessionManager, hashOpaqueToken } = require("../src/modules/auth/application/manageSessions");
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
        status: "active",
        expiresAt: input.expiresAt,
        idleExpiresAt: input.idleExpiresAt,
      });
    },
    async findByTokenHash(hash) { return records.get(hash) ?? null; },
    async consumeActive({ id, now }) {
      const record = [...records.values()].find((item) => item.id === id);
      if (!record || record.status !== "active") return false;
      record.status = "consumed";
      calls.push(["consume", id, now]);
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
  const manager = createSessionManager({
    sessions,
    accounts: { load: async () => account, ...overrides.accounts },
    accessTokens: { issue: (_account, sessionId) => ({ accessToken: `access-${sessionId}`, expiresAt: 1, expiresIn: 900 }) },
    audit: { append: async (input) => calls.push(["audit", input]) },
    now: () => overrides.now ?? fixedNow,
    opaqueToken: () => `refresh-${++sequence}`,
    id: () => `id-${++sequence}`,
  });
  return { manager, calls, records };
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

test("rotation consumes the old token and preserves the session family", async () => {
  const { manager, calls } = setup();
  const first = await manager.begin({ account, correlationId: "c1" });
  const result = await manager.rotate({ refreshToken: first.refreshToken, correlationId: "c2" });
  assert.equal(result.kind, "rotated");
  assert.notEqual(result.refreshToken, first.refreshToken);
  const creates = calls.filter(([kind]) => kind === "create").map(([, value]) => value);
  assert.equal(creates[1].familyId, creates[0].familyId);
  assert.equal(creates[1].sessionId, creates[0].sessionId);
  assert.equal(creates[1].parentTokenId, creates[0].tokenId);
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
