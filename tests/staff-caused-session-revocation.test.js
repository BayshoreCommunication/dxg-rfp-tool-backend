require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createSessionManager, hashOpaqueToken } = require("../src/modules/auth/application/manageSessions");
const { createMembershipSessionHardening } = require("../src/modules/auth/application/membershipSessionHardening");
const { createStaffCausedSessionRevocation, STAFF_SESSIONS_REVOKED_ACTION } = require("../src/modules/auth/application/staffCausedSessionRevocation");
const { STAFF_MEMBERSHIP_REVOKE_REASON } = require("../src/modules/auth/domain/ports/sessionPorts");
const { AUDIT_CATALOG, VISIBLE_ACTIONS, isStaffOnlyAction, catalogEntry } = require("../src/modules/auditLog/domain");

/* Owner's rule (2026-11-18): customers see no RFPilot staff activity. A session revocation that a
   STAFF-made membership change causes leaves no event in the member's organization; the security
   outcome is unchanged. A change made by a member of the organization, and a genuine token reuse,
   write exactly the events they always did. */

const hex = (c) => c.repeat(24);
const ORG = hex("a");
const STAFF_ORG = hex("f");
const STAFF = hex("e");
const MEMBER = hex("1");
const NOW = new Date("2026-11-18T10:00:00.000Z");
const KEY = "a".repeat(64);
const account = { userId: MEMBER, email: "m@example.test", organizationId: ORG, role: "customer", roles: ["planner"], rolesVersion: 1 };

// An in-memory refresh-session store that keeps revokeReason, as the Mongo repository does.
const sessionStore = (options = {}) => {
  const records = [];
  const audit = [];
  const calls = [];
  let sequence = 0;
  const live = (r) => r.status !== "revoked";
  const sessions = {
    async create(input) {
      records.push({ id: `db-${input.tokenId}`, organizationId: input.organizationId, userId: input.userId, sessionId: input.sessionId, familyId: input.familyId,
        tokenId: input.tokenId, tokenHash: input.tokenHash, consumedTokenHashes: [], rotationCount: 0, status: "active", revokeReason: null,
        expiresAt: input.expiresAt, idleExpiresAt: input.idleExpiresAt });
    },
    async findByTokenHash(hash) {
      const record = records.find((r) => r.tokenHash === hash || r.consumedTokenHashes.includes(hash));
      return record ? structuredClone(record) : null;
    },
    async rotateActive(input) {
      if (options.beforeRotate) await options.beforeRotate(api);
      const record = records.find((r) => r.id === input.id);
      if (!record || record.status !== "active" || record.tokenHash !== input.previousHash) return false;
      record.consumedTokenHashes.push(input.previousHash);
      Object.assign(record, { tokenHash: input.tokenHash, tokenId: input.tokenId, rotationCount: record.rotationCount + 1, lastRotation: { previousHash: input.previousHash, keyHash: input.keyHash, at: input.now } });
      return true;
    },
    async revokeFamily(input) {
      calls.push(["revokeFamily", input.familyId, input.reason]);
      const hit = records.filter((r) => r.familyId === input.familyId && live(r));
      for (const r of hit) Object.assign(r, { status: "revoked", revokeReason: input.reason });
      return hit.length;
    },
    async revokeSession(input) {
      const hit = records.filter((r) => r.sessionId === input.sessionId && r.userId === input.userId && live(r));
      for (const r of hit) Object.assign(r, { status: "revoked", revokeReason: input.reason });
      return hit.length;
    },
    async revokeAll(input) {
      calls.push(["revokeAll", input.userId, input.organizationId, input.reason, input.exceptSessionId]);
      const hit = records.filter((r) => r.userId === input.userId && r.organizationId === input.organizationId && live(r) && r.sessionId !== input.exceptSessionId);
      for (const r of hit) Object.assign(r, { status: "revoked", revokeReason: input.reason });
      return hit.length;
    },
    async listActive() { return []; },
  };
  const manager = createSessionManager({
    sessions,
    accounts: { load: async () => (options.inactive?.() ? null : account) },
    accessTokens: { issue: (_a, sessionId) => ({ accessToken: `access-${sessionId}`, expiresAt: 1, expiresIn: 900 }) },
    audit: { append: async (event) => { audit.push(event); } },
    now: () => NOW,
    opaqueToken: () => `refresh-${++sequence}`,
    id: () => `id-${++sequence}`,
    deriveRefreshToken: (previous, key) => crypto.createHmac("sha256", "test-only").update(JSON.stringify([previous, key])).digest("base64url"),
    ...(options.inactiveMembershipReason ? { inactiveMembershipReason: options.inactiveMembershipReason } : {}),
  });
  // What the staff hook does (auth/composition.ts, staffMembershipSessions): the repository, the staff reason, no event.
  const staffRevoke = (exceptSessionId) => sessions.revokeAll({ userId: MEMBER, organizationId: ORG, reason: STAFF_MEMBERSHIP_REVOKE_REASON, now: NOW, exceptSessionId });
  const api = { manager, sessions, records, audit, calls, staffRevoke, events: (action) => audit.filter((e) => e.action === action) };
  return api;
};

