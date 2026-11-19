require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DelayedError } = require("bullmq");
const { createSessionManager, hashOpaqueToken } = require("../src/modules/auth/application/manageSessions");
const { STAFF_MEMBERSHIP_REVOKE_REASON, isStaffCausedRevokeReason } = require("../src/modules/auth/domain/ports/sessionPorts");
const { ORGANIZATION_BLOCK_REVOKE_REASON, ORGANIZATION_BLOCKED, OrganizationBlockedError } = require("../src/modules/organizationBlock/domain");
const { createPublicAccessManager, hashPublicGrant } = require("../src/modules/publicAccess/application/managePublicAccess");
const { createTrackEmailOpen, createTrackProposalClick, createTrackVendorResponseClick } = require("../src/modules/email/application/trackEmailEngagement");
const { createInvitationService } = require("../src/modules/invitations/application/manageInvitations");
const { createInvitationSweep } = require("../src/modules/invitations/application/sweepInvitations");
const { generateInvitationToken, hashInvitationToken } = require("../src/modules/invitations/domain/invitationRules");
const { createFederatedSignIn } = require("../src/modules/sso/application/federatedSignIn");
const { createMemorySsoStateStore } = require("../src/modules/sso/infrastructure/ssoStateStore");
const { microsoftIssuerFor } = require("../src/modules/sso/domain/ssoRules");
const { createSupportDeskSweeper } = require("../src/modules/supportDesk/application/supportDeskSweeper");
const { createDomainVerification } = require("../src/modules/domainVerification/application/manageDomains");
const { createVendorSubmissionDraftService } = require("../src/modules/vendorResponses/application/vendorSubmissionDrafts");
const { createOrganizationBlockDeferral, BLOCKED_JOB_DEFER_MS, LOOKUP_FAILED_DEFER_MS } = require("../src/modules/durableJobs/organizationBlockDeferral");

// Owner decision 2026-11-18 (docs/DECISIONS.md): a block closes everything for the organization.
// One test (or more) per enforcement point. Each runs the real code of that point over in-memory
// ports with a gate that says organization A is blocked and B is not, and checks three things:
// A is refused with the answer that point is meant to give, B is untouched, and nothing is
// written for A. tests/organization-block-guard.test.js proves no surface is missing.

const hex = (c) => c.repeat(24);
const A = hex("a"); // blocked
const B = hex("b"); // not blocked
const USER = hex("1");
const NOW = new Date("2026-11-19T10:00:00Z");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const gate = (blocked = new Set([A])) => {
  const asked = [];
  const isBlocked = async (organizationId) => { asked.push(organizationId); return blocked.has(organizationId); };
  return { isBlocked, asked, blocked };
};
const down = async () => { throw new Error("mongo down"); };

// ── Sessions: refresh, reuse, begin ─────────────────────────────────────────────────────────

const sessionWorld = (organizationBlocked) => {
  const rows = [];
  const audit = [];
  const sessions = {
    async create(input) { rows.push({ id: `row-${rows.length}`, ...input, status: "active", revokeReason: null, rotationCount: 0, consumed: [] }); },
    async findByTokenHash(tokenHash) {
      const row = rows.find((r) => r.tokenHash === tokenHash || r.consumed.includes(tokenHash));
      return row ? { ...row } : null;
    },
    async rotateActive({ id, previousHash, tokenHash, tokenId }) {
      const row = rows.find((r) => r.id === id && r.tokenHash === previousHash && r.status === "active");
      if (!row) return false;
      row.consumed.push(previousHash); row.tokenHash = tokenHash; row.tokenId = tokenId; row.rotationCount++;
      return true;
    },
    async revokeFamily({ familyId, reason }) {
      let n = 0;
      for (const r of rows) if (r.familyId === familyId && r.status !== "revoked") { r.status = "revoked"; r.revokeReason = reason; n++; }
      return n;
    },
    async revokeSession() { return 0; },
    async revokeAll({ userId, organizationId, reason }) {
      let n = 0;
      for (const r of rows) if (r.userId === userId && r.organizationId === organizationId && r.status !== "revoked") { r.status = "revoked"; r.revokeReason = reason; n++; }
      return n;
    },
    async listActive() { return []; },
  };
  let token = 0;
  const manager = createSessionManager({
    sessions,
    accounts: { load: async (userId, organizationId) => ({ userId, accountType: "planner", email: "m@example.test", organizationId, role: "customer", roles: ["planner"], rolesVersion: 1 }) },
    accessTokens: { issue: () => ({ accessToken: "access", expiresAt: 1, expiresIn: 1 }) },
    audit: { append: async (event) => { audit.push(event); } },
    now: () => NOW,
    opaqueToken: () => `refresh-${token++}`,
    organizationBlocked,
  });
  const begin = (organizationId) => manager.begin({ account: { userId: USER, accountType: "planner", email: "m@example.test", organizationId, role: "customer", roles: ["planner"], rolesVersion: 1 }, correlationId: "c-begin" });
  return { manager, rows, audit, begin };
};

