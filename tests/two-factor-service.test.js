const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createTwoFactorService, CHALLENGE_MAX_ATTEMPTS, MAX_CONSECUTIVE_FAILURES, LOCK_MS, MAX_LOCK_MS } = require("../src/modules/twoFactor/application/manageTwoFactor");
const { decideSecondFactor, ssoPolicyFromEnv, generateRecoveryCodes, reauthenticationForDisable } = require("../src/modules/twoFactor/domain/secondFactorPolicy");
const { totpAt } = require("../src/modules/twoFactor/domain/totp");
const { createSecretBox } = require("../src/shared/security/secretBox");

const setup = (options = {}) => {
  let clock = new Date("2026-11-02T12:00:00Z");
  const rows = new Map();
  const challenges = new Map();
  const audits = [];
  const revoked = [];
  const box = createSecretBox(crypto.randomBytes(32));
  const records = {
    async find(userId) { const row = rows.get(userId); return row ? structuredClone(row) : null; },
    async savePending(input) {
      if (rows.get(input.userId)?.status === "enabled") return false;
      rows.set(input.userId, { ...input, status: "pending", lastUsedStep: -1, recoveryCodes: [], failedAttempts: 0, lockedUntil: null });
      return true;
    },
    async enable(input) {
      const row = rows.get(input.userId);
      if (!row || row.status !== "pending" || row.secretCiphertext !== input.secretCiphertext) return false;
      Object.assign(row, { status: "enabled", lastUsedStep: input.step, recoveryCodes: input.recoveryCodeHashes.map((hash) => ({ hash, usedAt: null })) });
      return true;
    },
    async acceptStep(input) {
      const row = rows.get(input.userId);
      if (!row || row.status !== "enabled" || row.lastUsedStep >= input.step) return false;
      Object.assign(row, { lastUsedStep: input.step, failedAttempts: 0, lockedUntil: null, lockCount: 0 });
      return true;
    },
    async consumeRecoveryCode(input) {
      const row = rows.get(input.userId);
      const code = row?.recoveryCodes.find((c) => c.hash === input.hash && !c.usedAt);
      if (!code) return false;
      code.usedAt = input.now;
      Object.assign(row, { failedAttempts: 0, lockedUntil: null, lockCount: 0 });
      return true;
    },
    // Same filters as the Mongo conditional updates; one synchronous step each, so atomic here too.
    async claimAttempt(input) {
      const row = rows.get(input.userId);
      if (!row || row.status !== "enabled" || row.failedAttempts >= input.maxFailures || (row.lockedUntil && row.lockedUntil > input.now)) return false;
      row.failedAttempts += 1;
      return true;
    },
    async lockIfExhausted(input) {
      const row = rows.get(input.userId);
      if (!row || row.failedAttempts < input.maxFailures) return;
      const lockCount = row.lockCount ?? 0;
      Object.assign(row, { lockedUntil: new Date(input.now.getTime() + Math.min(input.maxLockMs, input.lockMs * 2 ** lockCount)), lockCount: lockCount + 1, failedAttempts: 0 });
    },
    async replaceRecoveryCodes(input) { rows.get(input.userId).recoveryCodes = input.hashes.map((hash) => ({ hash, usedAt: null })); },
    async remove(userId) { return rows.delete(userId); },
  };
  const challengeRepo = {
    async create(input) { challenges.set(input.tokenHash, { ...input, consumedAt: null }); },
    async claimAttempt({ tokenHash, now, maxAttempts }) {
      const c = challenges.get(tokenHash);
      if (!c || c.consumedAt || c.expiresAt <= now || c.attempts >= maxAttempts) return null;
      c.attempts += 1;
      return structuredClone(c);
    },
    async consume({ tokenHash, now }) {
      const c = challenges.get(tokenHash);
      if (!c || c.consumedAt) return false;
      c.consumedAt = now;
      return true;
    },
  };
  let requires = options.requires ?? false;
  let ssoPolicy = options.ssoPolicy ?? "challenge";
  const service = createTwoFactorService({
    records,
    challenges: challengeRepo,
    secretBox: () => box,
    hasher: { hash: (code) => crypto.createHash("sha256").update(code).digest("hex") },
    audit: { async append(event) { audits.push(event); } },
    organizationRequiresTwoFactor: async () => requires,
    revokeMemberSessions: async (input) => { revoked.push(input); return 2; },
    ssoPolicy: () => ssoPolicy,
    issuer: "RFPilot",
    now: () => clock,
  });
  return {
    service, rows, audits, revoked, challenges,
    tick: (ms) => { clock = new Date(clock.getTime() + ms); },
    now: () => clock,
    setRequires: (value) => { requires = value; },
    setSsoPolicy: (value) => { ssoPolicy = value; },
  };
};