const begin = async (store) => store.manager.begin({ account, correlationId: "c-begin" });
const REUSE = "auth.refresh.reuse_detected";
// Exactly what origin/main writes for a consumed or revoked token.
const reuseEvent = (sessionId, correlationId) => ({
  organizationId: ORG, actorUserId: MEMBER, action: REUSE, targetType: "refresh_session", targetId: sessionId,
  decision: "detected", reason: "consumed_or_revoked_token_presented", correlationId,
});

// ── Trace 1: auth.refresh.reuse_detected ─────────────────────────────────────────────────────

test("trace 1, staff cause: a session staff ended refuses its own last refresh token as before and writes no reuse event in the member's organization", async () => {
  const store = sessionStore();
  const session = await begin(store);
  assert.equal(await store.staffRevoke(), 1);
  const result = await store.manager.rotate({ refreshToken: session.refreshToken, correlationId: "c-1" });
  // Same refusal, same family revocation call, as for any revoked token.
  assert.deepEqual(result, { kind: "reuse_detected" });
  assert.deepEqual(store.calls.filter(([name]) => name === "revokeFamily"), [["revokeFamily", store.records[0].familyId, "refresh_reuse"]]);
  assert.equal(store.records[0].status, "revoked");
  assert.deepEqual(store.events(REUSE), []);
  // The only event in the member's organization is the sign-in itself.
  assert.deepEqual(store.audit.map((e) => e.action), ["auth.session.created"]);
  // Presenting it again and again stays silent and refused.
  assert.deepEqual(await store.manager.rotate({ refreshToken: session.refreshToken, rotationKey: KEY, correlationId: "c-2" }), { kind: "reuse_detected" });
  assert.deepEqual(store.events(REUSE), []);
});

test("trace 1, staff cause, race: staff end the session between the read and the rotation; the refresh is refused and nothing is written", async () => {
  const store = sessionStore({ beforeRotate: (api) => api.staffRevoke() });
  const session = await begin(store);
  assert.deepEqual(await store.manager.rotate({ refreshToken: session.refreshToken, rotationKey: KEY, correlationId: "c-1" }), { kind: "reuse_detected" });
  assert.deepEqual(store.events(REUSE), []);
  assert.equal(store.records[0].status, "revoked");
});

test("trace 1, customer cause: a session ended by a member of the organization still writes the reuse event, exactly as before", async () => {
  for (const reason of ["membership_role_demoted", "membership_deactivated", "membership_role_changed", "membership_inactive", "user_logout", "two_factor_reset"]) {
    const store = sessionStore();
    const session = await begin(store);
    await store.sessions.revokeAll({ userId: MEMBER, organizationId: ORG, reason, now: NOW });
    assert.deepEqual(await store.manager.rotate({ refreshToken: session.refreshToken, correlationId: "c-1" }), { kind: "reuse_detected" }, reason);
    assert.deepEqual(store.events(REUSE), [reuseEvent(session.sessionId, "c-1")], reason);
  }
});

test("trace 1, genuine reuse is still detected: an already-rotated token, on a live session and on one staff later ended", async () => {
  // A consumed token on a live session: the family is revoked and the event written.
  const live = sessionStore();
  const first = await begin(live);
  const rotated = await live.manager.rotate({ refreshToken: first.refreshToken, correlationId: "c-rotate" });
  assert.equal(rotated.kind, "rotated");
  assert.deepEqual(await live.manager.rotate({ refreshToken: first.refreshToken, correlationId: "c-replay" }), { kind: "reuse_detected" });
  assert.deepEqual(live.events(REUSE), [reuseEvent(first.sessionId, "c-replay")]);
  assert.deepEqual([live.records[0].status, live.records[0].revokeReason], ["revoked", "refresh_reuse"]);

  // The same replay after staff ended the session: the staff reason covers only the session's
  // LAST token. An older, consumed one is a replay and is reported.
  const ended = sessionStore();
  const one = await begin(ended);
  const two = await ended.manager.rotate({ refreshToken: one.refreshToken, correlationId: "c-rotate" });
  await ended.staffRevoke();
  assert.deepEqual(await ended.manager.rotate({ refreshToken: one.refreshToken, correlationId: "c-replay" }), { kind: "reuse_detected" });
  assert.deepEqual(ended.events(REUSE), [reuseEvent(one.sessionId, "c-replay")]);
  // ... while the member's own browser, holding the last token, is refused silently.
  assert.deepEqual(await ended.manager.rotate({ refreshToken: two.refreshToken, correlationId: "c-own" }), { kind: "reuse_detected" });
  assert.equal(ended.events(REUSE).length, 1);
});

