const assert = require("node:assert/strict");
const test = require("node:test");
const {
  deriveLifecycleStage,
  isPublished,
  isTransition,
} = require("../src/modules/proposalLifecycle/domain");
const {
  backfillChange,
  createProposalLifecycle,
  ProposalLifecycleConflictError,
} = require("../src/modules/proposalLifecycle/application");
const {
  withDeletionLifecycle,
  withSubmissionLifecycle,
} = require("../src/modules/vendorResponses/infrastructure/lifecycle/vendorResponseLifecycle");
const {
  createArchiveOwnedProposal,
  createRestoreOwnedProposal,
  createUpdateOwnedProposalMeta,
  createUpdateOwnedProposalStatus,
} = require("../src/modules/proposals/application/mutateOwnedProposal");
const {
  createCopyOwnedProposal,
  createCreateOwnedProposal,
  createUpdateOwnedProposal,
} = require("../src/modules/proposals/application/authorOwnedProposal");
const { createPublicAccessManager } = require("../src/modules/publicAccess/application/managePublicAccess");

const ORG = "64b000000000000000000001";
const PROPOSAL = "64b000000000000000000002";
const USER = "64b000000000000000000003";
const ref = { organizationId: ORG, proposalId: PROPOSAL };
const published = { status: "submitted", isDraft: false, isArchived: false };

// An in-memory proposal with the repository's compare-and-set semantics.
const memoryRepository = ({ facts = published, state = {}, responded = 0, invited = 0 } = {}) => {
  const store = { facts: { ...facts }, state: { ...state }, transitions: [], applyCalls: 0, responded, invited, interfere: 0 };
  const repository = {
    async load(input) {
      if (input.proposalId !== PROPOSAL || input.organizationId !== ORG) return null;
      return { facts: { ...store.facts }, state: { ...store.state } };
    },
    async listTransitions() {
      return store.transitions;
    },
    async countVendorsResponded() {
      return store.responded;
    },
    async countVendorsInvited() {
      return store.invited;
    },
    async apply({ expected, next, transition }) {
      store.applyCalls += 1;
      // Simulates another writer landing between load and apply.
      if (store.interfere > 0) {
        store.interfere -= 1;
        store.state = { ...store.state, revision: (store.state.revision ?? 0) + 1 };
        return false;
      }
      const same =
        (expected.state.revision ?? null) === (store.state.revision ?? null) &&
        expected.facts.status === store.facts.status &&
        expected.facts.isDraft === store.facts.isDraft &&
        expected.facts.isArchived === store.facts.isArchived;
      if (!same) return false;
      store.state = { ...next };
      if (transition) store.transitions.push(transition);
      return true;
    },
  };
  return { store, repository };
};

const fixedNow = () => new Date("2026-11-09T12:00:00.000Z");

test("stage precedence: archived, draft, awarded, under review, receiving responses, sent", () => {
  assert.equal(deriveLifecycleStage({ ...published, isArchived: true }, { awardedAt: new Date() }), "archived");
  assert.equal(deriveLifecycleStage({ status: "unsubmitted", isDraft: true }, { vendorsResponded: 3 }), "draft");
  assert.equal(deriveLifecycleStage({ status: "submitted", isDraft: true }, {}), "draft");
  assert.equal(deriveLifecycleStage(published, { awardedAt: new Date(), reviewStartedAt: new Date() }), "awarded");
  assert.equal(deriveLifecycleStage(published, { reviewStartedAt: new Date(), vendorsResponded: 2 }), "under_review");
  assert.equal(deriveLifecycleStage(published, { vendorsResponded: 1 }), "receiving_responses");
  assert.equal(deriveLifecycleStage(published, { vendorsInvited: 4 }), "sent");
  assert.equal(deriveLifecycleStage({ status: "rejected", isDraft: false }, {}), "sent");
});

test("a missing status counts as unpublished", () => {
  assert.equal(isPublished({}), false);
  assert.equal(isPublished({ status: "approved" }), true);
});

test("a transition is a stage move, a status move under the same stage, or the first sync", () => {
  assert.equal(isTransition({}, "draft", "unsubmitted"), true);
  assert.equal(isTransition({ stage: "sent", status: "submitted" }, "sent", "submitted"), false);
  assert.equal(isTransition({ stage: "sent", status: "submitted" }, "sent", "rejected"), true);
  assert.equal(isTransition({ stage: "sent", status: "submitted" }, "receiving_responses", "submitted"), true);
});

