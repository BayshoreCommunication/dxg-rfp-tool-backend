require("ts-node/register/transpile-only");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const mongoose = require("mongoose");

const {
  createDeleteAdminClient,
  createListAdminClients,
  createSetClientBlocked,
} = require("../src/modules/admin/application/manageAdminClients");

test("client list normalizes paging and preserves escaped-search boundary", async () => {
  let received;
  const list = createListAdminClients({
    async list(input) { received = input; return { clients: [{ id: "1" }], total: 11 }; },
  });
  const result = await list({ page: "bad", search: "  Acme.*  " });
  assert.deepEqual(received, { page: 1, perPage: 10, search: "Acme.*" });
  assert.equal(result.pagination.totalPages, 2);
  assert.equal(result.pagination.hasNextPage, true);
});

test("client block rejects administrative targets before mutation", async () => {
  let mutated = false;
  const block = createSetClientBlocked({
    async findById() { return { id: "a", role: "super-admin" }; },
    async setBlocked() { mutated = true; },
  });
  assert.deepEqual(await block("a", true), { kind: "admin_target" });
  assert.equal(mutated, false);
});

test("client block returns the persisted status", async () => {
  const block = createSetClientBlocked({
    async findById() { return { id: "c", role: "customer" }; },
    async setBlocked(id, isBlocked) { return { id, role: "customer", isBlocked }; },
  });
  assert.deepEqual(await block("c", true), { kind: "updated", id: "c", isBlocked: true });
});

test("client deletion distinguishes missing, admin, and deleted targets", async () => {
  let target = null;
  let deleted;
  const remove = createDeleteAdminClient({
    async findById() { return target; },
    async deleteById(id) { deleted = id; },
  });
  assert.deepEqual(await remove("x"), { kind: "not_found" });
  target = { id: "x", role: "admin" };
  assert.deepEqual(await remove("x"), { kind: "admin_target" });
  target = { id: "x", role: "customer" };
  assert.deepEqual(await remove("x"), { kind: "deleted", id: "x" });
  assert.equal(deleted, "x");
});

// Owner decision 2026-11-17: staff see account-level information and counts without a support
// grant, and no customer content. The client list carries a proposal count per account; these
// tests keep it a number, scoped to the caller's organization, with nothing else attached.
// The real-database proof is tests-integration/admin-client-list.test.ts.

const CLIENT_FIELDS = ["id", "name", "email", "company", "joinDate", "isBlocked", "totalProposals", "totalEmailSent"];

test("each client is returned as an allowlist of account fields with the proposal count as a number", async () => {
  const joined = new Date("2026-10-01T00:00:00.000Z");
  const list = createListAdminClients({
    async list() {
      return {
        total: 3,
        clients: [
          {
            id: "c1", name: "Pat Planner", email: "pat@example.com", company: "Acme", joinDate: joined, isBlocked: true,
            totalProposals: 4, totalEmailSent: 12,
            // What a careless repository could hand back. None of it may pass through.
            proposalStats: [{ _id: "6adf186c99740ffeab7ac9f6", event: { eventName: "Annual Gala 2027" } }],
            proposals: [{ id: "6adf186c99740ffeab7ac9f6", title: "Annual Gala 2027" }],
            proposalIds: ["6adf186c99740ffeab7ac9f6"],
            password: "$2a$10$hash", organizationId: "org-1", role: "customer",
          },
          { id: "c2", name: "No Proposals", email: "none@example.com" },
          { id: "c3", name: "Odd Count", email: "odd@example.com", totalProposals: [{ eventName: "Annual Gala 2027" }], totalEmailSent: "7" },
        ],
      };
    },
  });
  const result = await list({});
  for (const client of result.data) {
    assert.deepEqual(Object.keys(client), CLIENT_FIELDS);
    assert.equal(typeof client.totalProposals, "number");
    assert.equal(typeof client.totalEmailSent, "number");
  }
  assert.deepEqual(result.data[0], {
    id: "c1", name: "Pat Planner", email: "pat@example.com", company: "Acme", joinDate: joined, isBlocked: true, totalProposals: 4, totalEmailSent: 12,
  });
  assert.deepEqual(result.data[1], {
    id: "c2", name: "No Proposals", email: "none@example.com", company: null, joinDate: null, isBlocked: false, totalProposals: 0, totalEmailSent: 0,
  });
  // A count that is not a number is not passed on, whatever it holds.
  assert.equal(result.data[2].totalProposals, 0);
  const json = JSON.stringify(result);
  for (const leaked of ["Annual Gala 2027", "6adf186c99740ffeab7ac9f6", "$2a$10$hash", "org-1", "proposalStats", "proposalIds"]) {
    assert.ok(!json.includes(leaked), leaked);
  }
});