test("trace 1, the marker is per session: after signing in again a later revocation by the organization, and a later replay, are reported", async () => {
  const store = sessionStore();
  const old = await begin(store);
  await store.staffRevoke();
  await store.manager.rotate({ refreshToken: old.refreshToken, correlationId: "c-old" });
  assert.deepEqual(store.events(REUSE), []);
  // A new sign-in is a new session with no staff reason on it.
  const fresh = await begin(store);
  await store.sessions.revokeAll({ userId: MEMBER, organizationId: ORG, reason: "membership_role_demoted", now: NOW });
  assert.deepEqual(await store.manager.rotate({ refreshToken: fresh.refreshToken, correlationId: "c-new" }), { kind: "reuse_detected" });
  assert.deepEqual(store.events(REUSE), [reuseEvent(fresh.sessionId, "c-new")]);
  // The old session keeps the staff reason: a revocation that finds it already revoked does not rewrite it.
  assert.equal(store.records[0].revokeReason, STAFF_MEMBERSHIP_REVOKE_REASON);
});

test("trace 1, a member deactivated by staff who refreshes before any revocation ran: the session ends for the staff reason, so the next refresh writes nothing; without the staff cause it is exactly as before", async () => {
  let inactive = false;
  const asked = [];
  const staff = sessionStore({ inactive: () => inactive, inactiveMembershipReason: async (member) => { asked.push([member.userId, member.organizationId]); return STAFF_MEMBERSHIP_REVOKE_REASON; } });
  const session = await begin(staff);
  inactive = true;
  assert.deepEqual(await staff.manager.rotate({ refreshToken: session.refreshToken, correlationId: "c-1" }), { kind: "membership_inactive" });
  assert.deepEqual(asked, [[MEMBER, ORG]]);
  assert.deepEqual([staff.records[0].status, staff.records[0].revokeReason], ["revoked", STAFF_MEMBERSHIP_REVOKE_REASON]);
  assert.deepEqual(await staff.manager.rotate({ refreshToken: session.refreshToken, correlationId: "c-2" }), { kind: "reuse_detected" });
  assert.deepEqual(staff.audit.map((e) => e.action), ["auth.session.created"]);

  // Deactivated by a member of the organization: reason membership_inactive, and the next refresh is reported.
  for (const dependency of [undefined, async () => "membership_inactive"]) {
    const customer = sessionStore({ inactive: () => inactive, inactiveMembershipReason: dependency });
    inactive = false;
    const own = await begin(customer);
    inactive = true;
    assert.deepEqual(await customer.manager.rotate({ refreshToken: own.refreshToken, correlationId: "c-1" }), { kind: "membership_inactive" });
    assert.deepEqual([customer.records[0].status, customer.records[0].revokeReason], ["revoked", "membership_inactive"]);
    assert.deepEqual(await customer.manager.rotate({ refreshToken: own.refreshToken, correlationId: "c-2" }), { kind: "reuse_detected" });
    assert.deepEqual(customer.events(REUSE), [reuseEvent(own.sessionId, "c-2")]);
  }
});

// ── Traces 2 and 3: the access path ──────────────────────────────────────────────────────────

// The customer flow is the real one (session manager + membership hardening); only storage is faked.
const accessPath = (options = {}) => {
  const store = sessionStore();
  const membership = { pending: true, staff: options.pendingCause ?? null, claim: null, suspendedBy: options.suspensionCause ?? null };
  const asked = [];
  const claims = (byStaff) => ({
    claimRevocationPending: async ({ sessionId }) => {
      if (!membership.pending || membership.claim || Boolean(membership.staff) !== byStaff) return false;
      membership.claim = sessionId;
      return true;
    },
    completeRevocationPending: async ({ sessionId }) => { if (membership.claim === sessionId) Object.assign(membership, { pending: false, claim: null, staff: null }); },
    releaseRevocationClaim: async ({ sessionId }) => { if (membership.claim === sessionId) membership.claim = null; },
  });
  const customerSessions = createMembershipSessionHardening({
    revokeOtherSessions: (input) => store.manager.revokeOtherSessions(input),
    markRevocationPending: async () => { Object.assign(membership, { pending: true, claim: null, staff: null }); },
    ...claims(false),
  });
  const staffEvents = [];
  const access = createStaffCausedSessionRevocation({
    pendingCause: async (member) => { asked.push(["pending", member.userId, member.organizationId]); return membership.staff; },
    suspensionCause: async (member) => { asked.push(["suspension", member.userId, member.organizationId]); return membership.suspendedBy; },
    customer: {
      onRequestWithPendingRevocation: (input) => customerSessions.onRequestWithPendingRevocation(input),
      revokeInactiveMembership: (input) => store.manager.revokeInactiveMembership(input),
    },
    revokeSessions: (input) => store.sessions.revokeAll({ ...input, reason: STAFF_MEMBERSHIP_REVOKE_REASON, now: NOW }),
    staffClaims: claims(true),
    audit: { append: async (event) => { if (options.failStaffAudit) throw new Error("audit store down"); staffEvents.push(event); } },
    isValidId: (value) => /^[a-f0-9]{24}$/i.test(value),
  });
  return { store, membership, access, staffEvents, asked, customerSessions };
};
const STAFF_CAUSE = { organizationId: STAFF_ORG, actorUserId: STAFF };
const statuses = (store) => store.records.map((r) => [r.status, r.revokeReason]);