test("sync records the first stage and bumps the revision", async () => {
  const { store, repository } = memoryRepository({ facts: { status: "unsubmitted", isDraft: true, isArchived: false } });
  const lifecycle = createProposalLifecycle({ repository, now: fixedNow });
  const result = await lifecycle.sync({ ...ref, actor: { type: "user", userId: USER }, reason: "created" });
  assert.equal(result.stage, "draft");
  assert.equal(result.transitioned, true);
  assert.equal(store.state.revision, 1);
  assert.equal(store.state.status, "unsubmitted");
  assert.deepEqual(store.state.changedAt, fixedNow());
  assert.deepEqual(store.transitions, [{
    fromStage: null,
    toStage: "draft",
    fromStatus: null,
    toStatus: "unsubmitted",
    actor: { type: "user", userId: USER },
    reason: "created",
    at: fixedNow(),
  }]);
});

test("a sync that changes nothing writes no transition", async () => {
  const { store, repository } = memoryRepository({ state: { revision: 3, stage: "sent", status: "submitted" } });
  const lifecycle = createProposalLifecycle({ repository, now: fixedNow });
  const result = await lifecycle.sync({ ...ref, actor: { type: "system" }, reason: "updated" });
  assert.equal(result.transitioned, false);
  assert.equal(store.transitions.length, 0);
  assert.equal(store.state.revision, 4);
  assert.equal(store.state.changedAt, undefined);
});

test("sync retries a lost compare-and-set and gives up after four attempts", async () => {
  const first = memoryRepository();
  first.store.interfere = 2;
  const result = await createProposalLifecycle({ repository: first.repository }).sync({ ...ref, actor: { type: "system" }, reason: "updated" });
  assert.equal(result.stage, "sent");
  assert.equal(first.store.applyCalls, 3);
  assert.equal(first.store.transitions.length, 1);

  const stuck = memoryRepository();
  stuck.store.interfere = 10;
  await assert.rejects(
    createProposalLifecycle({ repository: stuck.repository }).sync({ ...ref, actor: { type: "system" }, reason: "updated" }),
    ProposalLifecycleConflictError,
  );
  assert.equal(stuck.store.applyCalls, 4);
});

test("record never throws and reports the failure", async () => {
  const { store, repository } = memoryRepository();
  store.interfere = 10;
  const failures = [];
  const lifecycle = createProposalLifecycle({ repository, onSyncFailure: (error, input) => failures.push([error.code, input.reason]) });
  assert.equal(await lifecycle.record({ ...ref, actor: { type: "system" }, reason: "expired" }), null);
  assert.deepEqual(failures, [["PROPOSAL_LIFECYCLE_CONFLICT", "expired"]]);
});

test("a missing proposal is not synced", async () => {
  const { repository } = memoryRepository();
  const lifecycle = createProposalLifecycle({ repository });
  assert.equal(await lifecycle.sync({ organizationId: ORG, proposalId: "64b0000000000000000000ff", actor: { type: "system" }, reason: "updated" }), null);
});

test("recounting responses moves a sent RFP to receiving responses and back", async () => {
  const { store, repository } = memoryRepository({ state: { revision: 1, stage: "sent", status: "submitted" }, responded: 1 });
  const lifecycle = createProposalLifecycle({ repository, now: fixedNow });
  await lifecycle.sync({ ...ref, actor: { type: "vendor" }, reason: "vendor_responded", recount: ["responded"] });
  assert.equal(store.state.stage, "receiving_responses");
  assert.equal(store.state.vendorsResponded, 1);
  store.responded = 0;
  await lifecycle.sync({ ...ref, actor: { type: "user", userId: USER }, reason: "vendor_response_deleted", recount: ["responded"] });
  assert.equal(store.state.stage, "sent");
  assert.deepEqual(store.transitions.map((row) => [row.fromStage, row.toStage, row.reason, row.actor.type]), [
    ["sent", "receiving_responses", "vendor_responded", "vendor"],
    ["receiving_responses", "sent", "vendor_response_deleted", "user"],
  ]);
});

