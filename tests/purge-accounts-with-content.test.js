require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ACCOUNT_CONTENT, BEYOND_PRODUCT_PATH, COLLECTION_DECISIONS, ContentPurgeError, PROPOSAL_DEPENDENTS,
  contentRefusals, contentTotals, describeAccounts, doomedProposalIds, ownerOnlyActor, ownershipViolations, runContentPurge, sourceRefusals,
} = require("../src/modules/accountPurge/purgeAccountContent");
const { MOVABLE_COLLECTIONS } = require("../src/modules/tenancy/mongoTenantMove");
const { canAccessRfp, rfpListScope } = require("../src/modules/identity/domain/rfpAccessPolicy");

// `purgeTestAccounts --with-content`: the rules that can be judged without a database. What it
// does to real collections is in tests-integration/purge-accounts-with-content.test.ts.

const root = path.join(__dirname, "..");
const scriptSource = fs.readFileSync(path.join(root, "scripts/purgeTestAccounts.ts"), "utf8");
const moduleSource = fs.readFileSync(path.join(root, "src/modules/accountPurge/purgeAccountContent.ts"), "utf8");

// ---- every customer collection has a decision ------------------------------------------------

test("every collection that belongs to a customer is either deleted or deliberately left", () => {
  for (const name of MOVABLE_COLLECTIONS) {
    const decision = COLLECTION_DECISIONS[name];
    assert.ok(decision, `${name} is in mongoTenantMove.ts but has no decision in COLLECTION_DECISIONS`);
    assert.ok(["deleted", "left"].includes(decision.decision), name);
    assert.ok(decision.why.length > 10, `${name} needs a reason`);
  }
  // Today nothing a customer owns is left behind in MongoDB.
  assert.deepEqual(MOVABLE_COLLECTIONS.filter((name) => COLLECTION_DECISIONS[name].decision !== "deleted"), []);
});