test("trace 2, staff cause: the member's next request ends their other sessions, keeps its own, and writes nothing in the member's organization; the staff organization gets the record", async () => {
  const { store, membership, access, staffEvents } = accessPath({ pendingCause: STAFF_CAUSE });
  const [kept] = [await begin(store), await begin(store), await begin(store)];
  const before = store.audit.length;
  const revoked = await access.revokeOtherSessionsAfterMembershipChange({ userId: MEMBER, organizationId: ORG, sessionId: kept.sessionId, correlationId: "c-req" });
  assert.equal(revoked, 2);
  assert.deepEqual(statuses(store), [["active", null], ["revoked", STAFF_MEMBERSHIP_REVOKE_REASON], ["revoked", STAFF_MEMBERSHIP_REVOKE_REASON]]);
  // Nothing new in the member's organization.
  assert.equal(store.audit.length, before);
  assert.deepEqual(store.audit.filter((e) => e.action.startsWith("auth.sessions.")), []);
  // The flag and its marker are cleared: a second request does nothing.
  assert.deepEqual(membership, { pending: false, staff: null, claim: null, suspendedBy: null });
  assert.deepEqual(staffEvents, [{
    organizationId: STAFF_ORG, actorUserId: STAFF, action: "platform.organization_member.sessions_revoked",
    targetType: "organization_membership", targetId: MEMBER, decision: "revoked", reason: "membership_role_changed", correlationId: "c-req",
    metadata: { agentAccountType: "admin", organizationId: ORG, memberUserId: MEMBER, revokedCount: 2, keptSession: true, trigger: "member_request" },
  }]);
  // The sessions that were ended refuse their refresh tokens silently (trace 1).
  for (const record of store.records.slice(1)) assert.equal(record.revokeReason, STAFF_MEMBERSHIP_REVOKE_REASON);
});

test("trace 2, customer cause: the same request writes auth.sessions.revoked_others in the member's organization, exactly as before, and nothing on the staff side", async () => {
  const { store, membership, access, staffEvents, asked } = accessPath();
  const [kept] = [await begin(store), await begin(store), await begin(store)];
  const revoked = await access.revokeOtherSessionsAfterMembershipChange({ userId: MEMBER, organizationId: ORG, sessionId: kept.sessionId, correlationId: "c-req" });
  assert.equal(revoked, 2);
  assert.deepEqual(statuses(store), [["active", null], ["revoked", "membership_role_changed"], ["revoked", "membership_role_changed"]]);
  assert.deepEqual(store.audit.filter((e) => e.action !== "auth.session.created"), [{
    organizationId: ORG, actorUserId: MEMBER, action: "auth.sessions.revoked_others", targetType: "user", targetId: MEMBER,
    decision: "revoked", reason: "membership_role_changed", correlationId: "c-req", metadata: { revokedCount: 2, keptSession: true },
  }]);
  assert.deepEqual(staffEvents, []);
  assert.equal(membership.pending, false);
  assert.deepEqual(asked, [["pending", MEMBER, ORG]]);
});

test("trace 2, the marker is cleared when a member of the organization changes the member afterwards: that change is reported as theirs", async () => {
  const { store, membership, access, staffEvents, customerSessions } = accessPath({ pendingCause: STAFF_CAUSE });
  const [kept] = [await begin(store), await begin(store)];
  // An Owner changes the member's role after the staff change: the flag is the organization's again.
  await customerSessions.afterRoleChange({ organizationId: ORG, userId: MEMBER, actorUserId: hex("2"), correlationId: "c-owner" });
  assert.deepEqual([membership.pending, membership.staff], [true, null]);
  await access.revokeOtherSessionsAfterMembershipChange({ userId: MEMBER, organizationId: ORG, sessionId: kept.sessionId, correlationId: "c-req" });
  assert.deepEqual(store.audit.filter((e) => e.action === "auth.sessions.revoked_others").map((e) => [e.organizationId, e.reason, e.metadata.revokedCount]), [[ORG, "membership_role_changed", 1]]);
  assert.deepEqual(staffEvents, []);
});