const repositoryPath = "../src/modules/admin/infrastructure/mongo/mongoAdminClientRepository";
const usagePath = "../src/modules/admin/infrastructure/mongo/accountUsageCounts";

test("the proposal count and the sent-email total are grouped queries that name the organization", () => {
  const { proposalCountPipeline, emailSentPipeline } = require(usagePath);
  // The client repository still exports the proposal pipeline it uses.
  assert.equal(require(repositoryPath).proposalCountPipeline, proposalCountPipeline);
  const organizationId = new mongoose.Types.ObjectId();
  const owners = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  assert.deepEqual(proposalCountPipeline(organizationId, owners), [
    { $match: { organizationId, userId: { $in: owners } } },
    { $group: { _id: "$userId", count: { $sum: 1 } } },
  ]);
  assert.deepEqual(emailSentPipeline(organizationId, owners), [
    { $match: { organizationId, userId: { $in: owners } } },
    { $group: { _id: "$userId", totalEmailSent: { $sum: "$sentCount" } } },
  ]);
});

const stubModels = (t, { accounts, proposals, emails }) => {
  const Proposal = require("../modal/proposalsModel").default;
  const EmailCampaign = require("../modal/emailModel").default;
  const User = require("../modal/userModel").default;
  const calls = { users: [], proposals: [], emails: [] };
  t.mock.method(User, "aggregate", async (pipeline) => { calls.users.push(pipeline); return accounts; });
  t.mock.method(Proposal, "aggregate", async (pipeline) => { calls.proposals.push(pipeline); return proposals; });
  t.mock.method(EmailCampaign, "aggregate", async (pipeline) => { calls.emails.push(pipeline); return emails; });
  return calls;
};

const assertScopedToOrganization = (pipeline, organizationId, ownerIds, group) => {
  const [match, grouped, ...rest] = pipeline;
  assert.deepEqual(rest, []);
  assert.equal(String(match.$match.organizationId), String(organizationId));
  assert.deepEqual(match.$match.userId.$in.map(String), ownerIds.map(String));
  assert.deepEqual(Object.keys(match.$match).sort(), ["organizationId", "userId"]);
  assert.deepEqual(grouped, { $group: group });
};

test("the client list counts proposals and sent emails inside the caller's organization only and loads no document", async (t) => {
  const { mongoAdminClientRepository } = require(repositoryPath);
  const { runWithTenant } = require("../src/modules/shared/tenancy/tenantContext");
  const staffOrganization = new mongoose.Types.ObjectId();
  const busy = new mongoose.Types.ObjectId();
  const quiet = new mongoose.Types.ObjectId();
  const calls = stubModels(t, {
    accounts: [{
      metadata: [{ total: 2 }],
      data: [
        { id: busy, name: "Pat", email: "pat@example.com", company: null, joinDate: new Date(0), isBlocked: false },
        { id: quiet, name: "Sam", email: "sam@example.com", company: null, joinDate: new Date(0), isBlocked: false },
      ],
    }],
    proposals: [{ _id: busy, count: 2 }],
    emails: [{ _id: busy, totalEmailSent: 7 }],
  });

  const result = await runWithTenant(
    { organizationId: String(staffOrganization), userId: String(new mongoose.Types.ObjectId()) },
    () => mongoAdminClientRepository.list({ page: 1, perPage: 10, search: "" }),
  );

  // One query each, filtered by the session's organization and the listed accounts.
  assert.equal(calls.proposals.length, 1);
  assert.equal(calls.emails.length, 1);
  assertScopedToOrganization(calls.proposals[0], staffOrganization, [busy, quiet], { _id: "$userId", count: { $sum: 1 } });
  assertScopedToOrganization(calls.emails[0], staffOrganization, [busy, quiet], { _id: "$userId", totalEmailSent: { $sum: "$sentCount" } });

  // The account query is in the same organization and joins neither collection any more.
  assert.equal(String(calls.users[0][0].$match.organizationId), String(staffOrganization));
  const accountQuery = JSON.stringify(calls.users[0]);
  assert.ok(!accountQuery.includes("$lookup"));
  assert.ok(!accountQuery.includes('"proposals"'));
  assert.ok(!accountQuery.includes("emailcampaigns"));

  assert.deepEqual(result.clients.map((client) => [String(client.id), client.totalProposals, client.totalEmailSent]), [
    [String(busy), 2, 7],
    [String(quiet), 0, 0],
  ]);
  assert.deepEqual(Object.keys(result.clients[0]), ["id", "name", "email", "company", "joinDate", "isBlocked", "totalProposals", "totalEmailSent"]);
  assert.equal(result.total, 2);
});

