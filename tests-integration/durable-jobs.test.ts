// Durable job lifecycle against real Postgres + Redis/BullMQ:
// repository create (outbox row) -> dispatcher.dispatch() -> BullMQ queue ->
// repository.claim/heartbeat/complete -> succeeded, plus idempotent re-create.
//
// The job is created through proposalContextRepository.create (the simplest
// real producer: it needs no S3 upload or ClamAV, only the mock deterministic
// provider), and the worker side is exercised by claiming the queue message
// directly through durableJobRepository, mirroring what worker.ts does.
import { ensureMigrated, ensureServices, seedTenant, type Tenant } from "./setup";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { closePostgres, postgresPool } from "../config/postgres";
import { durableJobDispatcher, durableJobRepository } from "../src/modules/durableJobs/composition";
import type { QueueMessage } from "../src/modules/durableJobs/domain";
import { closeQueue, sourceSecurityQueue } from "../src/modules/durableJobs/queue";
import { contextInput } from "../src/modules/proposalContext/domain";
import { proposalContextRepository } from "../src/modules/proposalContext/postgresProposalContextRepository";

const WORKER_ID = `integration-worker-${crypto.randomUUID()}`;

let tenant: Tenant;
let idempotencyKey: string;
let jobId: string;
let runId: string;
let message: QueueMessage;

before(async () => {
  await ensureServices();
  ensureMigrated();
  tenant = await seedTenant("Durable Jobs Org");
  idempotencyKey = crypto.randomUUID();
});

after(async () => {
  await closeQueue();
  await closePostgres();
});

test("creating a job writes the job row and a pending outbox event", async () => {
  const created = await proposalContextRepository.create({
    organizationMongoId: tenant.organizationMongoId,
    actorUserMongoId: tenant.actorUserMongoId,
    proposalMongoId: tenant.proposalMongoId,
    ...contextInput({ fixture: "synthetic-conference-simple" }),
    idempotencyKey,
    correlationId: crypto.randomUUID(),
  });
  assert.equal(created.created, true);
  jobId = created.job.id as string;
  runId = created.runId;

  const outbox = await postgresPool().query<{ status: string; payload: QueueMessage }>(
    "SELECT status,payload FROM rfpilot.outbox_events WHERE aggregate_id=$1 AND event_type='job.queued'",
    [jobId],
  );
  assert.equal(outbox.rows.length, 1, "exactly one outbox event for the new job");
  assert.equal(outbox.rows[0].status, "pending");
  assert.equal(outbox.rows[0].payload.jobId, jobId);
  assert.equal(outbox.rows[0].payload.jobType, "proposal_context_extract");
});

test("re-creating with the same idempotency key returns the existing job", async () => {
  const duplicate = await proposalContextRepository.create({
    organizationMongoId: tenant.organizationMongoId,
    actorUserMongoId: tenant.actorUserMongoId,
    proposalMongoId: tenant.proposalMongoId,
    ...contextInput({ fixture: "synthetic-conference-simple" }),
    idempotencyKey,
    correlationId: crypto.randomUUID(),
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.runId, runId);
});

test("dispatch publishes the outbox event onto the BullMQ queue", async () => {
  const result = await durableJobDispatcher.dispatch(100);
  assert.ok(result.published >= 1, `expected at least one published event, got ${JSON.stringify(result)}`);

  const outbox = await postgresPool().query<{ status: string }>(
    "SELECT status FROM rfpilot.outbox_events WHERE aggregate_id=$1 AND event_type='job.queued'",
    [jobId],
  );
  assert.equal(outbox.rows[0].status, "published");

  const queued = await sourceSecurityQueue().getJob(jobId);
  assert.ok(queued, "BullMQ should hold a job keyed by the durable job id");
  message = queued.data;
  assert.equal(message.jobId, jobId);
  assert.equal(message.organizationMongoId, tenant.organizationMongoId);
});

test("claim -> heartbeat -> complete drives the job to succeeded", async () => {
  const claimed = await durableJobRepository.claim({ message, workerId: WORKER_ID, attempt: 1, leaseSeconds: 30 });
  assert.equal(claimed.cancelled, false);
  assert.equal(claimed.job.status, "running");
  assert.equal(claimed.job.attemptCount, 1);

  const alive = await durableJobRepository.heartbeat({
    message,
    workerId: WORKER_ID,
    leaseSeconds: 30,
    progress: 50,
    stage: "halfway",
  });
  assert.equal(alive, true, "heartbeat should extend the lease while the worker owns the job");

  // Do the actual work (mock deterministic extraction), then complete the job.
  await proposalContextRepository.execute({
    organizationMongoId: tenant.organizationMongoId,
    actorUserMongoId: tenant.actorUserMongoId,
    runId,
    correlationId: crypto.randomUUID(),
  });
  const completed = await durableJobRepository.complete({ message, workerId: WORKER_ID, attempt: 1, resultReference: runId });
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.resultReference, runId);

  const fetched = await durableJobRepository.get(tenant.organizationMongoId, jobId);
  assert.equal(fetched.status, "succeeded");
  assert.equal(fetched.progress, 100);
});

test("idempotent re-create after completion still returns the succeeded job", async () => {
  const again = await proposalContextRepository.create({
    organizationMongoId: tenant.organizationMongoId,
    actorUserMongoId: tenant.actorUserMongoId,
    proposalMongoId: tenant.proposalMongoId,
    ...contextInput({ fixture: "synthetic-conference-simple" }),
    idempotencyKey,
    correlationId: crypto.randomUUID(),
  });
  assert.equal(again.created, false);
  assert.equal(again.runId, runId);
  const job = await durableJobRepository.get(tenant.organizationMongoId, jobId);
  assert.equal(job.status, "succeeded");
});