test("trace 2, staff cause: a failing or impossible staff-side record never fails the member's request, and never falls back to the member's organization", async () => {
  const failing = accessPath({ pendingCause: STAFF_CAUSE, failStaffAudit: true });
  const [kept] = [await begin(failing.store), await begin(failing.store)];
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    assert.equal(await failing.access.revokeOtherSessionsAfterMembershipChange({ userId: MEMBER, organizationId: ORG, sessionId: kept.sessionId, correlationId: "c" }), 1);
  } finally {
    console.error = original;
  }
  assert.match(logged[0], /could not be recorded/);
  assert.equal(failing.membership.pending, false);
  assert.deepEqual(failing.store.audit.filter((e) => e.action !== "auth.session.created"), []);

  // A marker without a usable staff organization still suppresses the customer event.
  for (const cause of [{ organizationId: null, actorUserId: null }, { organizationId: "not-an-id", actorUserId: STAFF }]) {
    const unknown = accessPath({ pendingCause: cause });
    const [mine] = [await begin(unknown.store), await begin(unknown.store)];
    assert.equal(await unknown.access.revokeOtherSessionsAfterMembershipChange({ userId: MEMBER, organizationId: ORG, sessionId: mine.sessionId, correlationId: "c" }), 1);
    assert.deepEqual(unknown.staffEvents, []);
    assert.deepEqual(unknown.store.audit.filter((e) => e.action !== "auth.session.created"), []);
  }
});

test("trace 3, staff cause: a member deactivated by staff who makes a request has every session ended and nothing written in the member's organization; the staff organization gets the record", async () => {
  const { store, access, staffEvents } = accessPath({ suspensionCause: STAFF_CAUSE });
  await begin(store);
  await begin(store);
  const revoked = await access.revokeInactiveMembershipSessions({ userId: MEMBER, organizationId: ORG, correlationId: "c-req" });
  assert.equal(revoked, 2);
  assert.deepEqual(statuses(store), [["revoked", STAFF_MEMBERSHIP_REVOKE_REASON], ["revoked", STAFF_MEMBERSHIP_REVOKE_REASON]]);
  assert.deepEqual(store.audit.filter((e) => e.action !== "auth.session.created"), []);
  assert.deepEqual(staffEvents, [{
    organizationId: STAFF_ORG, actorUserId: STAFF, action: "platform.organization_member.sessions_revoked",
    targetType: "organization_membership", targetId: MEMBER, decision: "revoked", reason: "membership_inactive", correlationId: "c-req",
    metadata: { agentAccountType: "admin", organizationId: ORG, memberUserId: MEMBER, revokedCount: 2, keptSession: false, trigger: "member_request" },
  }]);
  // Later requests revoke nothing and record nothing, as in the customer flow.
  assert.equal(await access.revokeInactiveMembershipSessions({ userId: MEMBER, organizationId: ORG, correlationId: "c-again" }), 0);
  assert.equal(staffEvents.length, 1);
});

test("trace 3, customer cause: a member deactivated by the organization writes auth.sessions.revoked_all (membership_inactive) exactly as before; an account awaiting placement never consults the staff marker", async () => {
  const { store, access, staffEvents, asked } = accessPath();
  await begin(store);
  await begin(store);
  assert.equal(await access.revokeInactiveMembershipSessions({ userId: MEMBER, organizationId: ORG, correlationId: "c-req" }), 2);
  assert.deepEqual(statuses(store), [["revoked", "membership_inactive"], ["revoked", "membership_inactive"]]);
  assert.deepEqual(store.audit.filter((e) => e.action !== "auth.session.created"), [{
    organizationId: ORG, actorUserId: MEMBER, action: "auth.sessions.revoked_all", targetType: "user", targetId: MEMBER,
    decision: "revoked", reason: "membership_inactive", correlationId: "c-req", metadata: { revokedCount: 2 },
  }]);
  assert.deepEqual(staffEvents, []);
  assert.deepEqual(asked, [["suspension", MEMBER, ORG]]);

  // organization_setup_required is not a deactivation: even with a staff marker on the membership it is the customer flow.
  const placement = accessPath({ suspensionCause: STAFF_CAUSE });
  await begin(placement.store);
  assert.equal(await placement.access.revokeInactiveMembershipSessions({ userId: MEMBER, organizationId: ORG, correlationId: "c", reason: "organization_setup_required" }), 1);
  assert.deepEqual(placement.asked, []);
  assert.deepEqual(placement.store.audit.filter((e) => e.action === "auth.sessions.revoked_all").map((e) => e.reason), ["organization_setup_required"]);
  assert.deepEqual(placement.staffEvents, []);
});