const enrol = async (ctx, userId = "u1") => {
  const started = await ctx.service.startEnrolment({ userId, organizationId: "o1", accountName: "p@example.com" });
  assert.equal(started.kind, "started");
  const confirmed = await ctx.service.confirmEnrolment({ userId, organizationId: "o1", code: totpAt(started.secret, ctx.now()), correlationId: "c" });
  assert.equal(confirmed.kind, "enabled");
  ctx.tick(30_000); // the enrol code's step is spent
  return { secret: started.secret, recoveryCodes: confirmed.recoveryCodes };
};

test("Q8 default: SSO is challenged like a password; trust_sso is the one switch", () => {
  const base = { enrolled: true, organizationRequiresTwoFactor: false };
  assert.equal(decideSecondFactor({ ...base, method: "password", ssoPolicy: "challenge" }), "challenge");
  assert.equal(decideSecondFactor({ ...base, method: "sso", ssoPolicy: "challenge" }), "challenge");
  assert.equal(decideSecondFactor({ ...base, method: "sso", ssoPolicy: "trust_sso" }), "none");
  assert.equal(decideSecondFactor({ ...base, method: "password", ssoPolicy: "trust_sso" }), "challenge");
  assert.equal(decideSecondFactor({ enrolled: false, organizationRequiresTwoFactor: true, method: "sso", ssoPolicy: "challenge" }), "enrol");
  assert.equal(decideSecondFactor({ enrolled: false, organizationRequiresTwoFactor: false, method: "password", ssoPolicy: "challenge" }), "none");
  assert.equal(ssoPolicyFromEnv(undefined), "challenge");
  assert.equal(ssoPolicyFromEnv("TRUST_SSO"), "trust_sso");
  assert.equal(ssoPolicyFromEnv("anything-else"), "challenge");
});

test("ten distinct recovery codes", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
});

test("enrolment stores the seed sealed and the recovery codes hashed, and is audited", async () => {
  const ctx = setup();
  const { secret, recoveryCodes } = await enrol(ctx);
  const row = ctx.rows.get("u1");
  assert.equal(row.status, "enabled");
  assert.ok(!row.secretCiphertext.includes(secret));
  assert.equal(row.recoveryCodes.length, 10);
  for (const code of recoveryCodes) assert.ok(!row.recoveryCodes.some((stored) => stored.hash.includes(code)));
  assert.equal(ctx.audits.filter((a) => a.action === "auth.two_factor.enrolled").length, 1);
});

test("a wrong confirmation code doesn't enable 2FA", async () => {
  const ctx = setup();
  await ctx.service.startEnrolment({ userId: "u1", organizationId: "o1", accountName: "a" });
  assert.equal((await ctx.service.confirmEnrolment({ userId: "u1", organizationId: "o1", code: "000000", correlationId: "c" })).kind, "invalid_code");
  assert.equal(ctx.rows.get("u1").status, "pending");
});

test("starting again while enabled is refused", async () => {
  const ctx = setup();
  await enrol(ctx);
  assert.equal((await ctx.service.startEnrolment({ userId: "u1", organizationId: "o1", accountName: "a" })).kind, "already_enabled");
});