test("each decision is carried out by the step it names", () => {
  const contentRules = new Set([...PROPOSAL_DEPENDENTS, ...ACCOUNT_CONTENT].map((rule) => rule.name));
  // The account step's collections, as scripts/purgeTestAccounts.ts names them.
  const accountSteps = new Set([...scriptSource.matchAll(/^\s*\["([A-Za-z]+)", [A-Za-z]+, /gm)].map((match) => match[1].toLowerCase()));
  for (const [name, decision] of Object.entries(COLLECTION_DECISIONS)) {
    if (decision.by === "content") assert.ok(contentRules.has(name), `${name}: no content rule deletes it`);
    if (decision.by === "account") assert.ok(accountSteps.has(name), `${name}: the account step does not delete it`);
    if (decision.decision === "left") {
      assert.equal(decision.by, "none", name);
      assert.ok(!contentRules.has(name), `${name} is declared left but a content rule deletes it`);
    }
    if (decision.by === "product") assert.equal(name, "proposals");
  }
  for (const name of contentRules) assert.equal(COLLECTION_DECISIONS[name]?.decision, "deleted", `${name} is deleted without a decision`);
  assert.deepEqual(BEYOND_PRODUCT_PATH, [...contentRules].sort());
});

test("content rules name the collections their models really use", () => {
  for (const rule of [...PROPOSAL_DEPENDENTS, ...ACCOUNT_CONTENT]) assert.equal(rule.model.collection.collectionName, rule.name);
  // Every proposal-derived collection of the tenant move is removed with its proposal.
  const dependents = new Set(PROPOSAL_DEPENDENTS.map((rule) => rule.name));
  for (const name of ["vendorresponses", "vendorsubmissions", "vendorsubmissionversions", "vendorsubmissiondrafts", "vendorconfirmationdeliveries", "vendorresponsequestionnaireversions", "proposalcanonicalsnapshots", "publicaccessgrants"]) {
    assert.ok(dependents.has(name), name);
  }
});

// ---- the admins collection --------------------------------------------------------------------

test("the tool never names the staff/admin collection or its model", () => {
  for (const [file, source] of [["scripts/purgeTestAccounts.ts", scriptSource], ["src/modules/accountPurge/purgeAccountContent.ts", moduleSource]]) {
    assert.doesNotMatch(source, /adminModel/, `${file} imports the admin model`);
    assert.doesNotMatch(source, /\bAdmin\s*\.\s*(collection|find|delete|update|count)/, `${file} queries the admin model`);
    assert.doesNotMatch(source, /collection\(\s*["'`]admins["'`]\s*\)/, `${file} opens the admins collection`);
  }
  assert.equal(COLLECTION_DECISIONS.admins.decision, "left");
  // Accounts are looked up in the customer users collection, and only there.
  assert.match(moduleSource, /const users = await User\.collection\s*\.find\(\{ \$or: input\.emails\.map\(\(email\) => \(\{ email: exact\(email\) \}\)\) \}/);
});

test("the content module writes through the raw driver only, by id or by proposal id", () => {
  const writes = [...moduleSource.matchAll(/\.(deleteMany|deleteOne|updateMany|updateOne|insertOne|insertMany|bulkWrite|replaceOne|findOneAndDelete|findOneAndUpdate)\(/g)].map((m) => m[1]);
  assert.deepEqual(writes, ["deleteMany", "deleteMany"]);
  assert.match(moduleSource, /model\.collection\.deleteMany\(\{ _id: \{ \$in: ids\.map\(oid\) \} \}\)/);
  assert.match(moduleSource, /rule\.model\.collection\.deleteMany\(\{ \[rule\.field\]: oid\(proposalId\) \}\)/);
  // The proposal collection itself is only ever read here: the product deletes proposals.
  assert.doesNotMatch(moduleSource, /Proposal\.collection\.(delete|update|insert|replace|bulk)/);
  assert.doesNotMatch(scriptSource, /Proposal\.(deleteMany|deleteOne|findOneAndDelete|collection)/);
});

// ---- refusals ----------------------------------------------------------------------------------

const customer = { id: "org1", name: "DXG", kind: "customer" };
const proposal = (id, ownerUserId, organizationId = "org1") => ({ id, ownerUserId, organizationId, archived: false, titled: true });

test("a proposal not owned by a purged account refuses the run", () => {
  const targeted = new Set(["ana", "ben"]);
  assert.deepEqual(ownershipViolations([proposal("p1", "ana"), proposal("p2", "ben")], targeted), []);
  assert.deepEqual(ownershipViolations([proposal("p1", "ana"), proposal("p2", "carol"), proposal("p3", null)], targeted), [
    "proposal p2: its owner is not one of the accounts being purged",
    "proposal p3: its owner is not one of the accounts being purged",
  ]);
  assert.equal(contentRefusals({ proposals: [proposal("p2", "carol")], targetedUserIds: targeted, organizations: [customer], postgresEnabled: true }).length, 1);
});

test("legacy holding organizations, unknown organizations and proposals with no organization refuse the run", () => {
  const targeted = new Set(["ana"]);
  const refuse = (input) => contentRefusals({ proposals: [], targetedUserIds: targeted, organizations: [customer], postgresEnabled: true, ...input });
  assert.deepEqual(refuse({}), []);
  assert.match(refuse({ organizations: [customer, { id: "h1", name: "Ana (legacy)", kind: "legacy_holding" }] })[0], /Ana \(legacy\) \(h1\): kind legacy_holding/);
  assert.match(refuse({ organizations: [{ id: "gone", missing: true }] })[0], /organization gone: not found/);
  assert.match(refuse({ proposals: [proposal("p1", "ana", null)] })[0], /proposal p1: has no organization/);
});

test("the run is refused when the artifact purge would be skipped", () => {
  const input = { targetedUserIds: new Set(["ana"]), organizations: [customer], postgresEnabled: false };
  assert.match(contentRefusals({ ...input, proposals: [proposal("p1", "ana")] })[0], /PostgreSQL is not enabled/);
  assert.deepEqual(contentRefusals({ ...input, proposals: [] }), [], "an account with no proposal needs no artifact purge");
});

test("a proposal with a source document the product will not delete refuses the run", () => {
  assert.deepEqual(sourceRefusals([]), []);
  // Ordinary documents, whatever their status, are the product's to tombstone.
  assert.deepEqual(sourceRefusals([{ proposalId: "p1", live: 4, held: 0, expired: 0 }]), []);
  const refused = sourceRefusals([{ proposalId: "p1", live: 3, held: 2, expired: 0 }, { proposalId: "p2", live: 2, held: 1, expired: 1 }, { proposalId: "p3", live: 1, held: 0, expired: 0 }]);
  assert.equal(refused.length, 3);
  assert.match(refused[0], /^proposal p1: 2 private source document\(s\) under legal hold or unexpired retention/);
  assert.match(refused[1], /^proposal p2: 1 private source document\(s\) under legal hold or unexpired retention/);
  assert.match(refused[2], /^proposal p2: 1 private source document\(s\) in status expired/);
});

// What the script refuses up front is what the product's purge counts as not deletable.
test("the up-front source check reads what the product's purge leaves alone, and writes no source status", () => {
  const purge = fs.readFileSync(path.join(root, "src/modules/dataFoundation/purgeProposalArtifacts.ts"), "utf8");
  assert.ok(purge.includes("(s.legal_hold OR coalesce(s.retention_until > now(), false)) AS protected"));
  assert.ok(scriptSource.includes("count(*) FILTER (WHERE s.legal_hold OR coalesce(s.retention_until > now(), false))::int AS held"));
  assert.ok(scriptSource.includes("count(*) FILTER (WHERE s.status = 'expired' AND NOT (s.legal_hold OR coalesce(s.retention_until > now(), false)))::int AS expired"));
  const helper = fs.readFileSync(path.join(root, "src/modules/documentIngestion/sourceDeletionTransitions.ts"), "utf8");
  assert.match(helper, /const DIRECTLY_DELETABLE = \["pending_upload", "uploaded", "scan_failed", "ready", "blocked"\];/, "the statuses with a way to deleted changed: re-read the script's expired check");
  for (const source of [scriptSource, moduleSource]) assert.doesNotMatch(source, /UPDATE\s+rfpilot\.document_sources|INSERT INTO rfpilot|DELETE FROM rfpilot/i);
});

// ---- the actor the product path is given -------------------------------------------------------

test("the product path runs as the owner and can reach nothing the owner does not own", () => {
  const org = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const ana = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const carol = "cccccccccccccccccccccccc";
  const actor = ownerOnlyActor(org, ana);
  const own = { id: "dddddddddddddddddddddddd", organizationId: org, ownerUserId: ana, teamId: null };
  const colleagues = { id: "eeeeeeeeeeeeeeeeeeeeeeee", organizationId: org, ownerUserId: carol, teamId: "ffffffffffffffffffffffff" };
  for (const action of ["archive", "delete"]) {
    assert.deepEqual(canAccessRfp(actor, own, action), { allowed: true });
    assert.deepEqual(canAccessRfp(actor, colleagues, action), { allowed: false, reason: "forbidden" });
    assert.deepEqual(canAccessRfp(actor, { ...own, organizationId: "999999999999999999999999" }, action), { allowed: false, reason: "not_found" });
  }
  // No role that sees the whole organization, no managed team, no share: the delete filter is ownership alone.
  assert.deepEqual(actor.roles, ["planner"]);
  assert.deepEqual(actor.managedTeamIds, []);
  assert.equal(actor.shares.size, 0);
  const scope = rfpListScope(actor, "delete");
  assert.equal(String(scope.organizationId), org);
  assert.deepEqual(scope.$or.map((clause) => Object.keys(clause)), [["userId"]]);
  assert.equal(String(scope.$or[0].userId), ana);
});

// ---- applying: order and stop rules -------------------------------------------------------------

const account = (email, proposals, extra = {}) => ({
  userId: `id-${email}`, email, organizations: [], documents: {}, storedObjectKeys: [],
  proposals: proposals.map((id) => proposal(id, `id-${email}`)), ...extra,
});

const ports = (overrides = {}) => {
  const calls = [];
  const state = new Map();
  const base = {
    proposalState: async (id) => { calls.push(`state ${id}`); return state.has(id) ? state.get(id) : { ownerUserId: `id-${id.split(":")[0]}`, organizationId: "org1", archived: false }; },
    archive: async (t) => { calls.push(`archive ${t.proposalId}`); return { kind: "archived" }; },
    permanentlyDelete: async (t) => { calls.push(`delete ${t.proposalId}`); return { kind: "deleted", artifactsPurged: true }; },
    liveSourceDocuments: async (t) => { calls.push(`check ${t.proposalId}`); return 0; },
    deleteProposalDependents: async (id) => { calls.push(`dependents ${id}`); return { vendorresponses: 2 }; },
    deleteStoredObject: async (key) => { calls.push(`object ${key}`); },
    deleteAccountContent: async (a) => { calls.push(`content ${a.email}`); return { supporttickets: 1 }; },
  };
  return { calls, state, ports: { ...base, ...overrides } };
};
const plan = (...accounts) => ({ accounts, refused: [], organizationIds: ["org1"] });

test("a proposal is archived, stripped of its dependents, deleted by the product, then checked", async () => {
  const { calls, ports: p } = ports();
  const deleted = await runContentPurge(plan(account("ana", ["ana:1", "ana:2"], { storedObjectKeys: ["k1"] }), account("ben", ["ben:1"])), p);
  assert.deepEqual(calls, [
    "state ana:1", "archive ana:1", "dependents ana:1", "delete ana:1", "check ana:1",
    "state ana:2", "archive ana:2", "dependents ana:2", "delete ana:2", "check ana:2",
    "object k1", "content ana",
    "state ben:1", "archive ben:1", "dependents ben:1", "delete ben:1", "check ben:1",
    "content ben",
  ]);
  assert.deepEqual(deleted, { vendorresponses: 6, proposals: 3, storedSupportFiles: 1, supporttickets: 2 });
});

test("the product is called as the proposal's owner in the proposal's organization", async () => {
  const seen = [];
  const { ports: p } = ports({ permanentlyDelete: async (t) => { seen.push(t); return { kind: "deleted", artifactsPurged: true }; } });
  await runContentPurge(plan(account("ana", ["ana:1"])), p);
  assert.deepEqual(seen, [{ proposalId: "ana:1", organizationId: "org1", ownerUserId: "id-ana" }]);
});

test("an already archived proposal is not archived again, and one already gone is skipped", async () => {
  const { calls, state, ports: p } = ports();
  state.set("ana:1", { ownerUserId: "id-ana", organizationId: "org1", archived: true });
  state.set("ana:2", null);
  const deleted = await runContentPurge(plan(account("ana", ["ana:1", "ana:2"])), p);
  assert.deepEqual(calls, ["state ana:1", "dependents ana:1", "delete ana:1", "check ana:1", "state ana:2", "content ana"]);
  assert.equal(deleted.proposals, 1);
});

const stopsAt = async (overrides, expected, before = () => {}) => {
  const harness = ports(overrides);
  before(harness);
  await assert.rejects(
    () => runContentPurge(plan(account("ana", ["ana:1", "ana:2"], { storedObjectKeys: ["k1"] }), account("ben", ["ben:1"])), harness.ports),
    (error) => {
      assert.ok(error instanceof ContentPurgeError);
      assert.equal(error.detail.email, "ana");
      for (const [key, value] of Object.entries(expected)) assert.equal(error.detail[key], value, key);
      return true;
    },
  );
  // Nothing after the failure: not the next proposal, not the account's own content, not the next account.
  assert.ok(!harness.calls.some((call) => /ana:2|ben|content|object/.test(call)), harness.calls.join(", "));
  return harness.calls;
};

test("a product refusal or error stops the run at that proposal, before anything else is touched", async () => {
  await stopsAt({ archive: async () => ({ kind: "not_found" }) }, { step: "archive", proposalId: "ana:1", reason: "the product answered not_found" });
  await stopsAt({ archive: async () => { throw new Error("You don't have access to this proposal"); } }, { step: "archive", proposalId: "ana:1", reason: "You don't have access to this proposal" });
  const calls = await stopsAt({ permanentlyDelete: async () => ({ kind: "not_found" }) }, { step: "permanent delete", proposalId: "ana:1" });
  assert.deepEqual(calls, ["state ana:1", "archive ana:1", "dependents ana:1"]);
  await stopsAt({ permanentlyDelete: async () => { throw new Error("mongo is down"); } }, { step: "permanent delete", proposalId: "ana:1", reason: "mongo is down" });
});

test("a permanent delete whose artifact purge did not finish stops the run and reports the purge's result", async () => {
  const purge = { errorCode: "AccessDenied", sources: { tombstoned: 1, pending: 2, notDeletable: 0 } };
  const calls = await stopsAt({ permanentlyDelete: async () => ({ kind: "deleted", artifactsPurged: false, purge }) }, {
    step: "artifact purge", proposalId: "ana:1",
    reason: "the proposal was deleted but its artifact purge did not finish (errorCode AccessDenied); sources tombstoned 1, still deletion_pending 2, not deletable 0; the product's daily reconciler retries the pending ones",
  });
  assert.deepEqual(calls, ["state ana:1", "archive ana:1", "dependents ana:1"]);
  // No verdict at all is not a pass.
  await stopsAt({ permanentlyDelete: async () => ({ kind: "deleted" }) }, { step: "artifact purge", proposalId: "ana:1" });
  // The product said complete, but a source is still live.
  await stopsAt({ liveSourceDocuments: async () => 3 }, { step: "artifact purge", proposalId: "ana:1", reason: "the product reported the purge complete but 3 private source document(s) of the deleted proposal are still live" });
});

test("a failed artifact purge still counts the proposal the product deleted", async () => {
  const harness = ports({ permanentlyDelete: async () => ({ kind: "deleted", artifactsPurged: false }) });
  await assert.rejects(() => runContentPurge(plan(account("ana", ["ana:1"])), harness.ports), (error) => {
    assert.deepEqual(error.deletedSoFar, { vendorresponses: 2, proposals: 1 });
    return true;
  });
});

test("a proposal that changed owner or organization since the plan is not handed to the product", async () => {
  for (const changed of [{ ownerUserId: "id-carol", organizationId: "org1", archived: false }, { ownerUserId: "id-ana", organizationId: "org2", archived: false }]) {
    const calls = await stopsAt({}, { step: "ownership check", proposalId: "ana:1" }, ({ state }) => state.set("ana:1", changed));
    assert.deepEqual(calls, ["state ana:1"]);
  }
});

test("a stored file that cannot be deleted keeps its ticket and stops the run", async () => {
  const harness = ports({ deleteStoredObject: async () => { throw new Error("AccessDenied"); } });
  await assert.rejects(
    () => runContentPurge(plan(account("ana", [], { storedObjectKeys: ["k1"] }), account("ben", ["ben:1"])), harness.ports),
    (error) => error instanceof ContentPurgeError && error.detail.step === "deleting a stored support attachment" && error.detail.reason === "AccessDenied",
  );
  assert.deepEqual(harness.calls, []);
});

test("a failure reports what was already deleted", async () => {
  const harness = ports({ permanentlyDelete: async (t) => (t.proposalId === "ana:2" ? { kind: "not_found" } : { kind: "deleted", artifactsPurged: true }) });
  await assert.rejects(() => runContentPurge(plan(account("ana", ["ana:1", "ana:2"])), harness.ports), (error) => {
    assert.deepEqual(error.deletedSoFar, { vendorresponses: 4, proposals: 1 });
    assert.equal(error.detail.proposalId, "ana:2");
    return true;
  });
});

// ---- the report -----------------------------------------------------------------------------------

test("the report counts each document once and carries ids and counts, never content", () => {
  const ana = account("ana", ["p1", "p2"], { documents: { emailcampaigns: ["c1", "c2"], vendorresponses: ["r1"], rfpshares: [] }, storedObjectKeys: ["k1"], organizations: [{ id: "org1", name: "DXG", kind: "customer", roles: ["planner"], status: "active" }] });
  const ben = account("ben", [], { documents: { emailcampaigns: ["c2"] } });
  const p = plan(ana, ben);
  assert.deepEqual(doomedProposalIds(p), ["p1", "p2"]);
  assert.deepEqual(contentTotals(p), { proposals: 2, emailcampaigns: 2, vendorresponses: 1, storedSupportFiles: 1 });
  assert.deepEqual(describeAccounts(p), [
    {
      email: "ana",
      organizations: [{ organization: "DXG (customer)", id: "org1", roles: ["planner"], status: "active" }],
      proposals: { count: 2, withTitle: 2, alreadyArchived: 0, ids: ["p1", "p2"] },
      wouldDelete: { proposals: 2, emailcampaigns: 2, vendorresponses: 1, storedSupportFiles: 1 },
    },
    { email: "ben", organizations: [], proposals: { count: 0, withTitle: 0, alreadyArchived: 0, ids: [] }, wouldDelete: { emailcampaigns: 1 } },
  ]);
  assert.deepEqual(contentTotals(plan()), {});
});

// ---- the script ------------------------------------------------------------------------------------

test("without --with-content the script takes none of the new code", () => {
  const main = scriptSource.slice(scriptSource.indexOf("const main = async () => {"));
  // The flag's branch is the only way in, and it sits after the listing and before the old report.
  assert.match(main, /if \(emails\.length === 0\) return await listDomain\(domain!\);\n\s+if \(withContent\) return await purgeWithContent\(\);\n\s+const p = await plan\(\);/);
  assert.match(scriptSource, /const withContent = args\.get\("--with-content"\) === "true";/);
  assert.equal([...scriptSource.matchAll(/purgeWithContent\(\)/g)].length, 1);
  // The old report lines are as they were.
  assert.ok(main.includes('if (total === 0) return print({ mode: "nothing-found", ...summary });'));
  assert.ok(main.includes('if (p.refused.length) return print({ mode: "refused", ...summary, wouldDelete: p.counts });'));
  assert.ok(main.includes('if (!apply) return print({ mode: "dry-run", ...summary, wouldDelete: p.counts });'));
  assert.ok(main.includes('print({ mode: "applied", ...summary, deleted: await p.run() });'));
  // The content module, the product, storage and Postgres are loaded inside the branch only.
  const top = scriptSource.slice(0, scriptSource.indexOf("const purgeWithContent"));
  assert.doesNotMatch(top, /accountPurge|proposals\/composition|s3PrivateDocumentStorage|config\/postgres|purgeProposalArtifacts|mongoProposalWriteRepository/);
});

test("a dry run returns before the product or storage are even loaded, and reads Postgres in a read-only transaction", () => {
  const branch = scriptSource.slice(scriptSource.indexOf("const purgeWithContent"), scriptSource.indexOf("const main = async () => {"));
  const dryRunReturn = branch.indexOf('if (!apply) return print({ mode: "dry-run"');
  assert.ok(dryRunReturn > 0);
  for (const loaded of ["proposals/composition", "mongoProposalWriteRepository", "dataFoundation/purgeProposalArtifacts", "s3PrivateDocumentStorage", "migrationVerification", "withPostgresTransaction(async", "runContentPurge(", ".run()"]) {
    assert.ok(branch.indexOf(loaded, 0) > dryRunReturn || (loaded === "withPostgresTransaction(async" && branch.indexOf(loaded) > dryRunReturn), `${loaded} is reachable in a dry run`);
  }
  // The one Postgres read before that point cannot write.
  const beforeDryRun = branch.slice(0, dryRunReturn);
  assert.equal([...beforeDryRun.matchAll(/\.query(<[^(]*>)?\(/g)].length, 6);
  // In particular it cannot set the product's purge marker: that is written by the permanent delete only.
  assert.doesNotMatch(scriptSource + moduleSource, /purgeStarted/);
  assert.ok(beforeDryRun.indexOf('client.query("BEGIN READ ONLY")') > 0);
  assert.ok(beforeDryRun.indexOf('client.query("BEGIN READ ONLY")') < beforeDryRun.indexOf("set_config"));
  assert.doesNotMatch(beforeDryRun, /INSERT|UPDATE|DELETE|COMMIT|withPostgresTransaction\(/);
  // Refusal and nothing-found return even earlier.
  assert.ok(branch.indexOf('mode: "refused"') < dryRunReturn);
  assert.ok(branch.indexOf('mode: "nothing-found"') < dryRunReturn);
});

test("the permanent delete is the product's own function, repository and purge", () => {
  const composition = fs.readFileSync(path.join(root, "src/modules/proposals/composition.ts"), "utf8");
  assert.match(composition, /export const permanentlyDeleteOwnedProposal = createPermanentlyDeleteOwnedProposal\(\s*mongoProposalWriteRepository,/);
  assert.match(composition, /return purgeProposalArtifacts\(targets\);/);
  assert.match(scriptSource, /const permanentlyDeleteOwnedProposal = createPermanentlyDeleteOwnedProposal\(mongoProposalWriteRepository, async \(purgeTargets\) => \{\n\s+const results = purgeTargets\.length \? await purgeProposalArtifacts\(purgeTargets\) : \[\];/);
  assert.match(scriptSource, /archive: \(target\) => asOwner\(target, \(\) => archiveOwnedProposal\(/);
});

test("accounts are removed only after the content, and only when they own no proposal", () => {
  const branch = scriptSource.slice(scriptSource.indexOf("const purgeWithContent"), scriptSource.indexOf("const main = async () => {"));
  const content = branch.indexOf("content.runContentPurge(");
  const failed = branch.indexOf('mode: "failed"');
  const stillOwned = branch.indexOf("const stillOwned = await content.proposalsStillOwnedBy(p.userIds);");
  const accounts = branch.indexOf("await accounts.run()");
  assert.ok(content > 0 && content < failed && failed < stillOwned && stillOwned < accounts);
  assert.equal([...branch.matchAll(/\.run\(\)/g)].length, 1, "one place removes accounts");
  assert.match(branch, /if \(stillOwned\.length \|\| accounts\.refused\.length\) \{\n\s+process\.exitCode = 1;/);
  assert.match(branch, /if \(!\(error instanceof content\.ContentPurgeError\)\) throw error;\n\s+process\.exitCode = 1;/);
});