test("an empty page asks nothing about proposals or campaigns", async (t) => {
  const { mongoAdminClientRepository } = require(repositoryPath);
  const { runWithTenant } = require("../src/modules/shared/tenancy/tenantContext");
  const calls = stubModels(t, { accounts: [{ metadata: [], data: [] }], proposals: [], emails: [] });
  const result = await runWithTenant(
    { organizationId: String(new mongoose.Types.ObjectId()), userId: String(new mongoose.Types.ObjectId()) },
    () => mongoAdminClientRepository.list({ page: 1, perPage: 10, search: "" }),
  );
  assert.deepEqual(result, { clients: [], total: 0 });
  assert.equal(calls.proposals.length + calls.emails.length, 0);
});

test("the admin overview's recent clients use the same organization-scoped counts, with the shape unchanged", async (t) => {
  const { mongoAdminOverviewReadRepository } = require("../src/modules/admin/infrastructure/mongo/mongoAdminOverviewReadRepository");
  const Proposal = require("../modal/proposalsModel").default;
  const User = require("../modal/userModel").default;
  const { runWithTenant } = require("../src/modules/shared/tenancy/tenantContext");
  const staffOrganization = new mongoose.Types.ObjectId();
  const busy = new mongoose.Types.ObjectId();
  const quiet = new mongoose.Types.ObjectId();
  const joined = new Date("2026-10-01T00:00:00.000Z");
  const calls = stubModels(t, {
    accounts: [
      { id: busy, name: "Pat", email: "pat@example.com", company: "Acme", joinDate: joined },
      { id: quiet, name: "Sam", email: "sam@example.com", company: null, joinDate: joined },
    ],
    proposals: [{ _id: busy, count: 2 }],
    emails: [{ _id: busy, totalEmailSent: 7 }],
  });
  t.mock.method(User, "countDocuments", async () => 2);
  t.mock.method(Proposal, "countDocuments", async () => 9);

  const overview = await runWithTenant(
    { organizationId: String(staffOrganization), userId: String(new mongoose.Types.ObjectId()) },
    () => mongoAdminOverviewReadRepository.getOverview(),
  );

  // Campaigns are asked twice: the organization totals, then the per-account totals.
  assert.equal(calls.proposals.length, 1);
  assert.equal(calls.emails.length, 2);
  assert.equal(String(calls.emails[0][0].$match.organizationId), String(staffOrganization));
  assertScopedToOrganization(calls.proposals[0], staffOrganization, [busy, quiet], { _id: "$userId", count: { $sum: 1 } });
  assertScopedToOrganization(calls.emails[1], staffOrganization, [busy, quiet], { _id: "$userId", totalEmailSent: { $sum: "$sentCount" } });
  assert.ok(!JSON.stringify(calls.users[0]).includes("$lookup"));

  assert.deepEqual(Object.keys(overview), ["totals", "latestClients"]);
  // The stub answers the per-account rows to the totals query too, so only the keys are checked there.
  assert.deepEqual(Object.keys(overview.totals), ["totalClients", "totalProposals", "totalEmailSent", "totalClick"]);
  assert.equal(overview.totals.totalClients, 2);
  assert.equal(overview.totals.totalProposals, 9);
  assert.deepEqual(overview.latestClients, [
    { id: busy, name: "Pat", email: "pat@example.com", company: "Acme", joinDate: joined, totalProposals: 2, totalEmailSent: 7 },
    { id: quiet, name: "Sam", email: "sam@example.com", company: null, joinDate: joined, totalProposals: 0, totalEmailSent: 0 },
  ]);
});

test("the tenant scope guard sees the proposal count, with a real scope and no exemption", () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const usage = read("src/modules/admin/infrastructure/mongo/accountUsageCounts.ts");
  // tests/tenant-scope-guard.test.js matches `Proposal.aggregate(` and reads the call's arguments.
  // A type argument on the call, or a $lookup into proposals, would hide the query from it.
  const calls = [...usage.matchAll(/\bProposal\.aggregate\(([^\n]*)/g)];
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /organizationId/);
  assert.doesNotMatch(usage, /Proposal\.\w+</);
  for (const file of ["accountUsageCounts.ts", "mongoAdminClientRepository.ts", "mongoAdminOverviewReadRepository.ts"]) {
    const source = read(`src/modules/admin/infrastructure/mongo/${file}`);
    assert.doesNotMatch(source, /scope-exempt|tenant-scoped:/, file);
    assert.doesNotMatch(source, /\$lookup/, file);
  }
});