test("sign-in without 2FA and no org requirement needs no second step", async () => {
  const ctx = setup();
  assert.deepEqual(await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" }), { step: "none" });
});

test("a challenge completes once with a valid code; a replayed code is refused", async () => {
  const ctx = setup();
  const { secret } = await enrol(ctx);
  const first = await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" });
  assert.equal(first.step, "challenge");
  const code = totpAt(secret, ctx.now());
  const ok = await ctx.service.completeChallenge({ challengeToken: first.challengeToken, code, correlationId: "c" });
  assert.equal(ok.kind, "verified");
  assert.equal(ok.userId, "u1");

  // Same token again: single-use.
  assert.equal((await ctx.service.completeChallenge({ challengeToken: first.challengeToken, code, correlationId: "c" })).kind, "invalid_challenge");
  // Same code on a fresh challenge within its 30s window: replay.
  const second = await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" });
  assert.equal((await ctx.service.completeChallenge({ challengeToken: second.challengeToken, code, correlationId: "c" })).kind, "invalid_code");
  // An older code from the drift window is a replay too.
  const older = totpAt(secret, new Date(ctx.now().getTime() - 30_000));
  assert.equal((await ctx.service.completeChallenge({ challengeToken: second.challengeToken, code: older, correlationId: "c" })).kind, "invalid_code");
  ctx.tick(30_000);
  assert.equal((await ctx.service.completeChallenge({ challengeToken: second.challengeToken, code: totpAt(secret, ctx.now()), correlationId: "c" })).kind, "verified");
});

test("a recovery code works once, ignores formatting, and is audited", async () => {
  const ctx = setup();
  const { recoveryCodes } = await enrol(ctx);
  const a = await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" });
  const used = await ctx.service.completeChallenge({ challengeToken: a.challengeToken, recoveryCode: ` ${recoveryCodes[0].toUpperCase().replace(/-/g, "")} `, correlationId: "c" });
  assert.equal(used.kind, "verified");
  assert.equal(used.recoveryCodesRemaining, 9);
  assert.equal(ctx.audits.filter((e) => e.action === "auth.two_factor.recovery_code_used").length, 1);
  const b = await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" });
  assert.equal((await ctx.service.completeChallenge({ challengeToken: b.challengeToken, recoveryCode: recoveryCodes[0], correlationId: "c" })).kind, "invalid_code");
});

test("a challenge allows a capped number of attempts and expires", async () => {
  const ctx = setup();
  const { secret } = await enrol(ctx);
  const a = await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" });
  for (let i = 0; i < CHALLENGE_MAX_ATTEMPTS; i++) {
    assert.equal((await ctx.service.completeChallenge({ challengeToken: a.challengeToken, code: "000000", correlationId: "c" })).kind, "invalid_code");
  }
  assert.equal((await ctx.service.completeChallenge({ challengeToken: a.challengeToken, code: totpAt(secret, ctx.now()), correlationId: "c" })).kind, "invalid_challenge");

  const b = await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" });
  ctx.tick(11 * 60_000);
  assert.equal((await ctx.service.completeChallenge({ challengeToken: b.challengeToken, code: totpAt(secret, ctx.now()), correlationId: "c" })).kind, "invalid_challenge");
  assert.equal((await ctx.service.completeChallenge({ challengeToken: "made-up", code: "123456", correlationId: "c" })).kind, "invalid_challenge");
});

test("consecutive failures across challenges lock the account's second factor", async () => {
  const ctx = setup();
  const { secret } = await enrol(ctx);
  let last;
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
    const c = await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" });
    last = await ctx.service.completeChallenge({ challengeToken: c.challengeToken, code: "000000", correlationId: "c" });
  }
  assert.equal(last.kind, "invalid_code");
  const c = await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" });
  const locked = await ctx.service.completeChallenge({ challengeToken: c.challengeToken, code: totpAt(secret, ctx.now()), correlationId: "c" });
  assert.equal(locked.kind, "locked");
  assert.ok(locked.retryAfterSeconds > 0);
  ctx.tick(16 * 60_000);
  const d = await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" });
  assert.equal((await ctx.service.completeChallenge({ challengeToken: d.challengeToken, code: totpAt(secret, ctx.now()), correlationId: "c" })).kind, "verified");
});