// ── Where the markers are set and cleared, and that nothing returns them ─────────────────────

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("the markers are set only by the staff flow and cleared by the organization's own changes", () => {
  const composition = read("src/modules/auth/composition.ts");
  // The staff hook: every session it ends carries the staff reason, and its pending flag carries the staff cause.
  const hook = composition.slice(composition.indexOf("export const staffMembershipSessions"));
  assert.match(hook, /mongoRefreshSessionRepository\.revokeAll\(\{\s+userId: input\.userId, organizationId: input\.organizationId, reason: STAFF_MEMBERSHIP_REVOKE_REASON,/);
  assert.match(hook, /\$set: \{ sessionRevocationStaff: \{ organizationId: staffOrganizationId \?\? null, actorUserId: actorUserId \?\? null \} \}/);
  // ... and never takes over a flag a member of the organization already set.
  assert.match(hook, /\$or: \[\{ sessionRevocationPending: \{ \$ne: true \} \}, \{ sessionRevocationStaff: \{ \$ne: null \} \}\]/);
  // The staff reason is used nowhere else in the customer's session manager wiring.
  const customer = composition.slice(composition.indexOf("const membershipRevocationFlags"), composition.indexOf("const revokeForStaffChange"));
  assert.doesNotMatch(customer, /STAFF_MEMBERSHIP_REVOKE_REASON/);
  // A change by a member of the organization clears the staff cause; so does completing the revocation.
  assert.match(customer, /\$set: \{ sessionRevocationPending: true, sessionRevocationClaim: null, sessionRevocationStaff: null \}/);
  assert.match(composition, /\$set: \{ sessionRevocationPending: false, sessionRevocationClaim: null, sessionRevocationStaff: null \}/);
  // Each flow claims only its own flag.
  assert.match(composition, /sessionRevocationStaff: byStaff \? \{ \$ne: null \} : null,/);

  const store = read("src/modules/organizationMembers/infrastructure/mongoMembershipStore.ts");
  // Set in the transaction of a staff deactivation (one carrying an event), null for the organization's own.
  assert.match(store, /const suspendedByStaff = input\.audit \? \{ organizationId: input\.audit\.organizationId, actorUserId: input\.audit\.actorUserId \} : null;\s+row = await updateVersioned\(input, \{ status: \{ \$ne: "removed" \} \}, \{ \$set: \{ status: "suspended", suspendedAt: input\.now, suspendedByStaff \} \}, session\);/);
  // Cleared by reactivation and by the put-back.
  assert.match(store, /const update = \{ \$set: \{ status: "active", suspendedAt: null, activatedAt: new Date\(\), suspendedByStaff: null \} \};/);
  assert.match(store, /\$set: \{ status: "active", suspendedAt: null, suspendedByStaff: null \}, \$inc: \{ version: 1 \}/);
  // Only a suspended membership is read for it.
  assert.match(composition, /OrganizationMembership\.findOne\(\{ organizationId: member\.organizationId, userId: member\.userId, status: "suspended" \}\)\s+\.select\("suspendedByStaff"\)/);
});

test("no marker is returned by an API or shown in the customer audit log", () => {
  const markers = /sessionRevocationStaff|suspendedByStaff|staff_membership_changed|STAFF_MEMBERSHIP_REVOKE_REASON/;
  // Every file outside the auth module, the membership model and the membership store that could build an answer.
  const roots = ["controller", "routes", "middleware", "src/modules", "contracts"];
  const allowed = new Set([
    "src/modules/auth/composition.ts", "src/modules/auth/application/manageSessions.ts", "src/modules/auth/domain/ports/sessionPorts.ts",
    "src/modules/organizationMembers/infrastructure/mongoMembershipStore.ts",
  ]);
  const walk = (dir) => fs.readdirSync(path.join(__dirname, "..", dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "generated" || entry.name === "node_modules" ? [] : walk(file);
    return /\.ts$/.test(entry.name) ? [file] : [];
  });
  const offenders = roots.flatMap(walk).filter((file) => !allowed.has(file) && markers.test(read(file)));
  assert.deepEqual(offenders, []);
  // The member selects are allowlists that do not name them.
  const store = read("src/modules/organizationMembers/infrastructure/mongoMembershipStore.ts");
  assert.match(store, /const MEMBER_FIELDS = "userId roles status version lastSignedInAt createdAt";/);
  assert.match(read("middleware/auth.ts"), /\.select\("roles version status sessionRevocationPending"\)/);
  // The session repository returns the reason only to the session manager; the session list does not carry it.
  const repository = read("src/modules/auth/infrastructure/mongo/mongoRefreshSessionRepository.ts");
  assert.equal((repository.match(/revokeReason: token\.revokeReason/g) ?? []).length, 1);
  assert.doesNotMatch(repository.slice(repository.indexOf("async listActive")), /revokeReason/);

  // The staff-side action is staff-only by name and is not in the customer catalog.
  assert.equal(STAFF_SESSIONS_REVOKED_ACTION, "platform.organization_member.sessions_revoked");
  assert.equal(isStaffOnlyAction(STAFF_SESSIONS_REVOKED_ACTION), true);
  assert.equal(catalogEntry(STAFF_SESSIONS_REVOKED_ACTION), undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(AUDIT_CATALOG, STAFF_SESSIONS_REVOKED_ACTION), false);
  assert.equal(VISIBLE_ACTIONS.includes(STAFF_SESSIONS_REVOKED_ACTION), false);
});

test("the access path asks the composition, which sends a membership with no staff cause to the customer flow unchanged", () => {
  const middleware = read("middleware/auth.ts");
  assert.match(middleware, /revokeInactiveMembership: \(input\) => revokeInactiveMembershipSessions\(input\),/);
  assert.match(middleware, /revokeOtherSessionsAfterRoleChange: \(input\) => revokeOtherSessionsAfterMembershipChange\(input\),/);
  const composition = read("src/modules/auth/composition.ts");
  assert.match(composition, /onRequestWithPendingRevocation: \(input\) => membershipSessions\.onRequestWithPendingRevocation\(input\),/);
  assert.match(composition, /revokeInactiveMembership: \(input\) => authenticationSessions\.revokeInactiveMembership\(input\),/);
  // The auth module does not depend on the staff module.
  for (const file of ["src/modules/auth/composition.ts", "src/modules/auth/application/staffCausedSessionRevocation.ts", "src/modules/auth/application/manageSessions.ts"]) {
    assert.doesNotMatch(read(file), /from "[^"]*staffAccess/, file);
  }
});

// ── A failed marker read never skips a revocation ────────────────────────────────────────────

const captureErrors = async (work) => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try { return { value: await work(), logged }; } finally { console.error = original; }
};
const readDown = async () => { throw new Error("membership read down"); };

