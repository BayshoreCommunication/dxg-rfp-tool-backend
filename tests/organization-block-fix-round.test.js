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