test("concurrent guesses across many challenges get at most the per-account cap checked", async () => {
  const ctx = setup();
  const { secret } = await enrol(ctx);
  const challenges = [];
  for (let i = 0; i < 30; i++) challenges.push(await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" }));
  const results = await Promise.all(challenges.map((c) => ctx.service.completeChallenge({ challengeToken: c.challengeToken, code: "000000", correlationId: "c" })));
  assert.equal(results.filter((r) => r.kind === "invalid_code").length, MAX_CONSECUTIVE_FAILURES);
  assert.equal(results.filter((r) => r.kind === "locked").length, 30 - MAX_CONSECUTIVE_FAILURES);
  const row = ctx.rows.get("u1");
  assert.equal(row.lockCount, 1, "one lock, however many guesses raced");
  const c = await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" });
  assert.equal((await ctx.service.completeChallenge({ challengeToken: c.challengeToken, code: totpAt(secret, ctx.now()), correlationId: "c" })).kind, "locked");
});

test("repeated lockouts double up to a day; a success resets the escalation", async () => {
  const ctx = setup();
  const { secret } = await enrol(ctx);
  const exhaust = async () => {
    let last;
    for (let i = 0; i <= MAX_CONSECUTIVE_FAILURES; i++) {
      const c = await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" });
      last = await ctx.service.completeChallenge({ challengeToken: c.challengeToken, code: "000000", correlationId: "c" });
    }
    assert.equal(last.kind, "locked");
    return last.retryAfterSeconds;
  };
  const expected = [];
  const seen = [];
  for (let lock = 0; lock < 9; lock++) {
    expected.push(Math.min(MAX_LOCK_MS, LOCK_MS * 2 ** lock) / 1000);
    seen.push(await exhaust());
    ctx.tick(MAX_LOCK_MS);
  }
  assert.deepEqual(seen, expected);
  assert.equal(seen.at(-1), 24 * 60 * 60, "capped at a day");

  const c = await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" });
  assert.equal((await ctx.service.completeChallenge({ challengeToken: c.challengeToken, code: totpAt(secret, ctx.now()), correlationId: "c" })).kind, "verified");
  assert.equal(ctx.rows.get("u1").lockCount, 0);
  assert.equal(await exhaust(), LOCK_MS / 1000, "back to the first lock's length");
});

test("an attempt whose check never finished still ends in a lock", async () => {
  const ctx = setup();
  await enrol(ctx);
  // As if the process died after claiming the last attempt.
  Object.assign(ctx.rows.get("u1"), { failedAttempts: MAX_CONSECUTIVE_FAILURES, lockedUntil: null });
  const c = await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" });
  const result = await ctx.service.completeChallenge({ challengeToken: c.challengeToken, code: "000000", correlationId: "c" });
  assert.deepEqual(result, { kind: "locked", retryAfterSeconds: LOCK_MS / 1000 });
  assert.equal(ctx.rows.get("u1").failedAttempts, 0);
  assert.ok(ctx.rows.get("u1").lockedUntil > ctx.now());
});

test("ORG-304: a required organization routes a non-enrolled member to enrolment, which then signs them in", async () => {
  const ctx = setup({ requires: true });
  const step = await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" });
  assert.equal(step.step, "enrol");
  // An enrolment token can't be used as a verification challenge.
  assert.equal((await ctx.service.completeChallenge({ challengeToken: step.challengeToken, code: "123456", correlationId: "c" })).kind, "invalid_challenge");
  const started = await ctx.service.startChallengeEnrolment({ challengeToken: step.challengeToken, accountName: async () => "p@example.com" });
  assert.equal(started.kind, "started");
  const done = await ctx.service.confirmChallengeEnrolment({ challengeToken: step.challengeToken, code: totpAt(started.secret, ctx.now()), correlationId: "c" });
  assert.equal(done.kind, "enabled");
  assert.equal(done.userId, "u1");
  assert.equal(done.recoveryCodes.length, 10);
  assert.equal((await ctx.service.confirmChallengeEnrolment({ challengeToken: step.challengeToken, code: "123456", correlationId: "c" })).kind, "invalid_challenge");
  assert.equal((await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" })).step, "challenge");
});

test("ORG-304: SSO follows the Q8 switch", async () => {
  const ctx = setup({ requires: true });
  assert.equal((await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "sso" })).step, "enrol");
  ctx.setSsoPolicy("trust_sso");
  assert.equal((await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "sso" })).step, "none");
});