test("refresh, the reason read throws: the family is still revoked, the answer is membership_inactive as before, and nothing is written in the member's organization, then or on the next refresh", async () => {
  let inactive = false;
  const store = sessionStore({ inactive: () => inactive, inactiveMembershipReason: readDown });
  const session = await begin(store);
  inactive = true;
  const { value, logged } = await captureErrors(() => store.manager.rotate({ refreshToken: session.refreshToken, correlationId: "c-1" }));
  // The same result kind as when the read succeeds (see the trace 1 deactivation test).
  assert.deepEqual(value, { kind: "membership_inactive" });
  assert.deepEqual(store.calls.filter(([name]) => name === "revokeFamily"), [["revokeFamily", store.records[0].familyId, STAFF_MEMBERSHIP_REVOKE_REASON]]);
  assert.deepEqual([store.records[0].status, store.records[0].revokeReason], ["revoked", STAFF_MEMBERSHIP_REVOKE_REASON]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /could not be read: membership read down/);
  // The cause is unknown, so the non-audited reason is used: the next refresh is refused and writes nothing.
  assert.deepEqual(await store.manager.rotate({ refreshToken: session.refreshToken, correlationId: "c-2" }), { kind: "reuse_detected" });
  assert.deepEqual(store.audit.map((e) => e.action), ["auth.session.created"]);
});

test("refresh handoff retry, the reason read throws: the family is still revoked and the answer is membership_inactive", async () => {
  let inactive = false;
  const store = sessionStore({ inactive: () => inactive, inactiveMembershipReason: readDown });
  const session = await begin(store);
  assert.equal((await store.manager.rotate({ refreshToken: session.refreshToken, rotationKey: KEY, correlationId: "c-rotate" })).kind, "rotated");
  // The response is lost, the member is deactivated, the client retries the same token and key.
  inactive = true;
  const { value, logged } = await captureErrors(() => store.manager.rotate({ refreshToken: session.refreshToken, rotationKey: KEY, correlationId: "c-retry" }));
  assert.deepEqual(value, { kind: "membership_inactive" });
  assert.deepEqual([store.records[0].status, store.records[0].revokeReason], ["revoked", STAFF_MEMBERSHIP_REVOKE_REASON]);
  assert.equal(logged.length, 1);
  assert.deepEqual(store.audit.map((e) => e.action), ["auth.session.created", "auth.refresh.rotated"]);
});