test("review start is set once and keeps the earliest time", async () => {
  const earlier = new Date("2026-10-01T00:00:00.000Z");
  const { store, repository } = memoryRepository({ state: { revision: 1, stage: "receiving_responses", status: "submitted", vendorsResponded: 2, reviewStartedAt: earlier } });
  const lifecycle = createProposalLifecycle({ repository, now: fixedNow });
  await lifecycle.markReviewStarted({ ...ref, actor: { type: "user", userId: USER } });
  assert.deepEqual(store.state.reviewStartedAt, earlier);
  assert.equal(store.state.stage, "under_review");
});

test("a comparison selection awards the RFP and a later shortlist withdraws it", async () => {
  const { store, repository } = memoryRepository({ state: { revision: 1, stage: "under_review", status: "submitted", reviewStartedAt: fixedNow() } });
  const lifecycle = createProposalLifecycle({ repository, now: fixedNow });
  const actor = { type: "user", userId: USER };
  await lifecycle.applyComparisonDecision({ ...ref, actor, decisionType: "selection", decisionId: "decision-1" });
  assert.equal(store.state.stage, "awarded");
  assert.equal(store.state.awardSource, "comparison");
  assert.equal(store.state.awardDecisionId, "decision-1");
  assert.equal(store.state.awardedByUserId, USER);
  await lifecycle.applyComparisonDecision({ ...ref, actor, decisionType: "shortlist", decisionId: "decision-2" });
  assert.equal(store.state.stage, "under_review");
  assert.equal(store.state.awardedAt, null);
  assert.equal(store.state.awardSource, null);
});

test("a comparison never overrides a planner's own award", async () => {
  const awardedAt = new Date("2026-11-01T00:00:00.000Z");
  const { store, repository } = memoryRepository({ state: { revision: 1, stage: "awarded", status: "submitted", awardedAt, awardSource: "manual", awardedByUserId: USER } });
  const lifecycle = createProposalLifecycle({ repository, now: fixedNow });
  await lifecycle.applyComparisonDecision({ ...ref, actor: { type: "user", userId: USER }, decisionType: "no_award", decisionId: "decision-3" });
  assert.equal(store.state.stage, "awarded");
  assert.deepEqual(store.state.awardedAt, awardedAt);
  assert.equal(store.state.awardSource, "manual");
});

test("only a published, unarchived RFP can be marked awarded", async () => {
  const draft = memoryRepository({ facts: { status: "unsubmitted", isDraft: true, isArchived: false } });
  assert.deepEqual(await createProposalLifecycle({ repository: draft.repository }).markAwarded({ ...ref, userId: USER }), { kind: "not_awardable" });
  assert.equal(draft.store.applyCalls, 0);

  const archived = memoryRepository({ facts: { ...published, isArchived: true } });
  assert.deepEqual(await createProposalLifecycle({ repository: archived.repository }).markAwarded({ ...ref, userId: USER }), { kind: "not_awardable" });

  const missing = memoryRepository();
  assert.deepEqual(await createProposalLifecycle({ repository: missing.repository }).markAwarded({ organizationId: ORG, proposalId: "64b0000000000000000000ff", userId: USER }), { kind: "not_found" });
});

test("marking awarded replaces a comparison award, and clearing withdraws it", async () => {
  const { store, repository } = memoryRepository({ state: { revision: 1, stage: "awarded", status: "submitted", awardedAt: new Date("2026-10-01"), awardSource: "comparison", awardDecisionId: "decision-1" } });
  const lifecycle = createProposalLifecycle({ repository, now: fixedNow });
  const awarded = await lifecycle.markAwarded({ ...ref, userId: USER });
  assert.equal(awarded.kind, "awarded");
  assert.equal(awarded.lifecycle.awardSource, "manual");
  assert.deepEqual(awarded.lifecycle.awardedAt, fixedNow());
  assert.equal(awarded.lifecycle.awardDecisionId, null);
  // A second "Mark as awarded" keeps the first award time.
  await lifecycle.markAwarded({ ...ref, userId: USER });
  assert.deepEqual(store.state.awardedAt, fixedNow());

  const cleared = await lifecycle.clearAward({ ...ref, userId: USER });
  assert.equal(cleared.kind, "cleared");
  assert.equal(cleared.lifecycle.stage, "sent");
  assert.deepEqual(store.transitions.map((row) => row.reason), ["award_cleared"]);
});