test("disable needs a current code, is audited, and is refused when the org requires 2FA", async () => {
  const ctx = setup();
  const { secret } = await enrol(ctx);
  assert.equal((await ctx.service.disable({ userId: "u1", organizationId: "o1", code: "000000", correlationId: "c" })).kind, "invalid_code");
  ctx.setRequires(true);
  assert.equal((await ctx.service.disable({ userId: "u1", organizationId: "o1", code: totpAt(secret, ctx.now()), correlationId: "c" })).kind, "required_by_organization");
  ctx.setRequires(false);
  assert.equal((await ctx.service.disable({ userId: "u1", organizationId: "o1", code: totpAt(secret, ctx.now()), correlationId: "c" })).kind, "disabled");
  assert.equal(ctx.rows.has("u1"), false);
  assert.equal(ctx.audits.filter((a) => a.action === "auth.two_factor.disabled").length, 1);
});

test("disable re-authentication: a given password must match; without one, only an SSO-linked account may rely on its code", async () => {
  const decide = (passwordSupplied, passwordMatches, ssoLinked) => reauthenticationForDisable({ passwordSupplied, passwordMatches, ssoLinked });
  assert.equal(decide(true, true, false), "password");
  assert.equal(decide(true, false, false), "refused");
  assert.equal(decide(true, false, true), "refused", "a wrong password is never ignored");
  assert.equal(decide(false, false, false), "refused", "password accounts still need it");
  assert.equal(decide(false, false, true), "second_factor");

  // The second factor is still checked, and the audit says which proof was used.
  const ctx = setup();
  const { recoveryCodes } = await enrol(ctx);
  assert.equal((await ctx.service.disable({ userId: "u1", organizationId: "o1", correlationId: "c", reauthentication: "second_factor" })).kind, "invalid_code");
  assert.equal((await ctx.service.disable({ userId: "u1", organizationId: "o1", recoveryCode: recoveryCodes[0], correlationId: "c", reauthentication: "second_factor" })).kind, "disabled");
  assert.deepEqual(ctx.audits.find((a) => a.action === "auth.two_factor.disabled").metadata, { reauthentication: "second_factor" });
});

test("regenerating recovery codes voids the old ones", async () => {
  const ctx = setup();
  const { secret, recoveryCodes } = await enrol(ctx);
  const result = await ctx.service.regenerateRecoveryCodes({ userId: "u1", organizationId: "o1", code: totpAt(secret, ctx.now()), correlationId: "c" });
  assert.equal(result.kind, "regenerated");
  const c = await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" });
  assert.equal((await ctx.service.completeChallenge({ challengeToken: c.challengeToken, recoveryCode: recoveryCodes[1], correlationId: "c" })).kind, "invalid_code");
  assert.equal((await ctx.service.completeChallenge({ challengeToken: c.challengeToken, recoveryCode: result.recoveryCodes[1], correlationId: "c" })).kind, "verified");
});

test("ORG-304: an Admin reset clears 2FA, revokes the member's sessions, and audits the Admin as actor", async () => {
  const ctx = setup();
  await enrol(ctx);
  const result = await ctx.service.adminReset({ actorUserId: "admin", targetUserId: "u1", organizationId: "o1", correlationId: "c" });
  assert.deepEqual(result, { kind: "reset", wasEnrolled: true, revokedSessions: 2 });
  assert.equal(ctx.rows.has("u1"), false);
  assert.deepEqual(ctx.revoked, [{ userId: "u1", organizationId: "o1", correlationId: "c", reason: "two_factor_reset" }]);
  const audit = ctx.audits.find((a) => a.action === "auth.two_factor.reset");
  assert.equal(audit.actorUserId, "admin");
  assert.equal(audit.targetId, "u1");
  assert.equal((await ctx.service.assessSignIn({ userId: "u1", organizationId: "o1", method: "password" })).step, "none");
});
