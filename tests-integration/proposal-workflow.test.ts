// Workflow repository against real Postgres and real Mongo.
//
// The published phase is the one part of the workflow whose fact does not live
// in the AI domain: whether the RFP has gone out is the Mongo proposal's
// status. The unit tests exercise the projection from facts to steps; only a
// run against both stores proves the fact is actually read from the right one,
// and that the Postgres work does not wait on it.
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { after, before, test } from "node:test";
import Proposal from "../modal/proposalsModel";
import { proposalWorkflowRepository } from "../src/modules/proposalWorkflow/postgresProposalWorkflowRepository";
import {
  closeIntegrationConnections,
  createMongoProposal,
  ensureMigrated,
  ensureServices,
  seedTenant,
  type Tenant,
} from "./setup";

let tenant: Tenant;

const ctx = () => ({
  organizationMongoId: tenant.organizationMongoId,
  actorUserMongoId: tenant.actorUserMongoId,
  proposalMongoId: tenant.proposalMongoId,
});

const setStatus = (status: string) =>
  Proposal.updateOne(
    { _id: new mongoose.Types.ObjectId(tenant.proposalMongoId) },
    { $set: { status } },
  );

before(async () => {
  await ensureServices();
  ensureMigrated();
  tenant = await seedTenant("Workflow Org");
  await createMongoProposal(tenant);
});

after(async () => {
  await Proposal.deleteOne({ _id: new mongoose.Types.ObjectId(tenant.proposalMongoId) });
  await closeIntegrationConnections();
});

test("an unsubmitted proposal is not published, and reading auto-creates the workflow", async () => {
  const result = await proposalWorkflowRepository.read(ctx());

  assert.equal(result.facts.publishStatus, "unsubmitted");
  assert.notEqual(result.state.phase, "published");
  assert.equal(result.workflow.currentStep, 1);
  assert.equal(result.steps.length, 5);
  assert.equal(result.steps[4].status, "available", "publish is not reachable yet");
});

test("submitting the proposal in Mongo publishes the workflow phase", async () => {
  await setStatus("submitted");
  try {
    const result = await proposalWorkflowRepository.read(ctx());

    // Nothing in Postgres changed; the phase moved because the authoritative
    // store says the RFP has gone out.
    assert.equal(result.facts.publishStatus, "submitted");
    assert.equal(result.state.phase, "published");
    assert.equal(result.state.nextAction, "none");
    assert.equal(result.steps[4].status, "complete");
    assert.equal(result.steps[4].summary, "Sent to vendors");
    // Everything before publishing is complete by implication, never by a
    // rule of its own.
    assert.deepEqual(
      result.steps.slice(0, 3).map((step) => step.status),
      ["complete", "complete", "complete"],
    );
  } finally {
    await setStatus("unsubmitted");
  }
});

test("setStep sees the same publish status as read", async () => {
  await setStatus("approved");
  try {
    const result = await proposalWorkflowRepository.setStep({ ...ctx(), step: 3 });
    assert.equal(result.workflow.currentStep, 3);
    // Any status other than "unsubmitted" means the RFP left the building.
    assert.equal(result.state.phase, "published");
    assert.equal(result.steps[4].status, "complete");
  } finally {
    await setStatus("unsubmitted");
  }
});

test("a proposal owned by someone else is refused before either store is trusted", async () => {
  await assert.rejects(() =>
    proposalWorkflowRepository.read({
      ...ctx(),
      actorUserMongoId: new mongoose.Types.ObjectId().toHexString(),
    }),
  );
});

test("the Mongo read runs alongside the Postgres transaction, not before it", async () => {
  // Ordering rather than wall-clock: a duration assertion would be flaky on a
  // loaded machine. If the Mongo read were awaited first, the Postgres work
  // could not begin until it resolved, so the transaction's first query would
  // always start after the find completes.
  const started: string[] = [];
  const find = Proposal.findOne.bind(Proposal);
  let seenPostgresStart = false;

  const pool = (await import("../config/postgres")).postgresPool();
  const connect = pool.connect.bind(pool);
  (pool as unknown as { connect: typeof connect }).connect = ((...args: Parameters<typeof connect>) => {
    if (!seenPostgresStart) { seenPostgresStart = true; started.push("postgres"); }
    return connect(...args);
  }) as typeof connect;
  (Proposal as unknown as { findOne: typeof find }).findOne = ((...args: Parameters<typeof find>) => {
    started.push("mongo-issued");
    const q = find(...args);
    const original = q.exec.bind(q);
    q.exec = (async () => { const value = await original(); started.push("mongo-resolved"); return value; }) as typeof q.exec;
    return q;
  }) as typeof find;

  try {
    await proposalWorkflowRepository.read(ctx());
  } finally {
    (Proposal as unknown as { findOne: typeof find }).findOne = find;
    (pool as unknown as { connect: typeof connect }).connect = connect;
  }

  assert.ok(started.includes("postgres"), "the transaction opened a connection");
  assert.ok(
    started.indexOf("postgres") < started.indexOf("mongo-resolved"),
    `Postgres waited for Mongo: ${started.join(" → ")}`,
  );
});
