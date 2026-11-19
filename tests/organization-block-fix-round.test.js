require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startWorkerWithMongo, startupFailureLine, WorkerStartupError } = require("../src/modules/durableJobs/workerStartup");

// Fix round on the staff organization block (PR #151, security review). One section per finding.

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

// ---------------------------------------------------------------- F1: workers and MongoDB

test("F1 worker start-up: the BullMQ worker is created only after MongoDB is connected", async () => {
  const order = [];
  let connected;
  const connect = () => new Promise((resolve) => { connected = () => { order.push("connected"); resolve(); }; });
  const starting = startWorkerWithMongo({ name: "AI gateway worker", connect, createWorker: () => { order.push("worker"); return "worker"; }, env: { MONGODB_URL: "mongodb://x" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], "no worker while MongoDB is still connecting");
  connected();
  assert.equal(await starting, "worker");
  assert.deepEqual(order, ["connected", "worker"]);
});

test("F1 worker start-up: a missing MONGODB_URL fails with one line naming the cause; nothing connects and no worker is created", async () => {
  let touched = 0;
  const error = await startWorkerWithMongo({ name: "Durable worker", connect: async () => { touched += 1; }, createWorker: () => { touched += 1; }, env: {} }).catch((e) => e);
  assert.ok(error instanceof WorkerStartupError);
  assert.equal(touched, 0);
  const line = startupFailureLine(error);
  assert.match(line, /^Durable worker cannot start: MongoDB is required .* MONGODB_URL is not set\.$/);
  assert.ok(!line.includes("\n"));
});

test("F1 worker start-up: an unreachable MongoDB fails with one line naming the cause, without the connection string; no worker is created", async () => {
  let created = 0;
  const connect = async () => { throw new Error("getaddrinfo ENOTFOUND db.internal\n  at mongodb+srv://user:secret@db.internal/x"); };
  const error = await startWorkerWithMongo({ name: "AI gateway worker", connect, createWorker: () => { created += 1; }, env: { MONGODB_URL: "mongodb+srv://user:secret@db.internal/x" } }).catch((e) => e);
  assert.ok(error instanceof WorkerStartupError);
  assert.equal(created, 0);
  const line = startupFailureLine(error);
  assert.match(line, /^AI gateway worker cannot start: MongoDB is required .* could not be reached: getaddrinfo ENOTFOUND db\.internal/);
  assert.ok(!line.includes("\n") && !line.includes("secret"));
});

test("F1 both worker scripts start through startWorkerWithMongo, exit non-zero on failure, and neither fires connectDB without awaiting it", () => {
  for (const script of ["scripts/startAiGatewayWorker.ts", "scripts/startDurableWorker.ts"]) {
    const source = read(script);
    assert.match(source, /await startWorkerWithMongo\(\{[^}]*connect:connectDB,createWorker:/, script);
    assert.ok(!/void connectDB\(/.test(source), `${script} must await MongoDB`);
    assert.match(source, /console\.error\(startupFailureLine\(error\)\);process\.exit\(1\);/, script);
    // The worker constructor appears only inside the createWorker callback.
    assert.equal(source.match(/create(AiGateway|SourceSecurity)Worker\(/g).length, 1, script);
  }
  assert.match(read("docs/runbooks/PRODUCTION.md"), /Both workers[^\n]*require[^\n]*`MONGODB_URL`/);
});

// ---------------------------------------------------------------- F2: head-of-line blocking

const mongoose = require("mongoose");
const { createDomainVerification } = require("../src/modules/domainVerification/application/manageDomains");
const { mongoDomainRepository } = require("../src/modules/domainVerification/infrastructure/mongo/mongoDomainRepository");
const { createSupportDeskSweeper } = require("../src/modules/supportDesk/application/supportDeskSweeper");
const { mongoSupportDeskRepository } = require("../src/modules/supportDesk/infrastructure/mongo/mongoSupportDeskRepository");
const { createVendorSubmissionDraftService } = require("../src/modules/vendorResponses/application/vendorSubmissionDrafts");
const { mongoVendorSubmissionDraftRepository } = require("../src/modules/vendorResponses/infrastructure/mongo/mongoVendorSubmissionDraftRepository");
const { exceptOrganizations } = require("../src/modules/organizationBlock/mongoFilter");
const OrganizationDomain = require("../modal/organizationDomainModel").default;
const SupportTicket = require("../modal/supportTicketModel").default;
const VendorSubmissionDraft = require("../modal/vendorSubmissionDraftModel").default;

const hex = (c) => c.repeat(24);
const A = hex("a"); // blocked
const B = hex("b"); // not blocked
const NOW = new Date("2026-11-19T10:00:00Z");
const oid = (value) => new mongoose.Types.ObjectId(value);
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60_000);

/* Stands in for the collection behind `Model.find`: it applies what MongoDB would for these
   sweeps, the `organizationId: {$nin}` of the filter, the sort key and the limit, to rows that
   are all due. The real repository builds the query; the real sweep consumes the batch. So a
   repository that does not put the blocked ids in its query returns a batch full of the blocked
   organization's rows, exactly as production would. */
const withCollection = async (Model, rows, run) => {
  const original = Model.find;
  const filters = [];
  Model.find = (filter) => {
    filters.push(filter);
    const excluded = new Set((filter.organizationId?.$nin ?? []).map(String));
    let result = rows.filter((row) => !excluded.has(String(row.organizationId)));
    const chain = {
      sort(spec) { const [key, direction] = Object.entries(spec)[0]; result = [...result].sort((x, y) => direction * (x[key] - y[key])); return chain; },
      limit(n) { result = result.slice(0, n); return chain; },
      select() { return chain; },
      lean() { return Promise.resolve(result); },
    };
    return chain;
  };
  try { return await run(filters); } finally { Model.find = original; }
};

test("F2 the shared query fragment: blocked ids become organizationId $nin; none adds nothing", () => {
  assert.deepEqual(exceptOrganizations(undefined), {});
  assert.deepEqual(exceptOrganizations([]), {});
  assert.deepEqual(exceptOrganizations([A]).organizationId.$nin.map(String), [A]);
});

test("F2 domain verification sweep: a batch-sized set of due domains of a blocked organization does not starve another organization's domain", async () => {
  const LIMIT = 5;
  const rows = [
    ...Array.from({ length: LIMIT }, (_, i) => ({ _id: oid(), organizationId: oid(A), domain: `a${i}.example`, status: "verified", verificationToken: "t", nextCheckAt: minutesAgo(100 - i), createdAt: NOW })),
    { _id: oid(), organizationId: oid(B), domain: "b.example", status: "verified", verificationToken: "t", nextCheckAt: minutesAgo(1), createdAt: NOW },
  ];
  const claimed = [];
  await withCollection(OrganizationDomain, rows, async (filters) => {
    const verification = createDomainVerification({
      domains: { ...mongoDomainRepository, async claimDue(input) { claimed.push(input.id); return false; } },
      resolver: {}, adminEmails: {}, audit: { append: async () => undefined },
      blockedOrganizationIds: async () => new Set([A]),
      now: () => NOW,
    });
    await verification.sweep({ limit: LIMIT });
    assert.deepEqual(filters[0].organizationId.$nin.map(String), [A], "the blocked ids are in the query");
  });
  assert.deepEqual(claimed, [String(rows[LIMIT]._id)], "the other organization's domain is reached");
});

test("F2 vendor draft cleanup: a batch-sized set of expired drafts of a blocked organization does not starve another organization's draft", async () => {
  const LIMIT = 5;
  const draft = (organizationId, age) => ({ _id: oid(), organizationId: oid(organizationId), proposalId: oid(), grantId: oid(), grantSubjectHash: "h", documents: [], draftRevision: 1, status: "active", lastSavedAt: minutesAgo(age), expiresAt: minutesAgo(age) });
  const rows = [...Array.from({ length: LIMIT }, (_, i) => draft(A, 100 - i)), draft(B, 1)];
  const abandoned = [];
  await withCollection(VendorSubmissionDraft, rows, async (filters) => {
    const service = createVendorSubmissionDraftService({
      repository: { ...mongoVendorSubmissionDraftRepository, async markExpiredAbandoned(draftId) { abandoned.push(draftId); return false; } },
      storage: {}, malwareScan: {}, folderName: "rfp-tool", now: () => NOW,
      blockedOrganizationIds: async () => new Set([A]),
    });
    const result = await service.cleanupExpired(LIMIT);
    assert.equal(result.drafts, 1);
    assert.deepEqual(filters[0].organizationId.$nin.map(String), [A]);
  });
  assert.deepEqual(abandoned, [String(rows[LIMIT]._id)], "the other organization's draft is reached");
});

test("F2 support desk sweep: batch-sized sets of due tickets of a blocked organization do not starve another organization's reminder, auto-resolve or close", async () => {
  const BATCH = 5;
  const ticket = (organizationId, age) => ({ _id: oid(), ticketNumber: 1, organizationId: oid(organizationId), requesterUserId: oid(), subject: "Help", priority: "normal", status: "waiting_on_customer", waitingSince: minutesAgo(age), resolvedAt: minutesAgo(age), createdAt: NOW });
  const rows = [...Array.from({ length: BATCH }, (_, i) => ticket(A, 100 - i)), ticket(B, 1)];
  const other = String(rows[BATCH]._id);
  const messages = [];
  const events = [];
  await withCollection(SupportTicket, rows, async (filters) => {
    const sweeper = createSupportDeskSweeper({
      repository: {
        listNeedingCloseReminder: mongoSupportDeskRepository.listNeedingCloseReminder,
        listDueToAutoResolve: mongoSupportDeskRepository.listDueToAutoResolve,
        listResolvedBefore: mongoSupportDeskRepository.listResolvedBefore,
        async backfillServiceLevels() { return 0; },
        async listUnansweredSince() { return []; },
        async updateTicket(organizationId, id, patch) { return { id, organizationId, ...patch }; },
        async appendMessage(input) { messages.push(input.ticketId); return { id: "m", ...input }; },
        async findTicketPeople() { return new Map(); },
      },
      notifier: {
        async ticketEscalated() {},
        async autoCloseReminder(input) { events.push(["reminder", input.ticket.id]); },
        async autoResolved(input) { events.push(["resolved", input.ticket.id]); },
      },
      clock: () => NOW,
      batchSize: BATCH,
      blockedOrganizationIds: async () => new Set([A]),
    });
    const result = await sweeper.run();
    assert.deepEqual([result.reminded, result.resolved, result.closed, result.failed], [1, 1, 1, 0]);
    assert.equal(filters.length, 3);
    for (const filter of filters) assert.deepEqual(filter.organizationId.$nin.map(String), [A], "the blocked ids are in each query");
  });
  assert.deepEqual(messages, [other, other, other], "only the other organization's ticket is written to");
  assert.deepEqual(events, [["reminder", other], ["resolved", other]]);
});

// ---------------------------------------------------------------- F9: reactivating an organization that became unmanageable

const { createStaffOrganizationBlock } = require("../src/modules/staffAccess/application/manageOrganizationBlock");
const { isOrganizationBlocked } = require("../src/modules/organizationBlock/domain");

test("F9 an organization that carries the marker but is no longer manageable can be reactivated, with a reason, by staff, recorded on the staff side; it still cannot be blocked", async () => {
  const STAFF_ORG = hex("d");
  const STAFF = hex("7");
  const REASON = "Reactivated after review, ticket 5530";
  const staff = { adminId: STAFF, organizationId: STAFF_ORG, role: "admin", accountType: "admin", correlationId: "corr" };
  const marker = () => ({ at: minutesAgo(60), byStaffOrganizationId: STAFF_ORG, byStaffAccountId: STAFF });
  // Blocked as customer organizations; since then one got an `admins` account and one changed kind.
  const organizations = {
    [hex("1")]: { kind: "customer", staffAccountCount: 1, blocked: marker() },
    [hex("2")]: { kind: "legacy_holding", staffAccountCount: 0, blocked: marker() },
    [hex("3")]: { kind: "legacy_holding", staffAccountCount: 0 }, // unmanageable, never blocked
  };
  const audit = [];
  // Commits as the Mongo store does (mongoOrganizationBlockStore.ts).
  const store = {
    async block() { throw new Error("an unmanageable organization must be refused before the store"); },
    async reactivate(input) {
      const o = organizations[input.organizationId];
      if (!o) return "not_found";
      if (!isOrganizationBlocked(o)) {
        if (!input.manageable || o.kind !== "customer") return "not_manageable";
        audit.push({ ...input.audit, decision: "allowed", reason: "organization_not_blocked" });
        return { changed: false, blockedAt: null, sessionsEnded: 0 };
      }
      delete o.blocked;
      audit.push({ ...input.audit, decision: "allowed", reason: "organization_reactivated" });
      return { changed: true, blockedAt: null, sessionsEnded: 0 };
    },
  };
  const service = createStaffOrganizationBlock({
    directory: { async organization(id) { const o = organizations[id]; return o ? { id, kind: o.kind, staffAccountCount: o.staffAccountCount } : null; } },
    store, now: () => NOW,
    audit: { append: async (event) => { audit.push(event); } },
  });

  for (const [organizationId, standing] of [[hex("1"), "platform"], [hex("2"), "legacy_holding"]]) {
    // Blocking keeps the full rule.
    const refusedBlock = await service.block(staff, organizationId, { reason: REASON }).catch((e) => e);
    assert.deepEqual([refusedBlock.status, refusedBlock.code], [409, "ORGANIZATION_NOT_MANAGEABLE"]);
    // Still needs a reason.
    const noReason = await service.reactivate(staff, organizationId, {}).catch((e) => e);
    assert.deepEqual([noReason.status, noReason.code], [400, "INVALID_REASON"]);
    assert.equal(isOrganizationBlocked(organizations[organizationId]), true);
    // Still staff only.
    const notStaff = await service.reactivate({ ...staff, accountType: "user", role: "user" }, organizationId, { reason: REASON }).catch((e) => e);
    assert.equal(notStaff.status, 403);
    assert.equal(isOrganizationBlocked(organizations[organizationId]), true);

    const result = await service.reactivate(staff, organizationId, { reason: REASON });
    assert.deepEqual(result, { organizationId, changed: true, blocked: false, blockedAt: null });
    assert.equal(isOrganizationBlocked(organizations[organizationId]), false);
    const event = audit.at(-1);
    assert.deepEqual([event.organizationId, event.action, event.decision, event.reason, event.targetId], [STAFF_ORG, "platform.organization.reactivated", "allowed", "organization_reactivated", organizationId]);
    assert.equal(event.metadata.staffReason, REASON);
    assert.equal(event.metadata.standing, standing, "the staff-side record says the organization is not a manageable one");
    // Once the marker is gone the full rule applies again.
    const again = await service.reactivate(staff, organizationId, { reason: REASON }).catch((e) => e);
    assert.deepEqual([again.status, again.code, again.details.standing], [409, "ORGANIZATION_NOT_MANAGEABLE", standing]);
  }
  // Unmanageable and never blocked: refused as before, nothing written but the denial.
  const never = await service.reactivate(staff, hex("3"), { reason: REASON }).catch((e) => e);
  assert.deepEqual([never.status, never.code], [409, "ORGANIZATION_NOT_MANAGEABLE"]);
  assert.ok(audit.every((e) => e.organizationId === STAFF_ORG), "every event is in the staff organization");
});

// ---------------------------------------------------------------- F7: Microsoft sign-in links nothing when refused

const crypto = require("node:crypto");
const { createFederatedSignIn } = require("../src/modules/sso/application/federatedSignIn");
const { createMemorySsoStateStore } = require("../src/modules/sso/infrastructure/ssoStateStore");
const { microsoftIssuerFor, MICROSOFT_AUTHORITY } = require("../src/modules/sso/domain/ssoRules");

test("F7 Microsoft sign-in for an existing account in a blocked organization links nothing; main's own refusals answer first; another organization's account is linked and signed in", async () => {
  const TENANT = "11111111-2222-3333-4444-555555555555";
  const bindHash = crypto.createHash("sha256").update("browser-bind-cookie-value-0123456789").digest("hex");
  const blocked = new Set([A]);
  const state = { users: [], links: [], audits: [], created: 0 };
  const metadata = (issuer) => ({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
  const signIn = createFederatedSignIn({
    store: createMemorySsoStateStore(),
    oidc: {
      async discover(issuer, expected) { return metadata(expected ?? issuer); },
      authorizationUrl(meta, input) { const url = new URL(meta.authorization_endpoint); url.searchParams.set("state", input.state); return url.toString(); },
      async exchangeCode() { return "id-token"; },
      async verifyIdToken() { return { iss: microsoftIssuerFor(TENANT), sub: "s", tid: TENANT, oid: "o1", email: "pat@fabrikam.example", xms_edov: true }; },
    },
    microsoft: () => ({ clientId: "ms-client", clientSecret: "ms-secret" }),
    redirectUri: () => "http://localhost:8000/api/auth/sso/callback",
    connections: { async activeForDomain() { return null; }, async activeById() { return null; }, async organizationVerifiedDomains() { return []; } },
    accounts: {
      async findByIdentity() { return null; },
      async findByEmail(email) { return state.users.find((u) => u.email === email) ?? null; },
      async link(userId) { state.links.push(userId); },
      async createOwner() { state.created += 1; return { userId: "owner-new", organizationId: "org-new" }; },
      async joinOrganization() { throw new Error("not a company sign-in"); },
      async membership() { return null; },
      async addMembership() { throw new Error("not a company sign-in"); },
    },
    async ssoRequiredFor() { return false; },
    invitations: { async organizationOf() { return null; }, async acceptWithPerson() { return { kind: "refused", code: "INVITATION_INVALID" }; } },
    async audit(event) { state.audits.push(event); },
    organizationBlocked: async (organizationId) => blocked.has(organizationId),
  });
  const roundTrip = async () => {
    const started = await signIn.start({ kind: "microsoft", bind: bindHash });
    assert.equal(started.kind, "redirect", JSON.stringify(started));
    return signIn.callback({ code: "auth-code", state: new URL(started.url).searchParams.get("state") }, "corr-1");
  };

  state.users.push({ userId: "u1", email: "pat@fabrikam.example", organizationId: A, isBlocked: false, identities: [] });
  assert.deepEqual(await roundTrip(), { kind: "error", code: "ORGANIZATION_BLOCKED", inviteToken: null });
  assert.deepEqual([state.links, state.audits, state.created], [[], [], 0], "a refused sign-in links nothing and writes nothing");

  // A refusal main gives for its own reasons is given unchanged, and still links nothing.
  state.users[0].isBlocked = true;
  assert.deepEqual(await roundTrip(), { kind: "error", code: "USER_BLOCKED", inviteToken: null });
  state.users[0].isBlocked = false;
  state.users[0].identities = [{ issuer: MICROSOFT_AUTHORITY, subject: "someone-else" }];
  assert.deepEqual(await roundTrip(), { kind: "error", code: "SSO_IDENTITY_MISMATCH", inviteToken: null });
  state.users[0].identities = [];
  assert.deepEqual(state.links, []);

  // Reactivated: the same round trip links the identity and signs the person in.
  blocked.delete(A);
  assert.equal((await roundTrip()).kind, "handoff");
  assert.deepEqual(state.links, ["u1"]);
  // An account of an organization that is not blocked was never affected.
  blocked.add(A);
  state.users[0].organizationId = B;
  assert.equal((await roundTrip()).kind, "handoff");
  assert.deepEqual(state.links, ["u1", "u1"]);
});

// ---------------------------------------------------------------- F5: a dead credential does not learn of the block

const { createSessionManager, hashOpaqueToken } = require("../src/modules/auth/application/manageSessions");
const { STAFF_MEMBERSHIP_REVOKE_REASON } = require("../src/modules/auth/domain/ports/sessionPorts");
const { ORGANIZATION_BLOCK_REVOKE_REASON, ORGANIZATION_BLOCKED } = require("../src/modules/organizationBlock/domain");

const USER = hex("1");
const ROTATION_KEY = "c".repeat(64);
const derive = (previous, key) => `derived-${hashOpaqueToken(previous + key).slice(0, 16)}`;

/* One organization's refresh sessions over an in-memory repository that behaves as the Mongo one.
   `blocked` undefined builds the manager WITHOUT the gate: that code path is origin/main's, so a
   scenario run in both worlds compares the answer under a block with main's answer. */
const refreshWorld = (blocked) => {
  const rows = [];
  const audit = [];
  // `blocked` switches on when the scenario is set up: the credential existed before the block.
  const state = { now: NOW, memberActive: true, issued: 0, blocked: false };
  const sessions = {
    async create(input) { rows.push({ id: `row-${rows.length}`, ...input, status: "active", revokeReason: null, rotationCount: 0, consumed: [], lastRotation: null }); },
    async findByTokenHash(tokenHash) { const row = rows.find((r) => r.tokenHash === tokenHash || r.consumed.includes(tokenHash)); return row ? { ...row } : null; },
    async rotateActive({ id, previousHash, tokenHash, tokenId, keyHash, now }) {
      const row = rows.find((r) => r.id === id && r.tokenHash === previousHash && r.status === "active");
      if (!row) return false;
      row.consumed.push(previousHash); row.tokenHash = tokenHash; row.tokenId = tokenId; row.rotationCount++; row.lastRotation = { previousHash, keyHash, at: now };
      return true;
    },
    async revokeFamily({ familyId, reason }) { let n = 0; for (const r of rows) if (r.familyId === familyId && r.status !== "revoked") { r.status = "revoked"; r.revokeReason = reason; n++; } return n; },
    async revokeSession({ sessionId, reason }) { let n = 0; for (const r of rows) if (r.sessionId === sessionId && r.status !== "revoked") { r.status = "revoked"; r.revokeReason = reason; n++; } return n; },
    async revokeAll({ userId, organizationId, reason }) { let n = 0; for (const r of rows) if (r.userId === userId && r.organizationId === organizationId && r.status !== "revoked") { r.status = "revoked"; r.revokeReason = reason; n++; } return n; },
    async listActive() { return []; },
  };
  let token = 0;
  const account = { userId: USER, accountType: "planner", email: "m@example.test", organizationId: A, role: "customer", roles: ["planner"], rolesVersion: 1 };
  const manager = createSessionManager({
    sessions,
    accounts: { load: async () => (state.memberActive ? account : null) },
    accessTokens: { issue: () => { state.issued += 1; return { accessToken: "access", expiresAt: 1, expiresIn: 1 }; } },
    audit: { append: async (event) => { audit.push(event); } },
    now: () => state.now,
    opaqueToken: () => `refresh-${token++}`,
    deriveRefreshToken: derive,
    ...(blocked === undefined ? {} : { organizationBlocked: async (organizationId) => state.blocked && organizationId === A }),
  });
  const begin = () => manager.begin({ account, correlationId: "c-begin" });
  // What the block's own transaction does to every session of the organization.
  const blockEndsSessions = () => { for (const r of rows) if (r.status !== "revoked") { r.status = "revoked"; r.revokeReason = ORGANIZATION_BLOCK_REVOKE_REASON; } };
  return { manager, rows, audit, state, begin, blockEndsSessions };
};

// Runs one scenario under a block and on main's path, and returns both outcomes.
const underBlockAndOnMain = async (scenario) => {
  const outcome = async (blocked) => {
    const w = refreshWorld(blocked);
    const presented = await scenario(w, blocked === true);
    w.state.blocked = blocked === true;
    const before = w.audit.length;
    const issuedBefore = w.state.issued;
    const answer = await w.manager.rotate({ correlationId: "c-rotate", ...presented });
    return { kind: answer.kind, customerAuditRows: w.audit.slice(before).map((e) => [e.organizationId, e.action]), issued: w.state.issued - issuedBefore, reasons: w.rows.map((r) => r.revokeReason) };
  };
  return { blocked: await outcome(true), main: await outcome(undefined) };
};

test("F5a refresh: every dead credential of a blocked organization gets exactly main's answer and main's audit rows, never organization_blocked", async () => {
  const dead = {
    "a consumed token": async (w) => { const s = await w.begin(); await w.manager.rotate({ refreshToken: s.refreshToken, correlationId: "c0" }); return { refreshToken: s.refreshToken }; },
    "a consumed token of a session the block ended": async (w, blocked) => { const s = await w.begin(); await w.manager.rotate({ refreshToken: s.refreshToken, correlationId: "c0" }); if (blocked) w.blockEndsSessions(); return { refreshToken: s.refreshToken }; },
    "a logged-out session": async (w) => { const s = await w.begin(); await w.manager.revokeSession({ userId: USER, organizationId: A, sessionId: s.sessionId, correlationId: "c0" }); return { refreshToken: s.refreshToken }; },
    "a session revoked for a staff membership change": async (w) => { const s = await w.begin(); w.rows[0].status = "revoked"; w.rows[0].revokeReason = STAFF_MEMBERSHIP_REVOKE_REASON; return { refreshToken: s.refreshToken }; },
    "an expired session": async (w) => { const s = await w.begin(); w.state.now = new Date(NOW.getTime() + 400 * 24 * 60 * 60 * 1000); return { refreshToken: s.refreshToken }; },
    "a member who is no longer active": async (w) => { const s = await w.begin(); w.state.memberActive = false; return { refreshToken: s.refreshToken }; },
    "a token that was never issued": async (w) => { await w.begin(); return { refreshToken: "never-issued" }; },
  };
  const expected = {
    "a consumed token": ["reuse_detected", [[A, "auth.refresh.reuse_detected"]]],
    "a consumed token of a session the block ended": ["reuse_detected", [[A, "auth.refresh.reuse_detected"]]],
    "a logged-out session": ["reuse_detected", [[A, "auth.refresh.reuse_detected"]]],
    "a session revoked for a staff membership change": ["reuse_detected", []],
    "an expired session": ["expired", []],
    "a member who is no longer active": ["membership_inactive", []],
    "a token that was never issued": ["invalid", []],
  };
  for (const [name, scenario] of Object.entries(dead)) {
    const { blocked, main } = await underBlockAndOnMain(scenario);
    assert.deepEqual([blocked.kind, blocked.customerAuditRows], expected[name], name);
    assert.deepEqual([blocked.kind, blocked.customerAuditRows], [main.kind, main.customerAuditRows], `${name}: the answer and the customer audit rows are main's`);
    assert.equal(blocked.issued, 0, name);
  }
  // A member removed after the block ended their session is not told either: the answer a
  // staff-ended session's last token always gets, and no row in the customer organization.
  const removed = refreshWorld(true);
  const session = await removed.begin();
  removed.blockEndsSessions();
  removed.state.blocked = true;
  removed.state.memberActive = false;
  const before = removed.audit.length;
  assert.deepEqual(await removed.manager.rotate({ refreshToken: session.refreshToken, correlationId: "c1" }), { kind: "reuse_detected" });
  assert.equal(removed.audit.length, before);
});

test("F5a refresh: a live credential of a blocked organization is told, gets no token, and writes no customer audit row", async () => {
  const live = {
    "the current token of an active session": async (w) => ({ refreshToken: (await w.begin()).refreshToken }),
    "the current token of a session the block ended": async (w, blocked) => { const s = await w.begin(); if (blocked) w.blockEndsSessions(); return { refreshToken: s.refreshToken }; },
    // The rotation succeeded but its answer was lost; the client retries with the same key. The
    // session is still active (it began, and rotated, while the block committed).
    "a recoverable handoff retry": async (w) => { const s = await w.begin(); assert.equal((await w.manager.rotate({ refreshToken: s.refreshToken, rotationKey: ROTATION_KEY, correlationId: "c0" })).kind, "rotated"); return { refreshToken: s.refreshToken, rotationKey: ROTATION_KEY }; },
  };
  for (const [name, scenario] of Object.entries(live)) {
    const { blocked, main } = await underBlockAndOnMain(scenario);
    assert.equal(main.kind, "rotated", `${name}: main would have granted it`);
    assert.deepEqual([blocked.kind, blocked.customerAuditRows, blocked.issued], ["organization_blocked", [], 0], name);
    assert.deepEqual(blocked.reasons, [ORGANIZATION_BLOCK_REVOKE_REASON], `${name}: the session is ended for the block's reason`);
  }
});

// The access path. Models are replaced as the collection would answer; the customer-side
// revocation is the REAL session manager over in-memory sessions, so its audit rows are counted.
const accessWorld = async (run) => {
  const { createAuthenticate } = require("../middleware/auth");
  const Organization = require("../modal/organizationModel").default;
  const OrganizationMembership = require("../modal/organizationMembershipModel").default;
  const RefreshSession = require("../modal/refreshSessionModel").default;
  const loader = require("../src/modules/auth/infrastructure/mongo/mongoSessionAccountLoader");
  const originals = [[Organization, "findOne", Organization.findOne], [OrganizationMembership, "findOne", OrganizationMembership.findOne], [RefreshSession, "exists", RefreshSession.exists], [loader, "findSessionPrincipal", loader.findSessionPrincipal]];
  const request = async ({ blocked, kind = "customer", membership, principal = true, session }) => {
    const w = refreshWorld(undefined);
    const begun = await w.begin();
    const row = w.rows[0];
    if (session === "ended_by_block") w.blockEndsSessions();
    if (session === "logged_out") { row.status = "revoked"; row.revokeReason = "user_logout"; }
    if (session === "expired") row.expiresAt = new Date(0);
    const beginRows = w.audit.length;
    Organization.findOne = () => ({ select: () => ({ lean: async () => ({ _id: A, kind, ...(blocked ? { blocked: { at: minutesAgo(5), byStaffOrganizationId: hex("d"), byStaffAccountId: hex("7") } } : {}) }) }) });
    OrganizationMembership.findOne = () => ({ select: () => ({ lean: async () => membership }) });
    RefreshSession.exists = async (filter) => {
      const found = w.rows.find((r) => r.sessionId === filter.sessionId && r.status === filter.status && (filter.revokeReason === undefined || r.revokeReason === filter.revokeReason) && r.expiresAt > filter.expiresAt.$gt && r.idleExpiresAt > filter.idleExpiresAt.$gt);
      return found ? { _id: found.id } : null;
    };
    loader.findSessionPrincipal = async () => (principal ? { accountType: "planner", email: "m@example.test", role: "customer" } : null);
    const authenticate = createAuthenticate(
      () => ({ userId: USER, organizationId: A, sessionId: begun.sessionId }),
      {
        revokeInactiveMembership: (input) => w.manager.revokeInactiveMembership(input),
        revokeOtherSessionsAfterRoleChange: async () => { throw new Error("not reached in these cases"); },
        actorLookups: {},
        endSessionsOfBlockedOrganization: (input) => w.manager && (async () => { let n = 0; for (const r of w.rows) if (r.userId === input.userId && r.organizationId === input.organizationId && r.status !== "revoked") { r.status = "revoked"; r.revokeReason = ORGANIZATION_BLOCK_REVOKE_REASON; n++; } return n; })(),
      },
    );
    const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    let passed = false;
    await authenticate({ headers: { authorization: "Bearer t" }, correlationId: "c-req" }, res, () => { passed = true; });
    return { status: res.statusCode, code: res.body?.code ?? res.body?.message ?? null, passed, customerAuditRows: w.audit.slice(beginRows).map((e) => e.action), session: [row.status, row.revokeReason] };
  };
  try { await run(request); } finally { for (const [target, name, value] of originals) target[name] = value; }
};

test("F5b authenticate: a request main refuses for its own reasons gets that refusal in a blocked organization, with no customer audit row main would not have written", async () => {
  const active = { roles: ["planner"], version: 1, status: "active", sessionRevocationPending: false };
  await accessWorld(async (request) => {
    const dead = [
      ["a removed member (no membership)", { membership: null, session: "active" }, [401, "MEMBERSHIP_INACTIVE"]],
      ["a removed member whose session the block ended", { membership: null, session: "ended_by_block" }, [401, "MEMBERSHIP_INACTIVE"]],
      ["a deactivated member", { membership: { ...active, status: "suspended" }, session: "active" }, [401, "MEMBERSHIP_INACTIVE"]],
      ["a deactivated member whose session the block ended", { membership: { ...active, status: "suspended" }, session: "ended_by_block" }, [401, "MEMBERSHIP_INACTIVE"]],
      ["a logged-out session", { membership: active, session: "logged_out" }, [403, "Active organization membership required"]],
      ["an expired session", { membership: active, session: "expired" }, [403, "Active organization membership required"]],
      ["a blocked or missing account", { membership: active, principal: false, session: "active" }, [403, "Active organization membership required"]],
      ["an account waiting for placement", { membership: active, kind: "legacy_holding", session: "active" }, [401, "ORGANIZATION_SETUP_REQUIRED"]],
    ];
    for (const [name, input, answer] of dead) {
      const underBlock = await request({ ...input, blocked: true });
      // Main, for the same person: the same credential with no block (so no session ended by one).
      const onMain = await request({ ...input, blocked: false, session: input.session === "ended_by_block" ? "active" : input.session });
      assert.deepEqual([underBlock.status, underBlock.code], answer, name);
      assert.deepEqual([underBlock.status, underBlock.code], [onMain.status, onMain.code], `${name}: main's answer`);
      assert.notEqual(underBlock.code, ORGANIZATION_BLOCKED.code, name);
      assert.equal(underBlock.passed, false, name);
      // Every customer row under the block is one main writes too; the block adds none.
      assert.ok(underBlock.customerAuditRows.length <= onMain.customerAuditRows.length, `${name}: ${underBlock.customerAuditRows} vs ${onMain.customerAuditRows}`);
      assert.deepEqual(underBlock.customerAuditRows, onMain.customerAuditRows.slice(0, underBlock.customerAuditRows.length), name);
    }
    // The counts, spelled out: a removed member with a still-live session is recorded as on main
    // (one row); once the block ended that session there is nothing left to revoke and no row.
    assert.deepEqual((await request({ blocked: true, membership: null, session: "active" })).customerAuditRows, ["auth.sessions.revoked_all"]);
    assert.deepEqual((await request({ blocked: false, membership: null, session: "active" })).customerAuditRows, ["auth.sessions.revoked_all"]);
    const ended = await request({ blocked: true, membership: null, session: "ended_by_block" });
    assert.deepEqual([ended.customerAuditRows, ended.session], [[], ["revoked", ORGANIZATION_BLOCK_REVOKE_REASON]], "the block's reason is not overwritten");
  });
});

test("F5b authenticate: a live member of a blocked organization is told, with or without the session the block ended, and no customer audit row is written", async () => {
  const active = { roles: ["owner"], version: 3, status: "active", sessionRevocationPending: true };
  await accessWorld(async (request) => {
    for (const session of ["active", "ended_by_block"]) {
      const refused = await request({ blocked: true, membership: active, session });
      assert.deepEqual([refused.status, refused.code, refused.passed], [401, ORGANIZATION_BLOCKED.code, false], session);
      assert.deepEqual(refused.customerAuditRows, [], session);
      assert.deepEqual(refused.session, ["revoked", ORGANIZATION_BLOCK_REVOKE_REASON], session);
    }
  });
  const source = read("middleware/auth.ts");
  const at = (text) => { const index = source.indexOf(text); assert.ok(index > 0, text); return index; };
  const order = [
    at('if (!membership || membership.status !== "active")'),
    at('if (organization?.kind === "legacy_holding")'),
    at("if (!principal || !liveSession)"),
    at("if (!organization) {"),
    at("if (blocked) {"),
    at("if (membership.sessionRevocationPending)"),
  ];
  assert.deepEqual(order, [...order].sort((x, y) => x - y), "main's own refusals, then the block, then the request goes on");
});

// ---------------------------------------------------------------- F6: sign-up on a blocked organization's domain

const { createAccessRequestService, organizationForEmailDomain } = require("../src/modules/accessRequests/accessRequests");

/* The collections the access-request service reads and writes, as MongoDB would answer for one
   organization A that verified acme.example. Everything else is the real service. */
const accessRequestWorld = async ({ blocked, autoApprove, gate = true }, run) => {
  const Organization = require("../modal/organizationModel").default;
  const OrganizationMembership = require("../modal/organizationMembershipModel").default;
  const User = require("../modal/userModel").default;
  const AccessRequest = require("../modal/accessRequestModel").default;
  const originals = [[Organization, "findOne"], [OrganizationMembership, "find"], [User, "find"], [User, "exists"], [AccessRequest, "findOne"], [AccessRequest, "create"], [AccessRequest, "find"], [AccessRequest, "findOneAndUpdate"]].map(([model, name]) => [model, name, model[name]]);
  const w = { blocked, requests: [], invitations: [], notifications: [], audit: [], organizationSelects: [] };
  const OWNER = hex("9");
  const leaf = (value) => { const chain = { select: () => chain, sort: () => chain, limit: () => chain, lean: async () => value }; return chain; };
  Organization.findOne = (filter) => {
    const chain = leaf(filter.verifiedDomains === "acme.example" ? { _id: oid(A), name: "Acme", autoApproveDomain: autoApprove, ...(w.blocked ? { blocked: { at: minutesAgo(5) } } : {}) } : null);
    const select = chain.select; chain.select = (fields) => { w.organizationSelects.push(fields); return select(); };
    return chain;
  };
  OrganizationMembership.find = () => leaf([{ userId: oid(OWNER), roles: ["owner"] }]);
  User.find = () => leaf([{ _id: oid(OWNER), email: "owner@acme.example" }]);
  User.exists = async () => null;
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => String(row[key]) === String(value));
  AccessRequest.findOne = (filter) => leaf(w.requests.find((r) => matches(r, filter)) ?? null);
  AccessRequest.find = (filter) => leaf(w.requests.filter((r) => matches(r, filter)));
  AccessRequest.create = async (doc) => { const row = { _id: oid(), createdAt: NOW, ...doc }; w.requests.push(row); return row; };
  AccessRequest.findOneAndUpdate = (filter, update) => { const row = w.requests.find((r) => matches(r, filter)); if (row) Object.assign(row, update.$set); return leaf(row ?? null); };
  const service = createAccessRequestService({
    invitations: { async create(actor, input) { w.invitations.push([actor.organizationId, input.email]); return { kind: "done", rows: [{ outcome: "invited", invitation: { id: hex("5") } }] }; } },
    notifier: { async requestCreated(input) { w.notifications.push(input.recipients.map((r) => r.email)); }, async requestDenied() {} },
    audit: async (event) => { w.audit.push([event.organizationId, event.action, event.reason]); },
    now: () => NOW,
    ...(gate ? { organizationBlocked: async (organizationId) => w.blocked && organizationId === A } : {}),
  });
  try { return await run(service, w, OWNER); } finally { for (const [model, name, value] of originals) model[name] = value; }
};

test("F6 a blocked organization's domain still matches, with nothing about the block in the answer: an outsider sees what they would see without a block", async () => {
  const answers = [];
  for (const blocked of [true, false]) {
    await accessRequestWorld({ blocked, autoApprove: true }, async (_service, w) => {
      answers.push(await organizationForEmailDomain("new@acme.example"));
      assert.deepEqual(w.organizationSelects, ["_id name autoApproveDomain"], "the marker is not even read by the matcher");
    });
  }
  assert.deepEqual(answers[0], { id: A, name: "Acme", autoApproveDomain: true, basis: "verified_domain" });
  assert.deepEqual(answers[0], answers[1]);
  // The three consumers answer from this one function, so each is what it is on main: the match
  // at verify-otp, 409 ORGANIZATION_DOMAIN_MATCH at register and Google unless the person chose a
  // separate organization, and ORGANIZATION_DOMAIN_MATCH for a first Microsoft sign-in.
  const controller = read("controller/authController.ts");
  assert.match(controller, /const match = await organizationForEmailDomain\(email\);\s+res\.status\(200\)\.json\(\{\s+success: true,\s+message: "Email verified successfully",\s+organizationMatch: match \? \{ name: match\.name \} : null,/);
  assert.match(controller, /if \(req\.body\?\.separateOrganization !== true\) \{\s+const match = await organizationForEmailDomain\(req\.body\?\.email\);\s+if \(match\) \{\s+res\.status\(409\)\.json\(domainMatchResponse\(match\.name\)\);/);
  assert.match(read("src/modules/auth/composition.ts"), /domainOrganizationFor: organizationForEmailDomain,/);
  assert.match(read("src/modules/sso/composition.ts"), /domainOrganizationFor: organizationForEmailDomain,/);
  assert.match(read("src/modules/sso/application/federatedSignIn.ts"), /if \(await deps\.domainOrganizationFor\?\.\(person\.email\)\) return \{ error: "ORGANIZATION_DOMAIN_MATCH" \};/);
});

test("F6 an access request for a blocked organization is stored as pending and answered as pending; no invitation, no notification, no email, and only the requester's own audit row", async () => {
  for (const autoApprove of [true, false]) {
    await accessRequestWorld({ blocked: true, autoApprove }, async (service, w, OWNER) => {
      const answer = await service.request({ email: "New@Acme.example", name: "New Person", correlationId: "c1" });
      assert.deepEqual(answer, { kind: "pending", organizationName: "Acme" });
      assert.deepEqual(w.requests.map((r) => [String(r.organizationId), r.email, r.status]), [[A, "new@acme.example", "pending"]]);
      assert.deepEqual(w.invitations, [], "auto-approve does not run: nothing is created or sent into the blocked organization");
      assert.deepEqual(w.notifications, [], "its Owners and Admins are not notified or emailed");
      assert.deepEqual(w.audit, [[A, "organization.access_request.created", "domain_match"]], "what main writes for a pending request, and nothing else");
      // Asking again answers the same and stores nothing more.
      assert.deepEqual(await service.request({ email: "new@acme.example", name: "New Person", correlationId: "c2" }), answer);
      assert.equal(w.requests.length, 1);

      // Reactivated: the request is in the Owners' and Admins' list and can be approved. No late
      // notification is sent, and asking again does not auto-approve it: an Owner or Admin decides.
      w.blocked = false;
      const listed = await service.list(A);
      assert.deepEqual(listed.map((r) => [r.email, r.status, r.autoApproved]), [["new@acme.example", "pending", false]]);
      assert.deepEqual(await service.request({ email: "new@acme.example", name: "New Person", correlationId: "c3" }), answer);
      assert.deepEqual([w.invitations, w.notifications], [[], []]);
      const decided = await service.approve({ organizationId: A, userId: OWNER, roles: ["owner"], managedTeamIds: [] }, listed[0].id, {}, "c4");
      assert.deepEqual([decided.kind, decided.request.status], ["decided", "approved"]);
      assert.deepEqual(w.invitations, [[A, "new@acme.example"]]);
    });
  }
});

test("F6 the same request when the organization is not blocked is what it is on main; the one difference under a block is pending in place of invited for an auto-approve domain", async () => {
  const outcome = async (options) => accessRequestWorld(options, async (service, w) => ({
    answer: await service.request({ email: "new@acme.example", name: "New Person", correlationId: "c1" }),
    invitations: w.invitations.length, notifications: w.notifications, audit: w.audit.map((e) => e[1]),
  }));
  // No auto-approve: identical answer, blocked or not (and identical to main, which has no gate).
  const manual = { blocked: await outcome({ blocked: true, autoApprove: false }), open: await outcome({ blocked: false, autoApprove: false }), main: await outcome({ blocked: false, autoApprove: false, gate: false }) };
  assert.deepEqual(manual.blocked.answer, manual.open.answer);
  assert.deepEqual(manual.open, manual.main);
  assert.deepEqual(manual.open, { answer: { kind: "pending", organizationName: "Acme" }, invitations: 0, notifications: [["owner@acme.example"]], audit: ["organization.access_request.created"] });
  // Auto-approve: the accepted tell.
  const auto = { blocked: await outcome({ blocked: true, autoApprove: true }), open: await outcome({ blocked: false, autoApprove: true }), main: await outcome({ blocked: false, autoApprove: true, gate: false }) };
  assert.deepEqual(auto.open, auto.main);
  assert.deepEqual(auto.open, { answer: { kind: "invited", organizationName: "Acme" }, invitations: 1, notifications: [], audit: ["organization.access_request.auto_approved"] });
  assert.deepEqual(auto.blocked.answer, { kind: "pending", organizationName: "Acme" });
  // A failed gate read fails the request before anything is stored.
  await accessRequestWorld({ blocked: true, autoApprove: true }, async (_service, w) => {
    const failing = createAccessRequestService({ invitations: { create: async () => { throw new Error("not reached"); } }, notifier: { requestCreated: async () => { throw new Error("not reached"); }, requestDenied: async () => {} }, audit: async () => { throw new Error("not reached"); }, organizationBlocked: async () => { throw new Error("mongo down"); } });
    await assert.rejects(() => failing.request({ email: "new@acme.example", name: "New Person", correlationId: "c1" }), /mongo down/);
    assert.equal(w.requests.length, 0);
  });
});
