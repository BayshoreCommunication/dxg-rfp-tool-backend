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