test("history returns the stored stage and transitions", async () => {
  const { repository } = memoryRepository();
  const lifecycle = createProposalLifecycle({ repository, now: fixedNow });
  await lifecycle.sync({ ...ref, actor: { type: "system" }, reason: "backfill" });
  const history = await lifecycle.history(ref);
  assert.equal(history.stage, "sent");
  assert.equal(history.transitions.length, 1);
  assert.equal(await lifecycle.history({ organizationId: ORG, proposalId: "64b0000000000000000000ff" }), null);
});

test("backfill fills missing review and award facts and never moves recorded ones", () => {
  const runAt = new Date("2026-09-01T00:00:00.000Z");
  const decidedAt = new Date("2026-09-05T00:00:00.000Z");
  const history = { firstRunAt: runAt, latestDecision: { decisionType: "selection", decisionId: "d-1", at: decidedAt, actorUserId: USER } };
  assert.deepEqual(backfillChange(history)({ facts: published, state: {} }), {
    reviewStartedAt: runAt,
    awardedAt: decidedAt,
    awardedByUserId: USER,
    awardSource: "comparison",
    awardDecisionId: "d-1",
  });
  assert.equal(backfillChange(history)({ facts: published, state: { reviewStartedAt: runAt, awardedAt: decidedAt, awardSource: "manual" } }), null);
  assert.deepEqual(
    backfillChange({ firstRunAt: runAt, latestDecision: { decisionType: "no_award", decisionId: "d-2", at: decidedAt, actorUserId: USER } })({ facts: published, state: {} }),
    { reviewStartedAt: runAt },
  );
  assert.equal(backfillChange(null)({ facts: published, state: {} }), null);
});

// Hooks in the proposal use cases.
const recorder = () => {
  const calls = [];
  return { calls, lifecycle: { recordChange: async (input) => { calls.push(input); } } };
};
const proposalDependencies = (lifecycle) => ({
  proposals: {
    createOwned: async ({ proposal }) => ({ _id: PROPOSAL, ...proposal }),
    findOwnedCopySourceById: async () => ({ _id: "64b0000000000000000000aa", status: "submitted", lifecycle: { stage: "awarded" } }),
    findOwnedLifecycleById: async () => ({ isCopy: false }),
    updateOwnedById: async ({ updates }) => ({ _id: PROPOSAL, ...updates }),
    archiveOwnedById: async () => true,
    restoreOwnedById: async () => true,
  },
  settings: { findByUserId: async () => ({}) },
  lifecycle,
});

test("every planner write path reports its change after the write", async () => {
  const { calls, lifecycle } = recorder();
  const dependencies = proposalDependencies(lifecycle);
  await createCreateOwnedProposal(dependencies)({ ownerUserId: USER, proposal: { event: {} } });
  await createUpdateOwnedProposal(dependencies)({ proposalId: PROPOSAL, ownerUserId: USER, updates: { notes: "x" } });
  await createCopyOwnedProposal(dependencies)({ proposalId: PROPOSAL, ownerUserId: USER, overrides: {} });
  await createUpdateOwnedProposalStatus(dependencies)({ proposalId: PROPOSAL, ownerUserId: USER, status: "submitted" });
  await createUpdateOwnedProposalMeta(dependencies)({ proposalId: PROPOSAL, ownerUserId: USER, metadata: { isDraft: false } });
  await createArchiveOwnedProposal(dependencies.proposals, lifecycle)({ proposalId: PROPOSAL, ownerUserId: USER });
  await createRestoreOwnedProposal(dependencies.proposals, lifecycle)({ proposalId: PROPOSAL, ownerUserId: USER });
  assert.deepEqual(calls.map((call) => call.reason), ["created", "updated", "copied", "status_changed", "metadata_changed", "archived", "restored"]);
  assert.ok(calls.every((call) => call.proposalId === PROPOSAL && call.actorUserId === USER));
});

test("a miss reports nothing", async () => {
  const { calls, lifecycle } = recorder();
  const dependencies = proposalDependencies(lifecycle);
  dependencies.proposals.updateOwnedById = async () => null;
  dependencies.proposals.archiveOwnedById = async () => false;
  await createUpdateOwnedProposal(dependencies)({ proposalId: PROPOSAL, ownerUserId: USER, updates: {} });
  await createUpdateOwnedProposalStatus(dependencies)({ proposalId: PROPOSAL, ownerUserId: USER, status: "submitted" });
  await createArchiveOwnedProposal(dependencies.proposals, lifecycle)({ proposalId: PROPOSAL, ownerUserId: USER });
  assert.deepEqual(calls, []);
});