test("access path, the deactivation-cause read throws: every session is still revoked, the call resolves, and no event is written in the member's organization or on the staff side", async () => {
  const { store, staffEvents } = accessPath();
  await begin(store);
  await begin(store);
  const failing = createStaffCausedSessionRevocation({
    pendingCause: async () => null,
    suspensionCause: readDown,
    customer: {
      onRequestWithPendingRevocation: async () => { throw new Error("not this path"); },
      revokeInactiveMembership: (input) => store.manager.revokeInactiveMembership(input),
    },
    revokeSessions: (input) => store.sessions.revokeAll({ ...input, reason: STAFF_MEMBERSHIP_REVOKE_REASON, now: NOW }),
    staffClaims: { claimRevocationPending: async () => false, completeRevocationPending: async () => undefined, releaseRevocationClaim: async () => undefined },
    audit: { append: async (event) => { staffEvents.push(event); } },
    isValidId: () => true,
  });
  const { value, logged } = await captureErrors(() => failing.revokeInactiveMembershipSessions({ userId: MEMBER, organizationId: ORG, correlationId: "c-req" }));
  assert.equal(value, 2);
  assert.deepEqual(statuses(store), [["revoked", STAFF_MEMBERSHIP_REVOKE_REASON], ["revoked", STAFF_MEMBERSHIP_REVOKE_REASON]]);
  assert.deepEqual(store.audit.filter((e) => e.action !== "auth.session.created"), []);
  assert.deepEqual(staffEvents, []);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /could not be read: membership read down/);
  // An account awaiting placement never reads the marker, so it is the customer flow as before.
  await begin(store);
  assert.equal(await failing.revokeInactiveMembershipSessions({ userId: MEMBER, organizationId: ORG, correlationId: "c", reason: "organization_setup_required" }), 1);
  assert.deepEqual(store.audit.filter((e) => e.action === "auth.sessions.revoked_all").map((e) => e.reason), ["organization_setup_required"]);
});

test("middleware, the deactivation-cause read throws: the request is answered 401 MEMBERSHIP_INACTIVE, the same as when the read succeeds, with the sessions revoked", async () => {
  const { createAuthenticate } = require("../middleware/auth");
  const Organization = require("../modal/organizationModel").default;
  const OrganizationMembership = require("../modal/organizationMembershipModel").default;
  const RefreshSession = require("../modal/refreshSessionModel").default;
  const loader = require("../src/modules/auth/infrastructure/mongo/mongoSessionAccountLoader");
  const query = (row) => ({ select: () => ({ lean: async () => row }) });
  const originals = [[Organization, "findOne", Organization.findOne], [OrganizationMembership, "findOne", OrganizationMembership.findOne], [RefreshSession, "exists", RefreshSession.exists], [loader, "findSessionPrincipal", loader.findSessionPrincipal]];
  Organization.findOne = () => query({ _id: ORG, kind: "customer" });
  OrganizationMembership.findOne = () => query({ roles: ["planner"], version: 3, status: "suspended" });
  RefreshSession.exists = async () => ({ _id: "s" });
  loader.findSessionPrincipal = async () => ({ accountType: "planner", email: "m@example.test", role: "customer" });
  try {
    const run = async (suspensionCause) => {
      const store = sessionStore();
      const session = await begin(store);
      const access = createStaffCausedSessionRevocation({
        pendingCause: async () => null,
        suspensionCause,
        customer: { onRequestWithPendingRevocation: async () => 0, revokeInactiveMembership: (input) => store.manager.revokeInactiveMembership(input) },
        revokeSessions: (input) => store.sessions.revokeAll({ ...input, reason: STAFF_MEMBERSHIP_REVOKE_REASON, now: NOW }),
        staffClaims: { claimRevocationPending: async () => false, completeRevocationPending: async () => undefined, releaseRevocationClaim: async () => undefined },
        audit: { append: async () => undefined },
        isValidId: () => true,
      });
      const authenticate = createAuthenticate(
        () => ({ userId: MEMBER, organizationId: ORG, sessionId: session.sessionId }),
        { revokeInactiveMembership: (input) => access.revokeInactiveMembershipSessions(input), revokeOtherSessionsAfterRoleChange: async () => 0, actorLookups: {} },
      );
      const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      const { logged } = await captureErrors(() => authenticate({ headers: { authorization: "Bearer t" }, correlationId: "c-req" }, res, () => { throw new Error("must not pass"); }));
      return { store, res, logged };
    };
    const succeeded = await run(async () => STAFF_CAUSE);
    const failed = await run(readDown);
    assert.equal(succeeded.res.statusCode, 401);
    assert.equal(succeeded.res.body.code, "MEMBERSHIP_INACTIVE");
    assert.deepEqual([failed.res.statusCode, failed.res.body], [succeeded.res.statusCode, succeeded.res.body]);
    assert.deepEqual(statuses(failed.store), [["revoked", STAFF_MEMBERSHIP_REVOKE_REASON]]);
    assert.deepEqual(failed.store.audit.map((e) => e.action), ["auth.session.created"]);
    assert.equal(failed.logged.length, 1);
  } finally {
    for (const [target, name, value] of originals) target[name] = value;
  }
});