test("refresh: a blocked organization's session is refused as organization_blocked, its family ends for the block's reason, and nothing is audited", async () => {
  const g = gate(new Set());
  const w = sessionWorld(g.isBlocked);
  const a = await w.begin(A);
  const b = await w.begin(B);
  const before = w.audit.length;
  g.blocked.add(A);
  assert.deepEqual(await w.manager.rotate({ refreshToken: a.refreshToken, correlationId: "c1" }), { kind: "organization_blocked" });
  assert.deepEqual(w.rows.map((r) => [r.organizationId, r.status, r.revokeReason]), [[A, "revoked", ORGANIZATION_BLOCK_REVOKE_REASON], [B, "active", null]]);
  assert.equal(w.audit.length, before, "no event in the customer organization");
  // The other organization refreshes as always.
  const rotated = await w.manager.rotate({ refreshToken: b.refreshToken, correlationId: "c2" });
  assert.equal(rotated.kind, "rotated");
  assert.deepEqual(w.audit.slice(before).map((e) => [e.organizationId, e.action]), [[B, "auth.refresh.rotated"]]);
});

test("refresh after the block ended the session: presenting its last token again is refused and writes no 'reuse detected' row, while blocked and after reactivation", async () => {
  const g = gate(new Set());
  const w = sessionWorld(g.isBlocked);
  const a = await w.begin(A);
  // What the block's transaction does to every session of the organization.
  for (const r of w.rows) { r.status = "revoked"; r.revokeReason = ORGANIZATION_BLOCK_REVOKE_REASON; }
  const before = w.audit.length;
  g.blocked.add(A);
  assert.deepEqual(await w.manager.rotate({ refreshToken: a.refreshToken, correlationId: "c1" }), { kind: "organization_blocked" });
  g.blocked.delete(A); // reactivated: ended sessions stay ended
  assert.deepEqual(await w.manager.rotate({ refreshToken: a.refreshToken, correlationId: "c2" }), { kind: "reuse_detected" });
  assert.deepEqual(await w.manager.rotate({ refreshToken: a.refreshToken, correlationId: "c3" }), { kind: "reuse_detected" });
  assert.equal(w.audit.length, before, "no auth.refresh.reuse_detected in the customer organization");
  assert.equal(w.rows[0].revokeReason, ORGANIZATION_BLOCK_REVOKE_REASON, "the reason is not overwritten");
  // A session revoked for any other reason still records reuse: the existing behaviour.
  const other = await w.begin(B);
  w.rows[1].status = "revoked"; w.rows[1].revokeReason = "user_logout";
  await w.manager.rotate({ refreshToken: other.refreshToken, correlationId: "c4" });
  assert.deepEqual(w.audit.slice(before + 1).map((e) => e.action), ["auth.refresh.reuse_detected"]);
});

test("refresh: a failed gate read rejects (the route answers a retryable 503) and revokes nothing; without a gate nothing is blocked", async () => {
  const w = sessionWorld(down);
  const a = await w.begin(A);
  await assert.rejects(() => w.manager.rotate({ refreshToken: a.refreshToken, correlationId: "c1" }), /mongo down/);
  assert.equal(w.rows[0].status, "active");
  const plain = sessionWorld(undefined);
  const session = await plain.begin(A);
  assert.equal((await plain.manager.rotate({ refreshToken: session.refreshToken, correlationId: "c1" })).kind, "rotated");
  assert.equal(isStaffCausedRevokeReason(ORGANIZATION_BLOCK_REVOKE_REASON), true);
  assert.equal(isStaffCausedRevokeReason(STAFF_MEMBERSHIP_REVOKE_REASON), true);
  for (const reason of ["user_logout", "refresh_reuse", "membership_inactive", null, undefined, ""]) assert.equal(isStaffCausedRevokeReason(reason), false);
  assert.equal(hashOpaqueToken("x").length, 64);
});

test("the refresh route answers 401 REFRESH_SESSION_EXPIRED with reason organization_blocked", () => {
  const controller = read("controller/authController.ts");
  assert.match(controller, /code: "REFRESH_SESSION_EXPIRED",\s+reason: result\.kind,/);
  assert.match(read("src/modules/auth/composition.ts"), /organizationBlocked: \(organizationId\) => organizationBlockGate\.isBlocked\(organizationId\),/);
});