test("a client can't write the lifecycle through create, update or copy", async () => {
  const written = [];
  const dependencies = proposalDependencies(recorder().lifecycle);
  dependencies.proposals.createOwned = async ({ proposal }) => { written.push(proposal); return { _id: PROPOSAL, ...proposal }; };
  dependencies.proposals.updateOwnedById = async ({ updates }) => { written.push(updates); return { _id: PROPOSAL, ...updates }; };
  const forged = { lifecycle: { stage: "awarded", awardedAt: new Date() } };
  await createCreateOwnedProposal(dependencies)({ ownerUserId: USER, proposal: { ...forged } });
  await createUpdateOwnedProposal(dependencies)({ proposalId: PROPOSAL, ownerUserId: USER, updates: { ...forged } });
  await createCopyOwnedProposal(dependencies)({ proposalId: PROPOSAL, ownerUserId: USER, overrides: {} });
  assert.equal(written.length, 3);
  assert.ok(written.every((row) => !("lifecycle" in row)));
});

// Vendor response decorators.
const lifecycleSpy = () => {
  const calls = [];
  return { calls, record: async (input) => { calls.push(input); return null; } };
};

test("a new vendor response version recounts responses with the right actor", async () => {
  const spy = lifecycleSpy();
  let created = true;
  const repository = withSubmissionLifecycle({ saveVersion: async () => ({ record: {}, created }) }, spy, () => USER);
  const base = { organizationId: ORG, proposalId: PROPOSAL };
  await repository.saveVersion({ ...base, sourceSystem: "public_portal" });
  await repository.saveVersion({ ...base, sourceSystem: "planner_upload" });
  created = false;
  await repository.saveVersion({ ...base, sourceSystem: "public_portal" });
  assert.deepEqual(spy.calls.map((call) => [call.reason, call.actor, call.recount]), [
    ["vendor_responded", { type: "vendor" }, ["responded"]],
    ["vendor_responded", { type: "user", userId: USER }, ["responded"]],
  ]);
});

test("deleting responses recounts each affected RFP once", async () => {
  const spy = lifecycleSpy();
  const repository = withDeletionLifecycle({ deleteOwnedTargets: async ({ targets }) => targets.length }, spy);
  const other = "64b0000000000000000000bb";
  const deleted = await repository.deleteOwnedTargets({
    ownerUserId: USER,
    targets: [
      { organizationId: ORG, proposalId: PROPOSAL },
      { organizationId: ORG, proposalId: PROPOSAL },
      { organizationId: ORG, proposalId: other },
    ],
  });
  assert.equal(deleted, 3);
  assert.deepEqual(spy.calls.map((call) => [call.proposalId, call.reason, call.actor.userId]), [
    [PROPOSAL, "vendor_response_deleted", USER],
    [other, "vendor_response_deleted", USER],
  ]);
});

test("issuing a vendor response link reports the invitation; a view link does not", async () => {
  const invited = [];
  const manager = createPublicAccessManager(
    { resourceOwned: async () => true, create: async () => ({ id: "grant-1" }) },
    async (input) => { invited.push(input); },
  );
  await manager.issue({ organizationId: ORG, resourceId: PROPOSAL, purpose: "vendor:submit", createdByUserId: USER, recipient: "Vendor@Example.com" });
  await manager.issue({ organizationId: ORG, resourceId: PROPOSAL, purpose: "proposal:view", createdByUserId: USER });
  assert.deepEqual(invited, [{ organizationId: ORG, proposalId: PROPOSAL, createdByUserId: USER }]);
});

test("the public vendor view never carries the lifecycle", () => {
  const { redactProposalForPublicView } = require("../src/modules/proposals/infrastructure/mongo/mongoPublicProposalAccessRepository");
  const redacted = redactProposalForPublicView({
    event: { eventName: "Summit" },
    lifecycle: { stage: "awarded", awardedByUserId: USER, vendorsInvited: 6, vendorsResponded: 4 },
  });
  assert.equal("lifecycle" in redacted, false);
  assert.equal(redacted.event.eventName, "Summit");
});