test("every sign-in path: beginAuthenticatedSession asks the gate first and throws OrganizationBlockedError; the handlers answer 403 ORGANIZATION_BLOCKED", () => {
  const composition = read("src/modules/auth/composition.ts");
  const begin = composition.slice(composition.indexOf("export const beginAuthenticatedSession"), composition.indexOf("// ORG-307 hooks"));
  const gateAt = begin.indexOf("if (await organizationBlockGate.isBlocked(input.organizationId)) throw new OrganizationBlockedError();");
  assert.ok(gateAt > 0);
  for (const later of ["mongoSessionAccountLoader.load(", "provisionIdentityProjection(", "authenticationSessions.begin("]) {
    assert.ok(gateAt < begin.indexOf(later), `the gate is asked before ${later}`);
  }
  // Nothing else begins a session.
  const walk = (dir) => fs.readdirSync(path.join(__dirname, "..", dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(file);
    return /\.ts$/.test(entry.name) ? [file] : [];
  });
  const sources = ["src", "controller", "routes", "middleware", "utils"].flatMap(walk);
  assert.deepEqual(sources.filter((file) => /authenticationSessions\.begin\(|\bsessions\.begin\(/.test(read(file))), ["src/modules/auth/composition.ts"]);
  assert.deepEqual(sources.filter((file) => /beginAuthenticatedSession\(/.test(read(file)) && !file.endsWith("auth/composition.ts")), ["controller/authController.ts"]);
  const auth = read("controller/authController.ts");
  assert.equal((auth.match(/beginAuthenticatedSession\(/g) ?? []).length, 1, "createSession is the one caller");
  // The step before two-factor asks too, so no challenge is issued for a blocked organization.
  const step = auth.slice(auth.indexOf("export const respondWithSecondFactorStep"), auth.indexOf("twoFactor.assessSignIn("));
  assert.match(step, /if \(await organizationBlockGate\.isBlocked\(user\.organizationId\)\) \{\s+respondOrganizationBlocked\(res\);\s+return true;/);
  assert.match(auth, /res\.status\(403\)\.json\(\{\s+success: false,\s+code: ORGANIZATION_BLOCKED\.code,\s+errorCode: ORGANIZATION_BLOCKED\.code,\s+message: ORGANIZATION_BLOCKED\.message,/);
  // Every handler that calls createSession answers the error.
  for (const [file, count] of [["controller/authController.ts", 2], ["controller/twoFactorController.ts", 1], ["controller/ssoController.ts", 1], ["controller/invitationController.ts", 1]]) {
    assert.ok((read(file).match(/respondIfOrganizationBlocked\(res, error\)/g) ?? []).length >= count, file);
  }
  const error = new OrganizationBlockedError();
  assert.deepEqual([error.status, error.code, error.message], [403, ORGANIZATION_BLOCKED.code, ORGANIZATION_BLOCKED.message]);
});

// ── The access path ─────────────────────────────────────────────────────────────────────────

test("authenticate: a request for a blocked organization is 401 ORGANIZATION_BLOCKED, the member's sessions for it end, and no customer-side revocation runs", async () => {
  const { createAuthenticate } = require("../middleware/auth");
  const Organization = require("../modal/organizationModel").default;
  const OrganizationMembership = require("../modal/organizationMembershipModel").default;
  const RefreshSession = require("../modal/refreshSessionModel").default;
  const loader = require("../src/modules/auth/infrastructure/mongo/mongoSessionAccountLoader");
  const query = (row) => ({ select: () => ({ lean: async () => row }) });
  const originals = [[Organization, "findOne", Organization.findOne], [OrganizationMembership, "findOne", OrganizationMembership.findOne], [RefreshSession, "exists", RefreshSession.exists], [loader, "findSessionPrincipal", loader.findSessionPrincipal]];
  const world = { organization: null, membership: null };
  const selected = [];
  Organization.findOne = () => ({ select: (fields) => { selected.push(fields); return { lean: async () => world.organization }; } });
  OrganizationMembership.findOne = () => query(world.membership);
  RefreshSession.exists = async () => ({ _id: "s" });
  loader.findSessionPrincipal = async () => ({ accountType: "planner", email: "m@example.test", role: "customer" });
  const run = async (organization, membership, endSessions) => {
    world.organization = organization; world.membership = membership;
    const calls = [];
    const authenticate = createAuthenticate(
      () => ({ userId: USER, organizationId: A, sessionId: "sess-1" }),
      {
        revokeInactiveMembership: async (input) => { calls.push(["revokeInactiveMembership", input.reason ?? null]); return 1; },
        revokeOtherSessionsAfterRoleChange: async () => { calls.push(["revokeOthers"]); return 1; },
        actorLookups: {},
        ...(endSessions === null ? {} : { endSessionsOfBlockedOrganization: endSessions ?? (async (input) => { calls.push(["endSessions", input]); return 1; }) }),
      },
    );
    const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    let passed = false;
    await authenticate({ headers: { authorization: "Bearer t" }, correlationId: "c-req" }, res, () => { passed = true; });
    return { res, calls, passed };
  };
  const marker = { at: NOW, byStaffOrganizationId: hex("d"), byStaffAccountId: hex("7") };
  const active = { roles: ["owner"], version: 3, status: "active", sessionRevocationPending: true };
  const blocked = { _id: A, kind: "customer", blocked: marker };
  const expected = [401, { success: false, code: "ORGANIZATION_BLOCKED", message: ORGANIZATION_BLOCKED.message }];
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    // Whatever the member's role or state: the block is decided first.
    for (const membership of [active, { ...active, status: "suspended" }, null]) {
      const refused = await run(blocked, membership);
      assert.deepEqual([refused.res.statusCode, refused.res.body], expected);
      assert.equal(refused.passed, false);
      assert.deepEqual(refused.calls, [["endSessions", { userId: USER, organizationId: A }]], "only the block's own, unaudited revocation runs");
    }
    // The refusal stands when the sessions can't be ended, and when no such dependency is given.
    const failing = await run(blocked, active, async () => { throw new Error("mongo down"); });
    assert.deepEqual([failing.res.statusCode, failing.res.body], expected);
    assert.equal(logged.length, 1);
    const without = await run(blocked, active, null);
    assert.deepEqual([without.res.statusCode, without.res.body, without.calls], [...expected, []]);
    // Not blocked: every existing answer is what it was.
    for (const organization of [{ _id: A, kind: "customer" }, { _id: A, kind: "customer", blocked: null }, { _id: A, kind: "customer", blocked: { at: "2026-11-19" } }]) {
      const inactive = await run(organization, { ...active, status: "suspended" });
      assert.deepEqual([inactive.res.statusCode, inactive.res.body.code, inactive.calls], [401, "MEMBERSHIP_INACTIVE", [["revokeInactiveMembership", null]]]);
    }
    const holding = await run({ _id: A, kind: "legacy_holding" }, active);
    assert.deepEqual([holding.res.statusCode, holding.res.body.code], [401, "ORGANIZATION_SETUP_REQUIRED"]);
    const missing = await run(null, active);
    assert.deepEqual([missing.res.statusCode, missing.res.body.message], [403, "Organization is inactive or unavailable"]);
    assert.ok(selected.every((fields) => fields === "_id kind blocked"), "the marker rides on the read the request already makes");
  } finally {
    console.error = original;
    for (const [target, name, value] of originals) target[name] = value;
  }
  const source = read("middleware/auth.ts");
  assert.ok(source.indexOf("if (isOrganizationBlocked(organization))") < source.indexOf('if (!membership || membership.status !== "active")'), "decided before any customer-side revocation");
  // The unaudited revocation goes straight to the repository, for the block's reason.
  assert.match(read("src/modules/auth/composition.ts"), /export const endSessionsOfBlockedOrganization = \(input: \{ userId: string; organizationId: string \}\) =>\s+mongoRefreshSessionRepository\.revokeAll\(\{ userId: input\.userId, organizationId: input\.organizationId, reason: ORGANIZATION_BLOCK_REVOKE_REASON, now: new Date\(\) \}\);/);
});

// ── Public and token surfaces ───────────────────────────────────────────────────────────────

test("public and vendor links: a blocked organization's link answers as an unknown link and is not used; another organization's link works", async () => {
  const grants = { "tok-a": { organizationId: A, resourceId: "p-a", useCount: 0 }, "tok-b": { organizationId: B, resourceId: "p-b", useCount: 0 } };
  const byHash = (hash) => Object.entries(grants).find(([token]) => hashPublicGrant(token) === hash)?.[1] ?? null;
  const repository = {
    async organizationOf(hash) { return byHash(hash)?.organizationId ?? null; },
    async consume(hash, purpose, resourceId) {
      const grant = byHash(hash);
      if (!grant || grant.resourceId !== resourceId) return null;
      grant.useCount++;
      return { id: "g", ...grant, purpose };
    },
  };
  const g = gate();
  const manager = createPublicAccessManager(repository, undefined, g.isBlocked);
  for (const purpose of ["proposal:view", "vendor:submit"]) {
    const input = { purpose, recipient: "vendor@example.test", allowAlternateVendorContact: true };
    assert.equal(await manager.validateAndConsume({ ...input, token: "tok-a", resourceId: "p-a" }), null);
    assert.equal(await manager.validateAndConsume({ ...input, token: "unknown", resourceId: "p-a" }), null, "the same answer as a link that does not exist");
    assert.equal((await manager.validateAndConsume({ ...input, token: "tok-b", resourceId: "p-b" })).organizationId, B);
  }
  assert.equal(grants["tok-a"].useCount, 0, "no use is counted while blocked");
  assert.equal(grants["tok-b"].useCount, 2);
  g.blocked.delete(A);
  assert.equal((await manager.validateAndConsume({ token: "tok-a", purpose: "proposal:view", resourceId: "p-a" })).organizationId, A, "works again after reactivation");
  await assert.rejects(() => createPublicAccessManager(repository, undefined, down).validateAndConsume({ token: "tok-b", purpose: "proposal:view", resourceId: "p-b" }), /mongo down/);
  assert.equal(grants["tok-b"].useCount, 2, "a failed gate read uses no link");
  // The middleware answers both with one 403, and every public route goes through it.
  const middleware = read("middleware/publicAccess.ts");
  assert.match(middleware, /if \(!grant\) \{ res\.status\(403\)\.json\(\{ success: false, message: "Access grant is invalid, expired, revoked, or exhausted" \}\); return; \}/);
  assert.match(read("src/modules/publicAccess/composition.ts"), /\}, \(organizationId\) => organizationBlockGate\.isBlocked\(organizationId\)\);/);
  assert.match(read("src/modules/publicAccess/infrastructure/mongoPublicAccessRepository.ts"), /PublicAccessGrant\.findOne\(\{ tokenHash \}\)\.select\("organizationId"\)/);
});

test("invitation links: lookup, every accept and the token's organization answer INVITATION_INVALID for a blocked organization, before anything is read or accepted", async () => {
  const tokens = { a: generateInvitationToken(), b: generateInvitationToken() };
  const invitation = (organizationId) => ({ id: `inv-${organizationId[0]}`, organizationId, email: "new@example.test", role: "planner", teamId: null, invitedBy: USER, status: "pending", expiresAt: new Date(NOW.getTime() + 86_400_000) });
  const touched = [];
  const trap = (name) => new Proxy({}, { get: (_t, method) => async (...args) => { touched.push(`${name}.${String(method)}`); void args; return null; } });
  const g = gate();
  const service = createInvitationService({
    invitations: {
      async findByTokenHash(hash) {
        if (hash === hashInvitationToken(tokens.a)) return { invitation: invitation(A), current: true };
        if (hash === hashInvitationToken(tokens.b)) return { invitation: invitation(B), current: true };
        return null;
      },
    },
    invitees: trap("invitees"), organizations: trap("organizations"), teams: trap("teams"), acceptance: trap("acceptance"), credentials: trap("credentials"),
    passwords: trap("passwords"), dispatcher: trap("dispatcher"), audit: trap("audit"), quota: trap("quota"), google: trap("google"),
    randomSecret: () => "s", now: () => NOW,
    organizationBlocked: g.isBlocked,
  });
  const invalid = { kind: "refused", code: "INVITATION_INVALID" };
  assert.deepEqual(await service.lookup(tokens.a), invalid);
  assert.deepEqual(await service.lookup(generateInvitationToken()), invalid, "the same answer as a link that does not exist");
  assert.deepEqual(await service.acceptWithExistingAccount({ token: tokens.a, email: "new@example.test", password: "Correct-horse-9" }, "c"), invalid);
  assert.deepEqual(await service.acceptWithNewAccount({ token: tokens.a, name: "New", password: "Correct-horse-9" }, "c"), invalid);
  assert.deepEqual(await service.acceptWithGoogle({ token: tokens.a, idToken: "g" }, "c"), invalid);
  assert.deepEqual(await service.acceptWithVerifiedIdentity(tokens.a, { email: "new@example.test" }, "sso", "c"), invalid);
  assert.equal(await service.organizationOfToken(tokens.a), null);
  assert.deepEqual(touched, [], "nothing was read, accepted, audited or emailed for the blocked organization");
  assert.equal(await service.organizationOfToken(tokens.b), B);
  g.blocked.delete(A);
  assert.equal(await service.organizationOfToken(tokens.a), A, "the link works again after reactivation");
  assert.match(read("src/modules/invitations/composition.ts"), /organizationBlocked: \(organizationId\) => organizationBlockGate\.isBlocked\(organizationId\),/);
});

test("email tracking: an open or click on a blocked organization's email records nothing and answers as an unknown tracking id", async () => {
  const marks = [];
  const repository = {
    async organizationOf(trackingId) { return { ta: A, tb: B }[trackingId] ?? null; },
    async markOpenedOnce(input) { marks.push(["open", input.trackingId]); },
    async markProposalClickedOnce(input) { marks.push(["click", input.trackingId]); return input.trackingId === "unknown" ? null : { proposalSlug: "slug" }; },
    async markVendorResponseClickedOnce(input) { marks.push(["vendor", input.trackingId]); return input.trackingId === "unknown" ? null : { proposalSlug: "slug" }; },
  };
  const g = gate();
  const deps = { repository, frontendBaseUrl: "https://app.example", organizationBlocked: g.isBlocked, now: () => NOW };
  const open = createTrackEmailOpen(deps);
  const click = createTrackProposalClick(deps);
  const vendor = createTrackVendorResponseClick(deps);
  const fallback = "https://app.example/proposal-view/x?accessGrant=abc";
  await open("ta");
  assert.equal(await click({ trackingId: "ta", fallbackRedirect: fallback }), await click({ trackingId: "unknown", fallbackRedirect: fallback }));
  assert.equal(await vendor({ trackingId: "ta", fallbackRedirect: fallback }), await vendor({ trackingId: "unknown", fallbackRedirect: fallback }));
  assert.equal(await click({ trackingId: "ta" }), "https://app.example");
  assert.deepEqual(marks.filter(([, id]) => id === "ta"), [], "nothing recorded for the blocked organization");
  await open("tb");
  assert.match(await click({ trackingId: "tb", fallbackRedirect: fallback }), /\/proposal-view\/slug\?source=email&accessGrant=abc$/);
  assert.match(await vendor({ trackingId: "tb" }), /\/vendor-response\/slug\?source=email&tid=tb$/);
  assert.deepEqual(marks.filter(([, id]) => id === "tb").map(([kind]) => kind), ["open", "click", "vendor"]);
  assert.equal((read("src/modules/email/composition.ts").match(/^ {2}organizationBlocked,$/gm) ?? []).length, 3);
});

test("domain matching: a blocked organization is offered to nobody (access request, auto-approve, signup match), by the one rule", () => {
  const source = read("src/modules/accessRequests/accessRequests.ts");
  const matcher = source.slice(source.indexOf("export const organizationForEmailDomain"), source.indexOf("export type AccessRequestView"));
  assert.match(matcher, /\.select\("_id name autoApproveDomain blocked"\)/);
  assert.match(matcher, /if \(isOrganizationBlocked\(verified\)\) return null;\s+if \(verified\) \{/);
  assert.match(matcher, /\.select\("_id name blocked"\)/);
  assert.match(matcher, /if \(!organization \|\| isOrganizationBlocked\(organization\)\) return null;/);
  // Every caller that could land someone in an organization by its domain uses this one function.
  assert.match(source, /const organization = await organizationForEmailDomain\(email\);\s+if \(!organization\) return \{ kind: "no_match" \};/);
  assert.match(read("controller/accessRequestController.ts"), /if \(outcome\.kind === "no_match"\) return fail\(res, 409, "NO_ORGANIZATION_MATCH"/);
});

// ── Company and Microsoft sign-in ───────────────────────────────────────────────────────────

const ISSUER = "https://idp.acme.example";
const TENANT = "11111111-2222-3333-4444-555555555555";
const BIND_HASH = crypto.createHash("sha256").update("browser-bind-cookie-value-0123456789").digest("hex");
const ssoHarness = (organizationBlocked) => {
  const connection = { id: "conn1", organizationId: A, issuer: ISSUER, clientId: "client", clientSecret: "secret", domains: ["acme.example"] };
  const state = { claims: { iss: ISSUER, sub: "sub-1", email: "new@acme.example", name: "New Person" }, users: [], joined: [], links: [], audits: [], accepted: [], memberships: new Map() };
  const metadata = (issuer) => ({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
  const signIn = createFederatedSignIn({
    store: createMemorySsoStateStore(),
    oidc: {
      async discover(issuer, expected) { return metadata(expected ?? issuer); },
      authorizationUrl(meta, input) { const url = new URL(meta.authorization_endpoint); url.searchParams.set("state", input.state); return url.toString(); },
      async exchangeCode() { return "id-token"; },
      async verifyIdToken() { return state.claims; },
    },
    microsoft: () => ({ clientId: "ms-client", clientSecret: "ms-secret" }),
    redirectUri: () => "http://localhost:8000/api/auth/sso/callback",
    connections: {
      async activeForDomain(domain) { return connection.domains.includes(domain) ? connection : null; },
      async activeById(id) { return id === connection.id ? connection : null; },
      async organizationVerifiedDomains() { return ["acme.example"]; },
    },
    accounts: {
      async findByIdentity() { return null; },
      async findByEmail(email) { return state.users.find((u) => u.email === email) ?? null; },
      async link(userId) { state.links.push(userId); },
      async createOwner() { return { userId: "owner-new", organizationId: "org-new" }; },
      async joinOrganization(organizationId, person) { state.joined.push([organizationId, person.email]); return { userId: "joined-1" }; },
      async membership(organizationId, userId) { return state.memberships.get(`${organizationId}:${userId}`) ?? null; },
      async addMembership(organizationId, userId, role) { state.memberships.set(`${organizationId}:${userId}`, { status: "active", roles: [role] }); },
    },
    async ssoRequiredFor() { return false; },
    invitations: {
      async organizationOf() { return A; },
      async acceptWithPerson(token) { state.accepted.push(token); return { kind: "refused", code: "INVITATION_INVALID" }; },
    },
    async audit(event) { state.audits.push(event); },
    organizationBlocked,
  });
  const roundTrip = async (startInput) => {
    const started = await signIn.start({ bind: BIND_HASH, ...startInput });
    assert.equal(started.kind, "redirect", JSON.stringify(started));
    return signIn.callback({ code: "auth-code", state: new URL(started.url).searchParams.get("state") }, "corr-1");
  };
  return { signIn, state, roundTrip };
};

test("company sign-in: start is unchanged by a block; the callback refuses with ORGANIZATION_BLOCKED before any account is joined, linked or audited", async () => {
  const g = gate();
  const h = ssoHarness(g.isBlocked);
  const started = await h.signIn.start({ kind: "company", email: "new@acme.example", bind: BIND_HASH });
  assert.equal(started.kind, "redirect", "start answers anyone who types an email, so it does not change");
  assert.deepEqual(g.asked, [], "start does not even ask");
  assert.deepEqual(await h.roundTrip({ kind: "company", email: "new@acme.example" }), { kind: "error", code: "ORGANIZATION_BLOCKED", inviteToken: null });
  h.state.users.push({ userId: "u1", email: "new@acme.example", organizationId: A, isBlocked: false, identities: [] });
  assert.deepEqual(await h.roundTrip({ kind: "company", email: "new@acme.example" }), { kind: "error", code: "ORGANIZATION_BLOCKED", inviteToken: null });
  assert.deepEqual([h.state.joined, h.state.links, h.state.audits, [...h.state.memberships]], [[], [], [], []]);
  // With an invitation the invitation service answers, with what an unknown link gets.
  const invite = "A".repeat(43);
  assert.deepEqual(await h.roundTrip({ kind: "company", email: "new@acme.example", invite }), { kind: "error", code: "INVITATION_INVALID", inviteToken: invite });
  // Reactivated: the same round trip signs the member in.
  g.blocked.delete(A);
  assert.equal((await h.roundTrip({ kind: "company", email: "new@acme.example" })).kind, "handoff");
});

test("Microsoft sign-in: an existing account of a blocked organization gets no handoff; an account of another organization does", async () => {
  const g = gate();
  const h = ssoHarness(g.isBlocked);
  h.state.claims = { iss: microsoftIssuerFor(TENANT), sub: "s", tid: TENANT, oid: "o1", email: "pat@fabrikam.example", xms_edov: true };
  h.state.users.push({ userId: "u1", email: "pat@fabrikam.example", organizationId: A, isBlocked: false, identities: [] });
  assert.deepEqual(await h.roundTrip({ kind: "microsoft" }), { kind: "error", code: "ORGANIZATION_BLOCKED", inviteToken: null });
  h.state.users[0].organizationId = B;
  assert.equal((await h.roundTrip({ kind: "microsoft" })).kind, "handoff");
  assert.deepEqual(h.state.audits, []);
  assert.match(read("src/modules/sso/composition.ts"), /organizationBlocked: \(organizationId\) => organizationBlockGate\.isBlocked\(organizationId\),/);
  // The discover endpoint is not touched by the block: one bit per domain, as before.
  assert.doesNotMatch(read("src/modules/sso/application/discoverSignInMethod.ts"), /[Bb]locked/);
});

test("the notification socket refuses a session of a blocked organization", () => {
  assert.match(read("utils/notificationService.ts"), /if \(!activeSession \|\| \(await organizationBlockGate\.isBlocked\(payload\.organizationId\)\)\) \{\s+socket\.write\("HTTP\/1\.1 401 Unauthorized/);
});

// ── Background work ─────────────────────────────────────────────────────────────────────────

test("durable jobs: a job of a blocked organization is deferred, not run, not claimed and not failed; another organization's job runs", async () => {
  const g = gate();
  const defer = createOrganizationBlockDeferral(g.isBlocked, () => 1_000);
  const job = (organizationMongoId) => {
    const moves = [];
    return { moves, data: { jobId: "j1", jobType: "proposal_draft_generate", organizationMongoId, correlationId: "c" }, async moveToDelayed(timestamp, token) { moves.push([timestamp, token]); } };
  };
  const blocked = job(A);
  await assert.rejects(() => defer(blocked, "lock-token"), (error) => error instanceof DelayedError);
  assert.deepEqual(blocked.moves, [[1_000 + BLOCKED_JOB_DEFER_MS, "lock-token"]]);
  const open = job(B);
  assert.equal(await defer(open, "lock-token"), undefined);
  assert.deepEqual(open.moves, []);
  // The gate can't be read: deferred for a short time, never run on a guess and never failed.
  const unknown = job(B);
  await assert.rejects(() => createOrganizationBlockDeferral(down, () => 1_000)(unknown, "t"), (error) => error instanceof DelayedError);
  assert.deepEqual(unknown.moves, [[1_000 + LOOKUP_FAILED_DEFER_MS, "t"]]);
  // Reactivated: the same job runs at its next turn.
  g.blocked.delete(A);
  assert.equal(await defer(job(A), "t"), undefined);
  // Both workers ask before the job is claimed, and BullMQ's manual delay skips the attempt.
  for (const file of ["src/modules/durableJobs/worker.ts", "src/modules/durableJobs/aiGatewayWorker.ts"]) {
    const source = read(file);
    const at = source.indexOf("await deferJobOfBlockedOrganization(job");
    assert.ok(at > 0 && at < source.indexOf("repository.claim("), `${file}: asked before the claim`);
  }
  assert.match(fs.readFileSync(require.resolve("bullmq/dist/cjs/classes/job.js"), "utf8"), /async moveToDelayed\(timestamp, token\) \{[\s\S]{0,300}skipAttempt: true/);
  // The workers connect to MongoDB, which the gate reads.
  assert.match(read("scripts/startDurableWorker.ts"), /\n await connectDB\(\);/);
  assert.match(read("scripts/startAiGatewayWorker.ts"), /connectDB\(\)/);
});

test("invitation sweep: a blocked organization's invitations are not expired, reminded or emailed; the others are", async () => {
  const calls = [];
  const sweep = createInvitationSweep({
    sweeps: {
      async markExpired(now, except) { calls.push(["markExpired", except]); return 2; },
      async queueReminders(input) { calls.push(["queueReminders", input.exceptOrganizationIds]); return ["i1"]; },
      async dueDeliveries(input) { calls.push(["dueDeliveries", input.exceptOrganizationIds]); return ["i2"]; },
    },
    dispatcher: { dispatch: async () => "sent" },
    blockedOrganizationIds: async () => new Set([A]),
    now: () => NOW,
  });
  assert.deepEqual(await sweep(), { expired: 2, remindersQueued: 1, sent: 2, failed: 0, skipped: 0 });
  assert.deepEqual(calls, [["markExpired", [A]], ["queueReminders", [A]], ["dueDeliveries", [A]]]);
  // The blocked set can't be read: the pass fails before anything is expired or sent.
  const untouched = [];
  const failing = createInvitationSweep({
    sweeps: { markExpired: async () => { untouched.push(1); return 0; }, queueReminders: async () => [], dueDeliveries: async () => [] },
    dispatcher: { dispatch: async () => "sent" },
    blockedOrganizationIds: down,
  });
  await assert.rejects(() => failing(), /mongo down/);
  assert.deepEqual(untouched, []);
  const repository = read("src/modules/invitations/infrastructure/mongoInvitationSweepRepository.ts");
  assert.match(repository, /organizationId: \{ \$nin: organizationIds\.map\(/);
  assert.equal((repository.match(/\.\.\.except\(exceptOrganizationIds\)/g) ?? []).length, 3, "all three queries leave them out");
  assert.match(read("src/modules/invitations/composition.ts"), /createInvitationSweep\(\{ sweeps: mongoInvitationSweepRepository, dispatcher, blockedOrganizationIds, now: overrides\.now \}\)/);
});

test("support desk sweep: no automatic reminder, resolve or close for a blocked organization's ticket; the staff escalation still fires", async () => {
  const ticket = (id, organizationId) => ({ id, ticketNumber: 1, organizationId, requesterUserId: USER, assigneeUserId: null, subject: "Help", priority: "normal", status: "open", unreadForRequester: 0, lastCustomerMessageAt: NOW.toISOString(), createdAt: NOW.toISOString() });
  const updates = [];
  const messages = [];
  const events = [];
  const sweeper = createSupportDeskSweeper({
    repository: {
      async backfillServiceLevels() { return 0; },
      async listUnansweredSince() { return [ticket("esc-a", A), ticket("esc-b", B)]; },
      async listNeedingCloseReminder() { return [ticket("rem-a", A), ticket("rem-b", B)]; },
      async listDueToAutoResolve() { return [ticket("res-a", A), ticket("res-b", B)]; },
      async listResolvedBefore() { return [ticket("clo-a", A), ticket("clo-b", B)]; },
      async updateTicket(organizationId, id, patch) { updates.push(id); return { ...ticket(id, organizationId), ...patch }; },
      async appendMessage(input) { messages.push(input.ticketId); return { id: "m", ...input }; },
      async findTicketPeople() { return new Map(); },
    },
    notifier: {
      async ticketEscalated(input) { events.push(["escalated", input.ticket.id]); },
      async autoCloseReminder(input) { events.push(["reminder", input.ticket.id]); },
      async autoResolved(input) { events.push(["resolved", input.ticket.id]); },
    },
    clock: () => NOW,
    blockedOrganizationIds: async () => new Set([A]),
  });
  const result = await sweeper.run();
  assert.deepEqual([result.escalated, result.reminded, result.resolved, result.closed, result.failed], [2, 1, 1, 1, 0]);
  assert.deepEqual(messages, ["rem-b", "res-b", "clo-b"], "no message is written into the blocked organization's tickets");
  assert.deepEqual(events, [["escalated", "esc-a"], ["escalated", "esc-b"], ["reminder", "rem-b"], ["resolved", "res-b"]]);
  assert.deepEqual(updates.filter((id) => id.endsWith("-a")), ["esc-a"]);
  assert.match(read("src/modules/supportDesk/composition.ts"), /createSupportDeskSweeper\(\{\s+blockedOrganizationIds,/);
});

test("domain verification sweep: a blocked organization's domains are not re-checked, so none is un-verified", async () => {
  const claimed = [];
  const verification = createDomainVerification({
    domains: {
      async due() { return [{ id: "d-a", organizationId: A, domain: "a.example" }, { id: "d-b", organizationId: B, domain: "b.example" }]; },
      async claimDue(input) { claimed.push(input.id); return false; },
    },
    resolver: {}, adminEmails: {}, audit: { append: async () => undefined },
    blockedOrganizationIds: async () => new Set([A]),
    now: () => NOW,
  });
  await verification.sweep({ limit: 10 });
  assert.deepEqual(claimed, ["d-b"]);
  assert.match(read("src/modules/domainVerification/composition.ts"), /createDomainVerification\(\{\s+blockedOrganizationIds,/);
});

test("vendor draft cleanup: an expired draft of a blocked organization is neither abandoned nor has its documents deleted", async () => {
  const abandoned = [];
  const service = createVendorSubmissionDraftService({
    repository: {
      async listCleanupCandidates() { return [{ draftId: "dr-a", organizationId: A, status: "active", documents: [] }, { draftId: "dr-b", organizationId: B, status: "active", documents: [] }]; },
      async markExpiredAbandoned(draftId) { abandoned.push(draftId); return false; },
    },
    storage: {}, malwareScan: {}, folderName: "rfp-tool", now: () => NOW,
    blockedOrganizationIds: async () => new Set([A]),
  });
  await service.cleanupExpired(10);
  assert.deepEqual(abandoned, ["dr-b"]);
  assert.match(read("src/modules/vendorResponses/composition.ts"), /createVendorSubmissionDraftService\(\{\s+blockedOrganizationIds,/);
});

test("maintenance crons: expiry and the archive purge skip a blocked organization; the retention sweep enumerates only organizations that are not blocked", () => {
  const cron = read("utils/cronJobs.ts");
  const expiry = cron.slice(cron.indexOf("export const runExpirationCheck"), cron.indexOf("export const purgeArchivedProposals"));
  assert.match(expiry, /const blocked = await blockedOrganizationIds\(\);/);
  assert.match(expiry, /for \(const proposal of activeProposals\) \{\s+\/\/[^\n]*\n\s+if \(proposal\.organizationId && blocked\.has\(String\(proposal\.organizationId\)\)\) continue;/);
  const purge = cron.slice(cron.indexOf("export const purgeArchivedProposals"), cron.indexOf("const runRetentionSweep"));
  assert.ok(purge.indexOf("const blocked = await blockedOrganizationIds();") < purge.indexOf("purgeProposalArtifacts("), "decided before anything is deleted");
  assert.match(purge, /\.filter\(\(doc\) => !blocked\.has\(String\(doc\.organizationId \?\? ""\)\)\);/);
  assert.ok(purge.indexOf(".filter((doc) => !blocked.has(") < purge.indexOf("Proposal.deleteMany("));
  const retention = read("src/modules/dataFoundation/retentionSweeper.ts");
  assert.match(retention, /Organization\.find\(\{ status: "active" \}\)\.select\("_id blocked"\)/);
  assert.match(retention, /tenants\.filter\(\(row\) => !isOrganizationBlocked\(row\)\)\.map\(\(row\) => String\(row\._id\)\);/);
  // The sweep's set is built by the one rule.
  const gateSource = read("src/modules/organizationBlock/organizationBlockGate.ts");
  assert.match(gateSource, /new Set\(rows\.filter\(isOrganizationBlocked\)\.map\(\(row\) => String\(row\._id\)\)\);/);
});
