// Full candidate application path against real Postgres AND real Mongo:
// mock context run -> review decisions -> application -> Mongo mutation with
// version bump, idempotent re-execution, and stale-version conflict handling.
import {
  createMongoProposal,
  ensureMigrated,
  ensureServices,
  seedTenant,
  closeIntegrationConnections,
  type Tenant,
} from "./setup";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import Proposal from "../modal/proposalsModel";
import { candidateApplicationRepository } from "../src/modules/candidateApplication/postgresCandidateApplicationRepository";
import { contextInput } from "../src/modules/proposalContext/domain";
import { proposalContextRepository } from "../src/modules/proposalContext/postgresProposalContextRepository";

type ProposalLean = {
  version?: number;
  candidateApplicationIds?: string[];
  event?: { eventName?: string; eventFormat?: string };
};

let tenant: Tenant;
let runId: string;
let eventNameOperationId: string;
let eventFormatOperationId: string;
let applicationId: string;
let applicationKey: string;

const ids = () => ({
  organizationMongoId: tenant.organizationMongoId,
  actorUserMongoId: tenant.actorUserMongoId,
  proposalMongoId: tenant.proposalMongoId,
});

const readProposal = async (): Promise<ProposalLean> => {
  const row = await Proposal.findById(tenant.proposalMongoId)
    .select("+candidateApplicationIds version event")
    .lean<ProposalLean>();
  assert.ok(row, "Mongo proposal fixture should exist");
  return row;
};

before(async () => {
  await ensureServices();
  ensureMigrated();
  tenant = await seedTenant("Candidate Application Org");
  await createMongoProposal(tenant);

  // Succeeded mock context run: 2 operations
  // (/content/event/eventName, /content/event/eventFormat), 0 issues.
  const correlationId = crypto.randomUUID();
  const created = await proposalContextRepository.create({
    ...ids(),
    ...contextInput({ fixture: "synthetic-conference-simple" }),
    idempotencyKey: `it-cas-context:${correlationId}`,
    correlationId,
  });
  runId = created.runId;
  await proposalContextRepository.execute({ ...ids(), runId, correlationId });
});

after(async () => {
  await closeIntegrationConnections();
});

test("review decisions are saved with optimistic revisions", async () => {
  const review = await candidateApplicationRepository.readReview({ ...ids(), runId });
  assert.equal(review.revision, 0);
  assert.equal(review.operations.length, 2);
  const byPath = new Map<string, string>(review.operations.map((op: { path: string; id: string }) => [op.path, op.id]));
  eventNameOperationId = byPath.get("/content/event/eventName") as string;
  eventFormatOperationId = byPath.get("/content/event/eventFormat") as string;
  assert.ok(eventNameOperationId && eventFormatOperationId);

  const saved = await candidateApplicationRepository.saveReview({
    ...ids(),
    runId,
    revision: 0,
    decisions: [eventNameOperationId, eventFormatOperationId].map((operationId) => ({
      operationId,
      decision: "accepted" as const,
      value: null,
      reason: null,
    })),
  });
  assert.equal(saved.revision, 1);
  assert.equal(saved.savedCount, 2);

  // Stale review revision is rejected.
  await assert.rejects(
    candidateApplicationRepository.saveReview({ ...ids(), runId, revision: 0, decisions: [] }),
    (error: unknown) => (error as { code?: string }).code === "REVIEW_REVISION_CONFLICT",
  );
});

test("applying an accepted candidate mutates Mongo and bumps the version", async () => {
  const beforeDoc = await readProposal();
  assert.equal(beforeDoc.version ?? 1, 1);
  assert.equal(beforeDoc.event?.eventName, "Integration Fixture Event");

  applicationKey = crypto.randomUUID();
  const created = await candidateApplicationRepository.createApplication({
    ...ids(),
    runId,
    expectedProposalVersion: 1,
    operationIds: [eventNameOperationId],
    // event.eventName already holds the fixture value, so overwrite must be confirmed.
    overwriteConfirmedOperationIds: [eventNameOperationId],
    idempotencyKey: applicationKey,
    correlationId: crypto.randomUUID(),
  });
  assert.equal(created.created, true);
  applicationId = created.application.id as string;

  const result = await candidateApplicationRepository.execute({
    organizationMongoId: tenant.organizationMongoId,
    actorUserMongoId: tenant.actorUserMongoId,
    applicationId,
  });
  assert.equal(result.resultReference, applicationId);

  const afterDoc = await readProposal();
  assert.equal(afterDoc.event?.eventName, "Synthetic DXG Conference", "accepted candidate value applied to Mongo");
  assert.equal(afterDoc.version, 2, "proposal version incremented exactly once");
  assert.ok(afterDoc.candidateApplicationIds?.includes(applicationId), "application id recorded on the proposal");

  const read = await candidateApplicationRepository.readApplication({ ...ids(), applicationId });
  assert.equal(read.status, "applied");
  assert.equal(read.resulting_proposal_version, 2);
});

test("re-creating and re-executing the application is idempotent", async () => {
  const duplicate = await candidateApplicationRepository.createApplication({
    ...ids(),
    runId,
    expectedProposalVersion: 1,
    operationIds: [eventNameOperationId],
    overwriteConfirmedOperationIds: [eventNameOperationId],
    idempotencyKey: applicationKey,
    correlationId: crypto.randomUUID(),
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.application.id, applicationId);

  const replay = await candidateApplicationRepository.execute({
    organizationMongoId: tenant.organizationMongoId,
    actorUserMongoId: tenant.actorUserMongoId,
    applicationId,
  });
  assert.equal(replay.resultReference, applicationId);

  const afterDoc = await readProposal();
  assert.equal(afterDoc.version, 2, "replay must not bump the version again");
  assert.equal(afterDoc.candidateApplicationIds?.filter((id) => id === applicationId).length, 1);
});

test("a stale expectedProposalVersion surfaces as a conflict", async () => {
  const stale = await candidateApplicationRepository.createApplication({
    ...ids(),
    runId,
    expectedProposalVersion: 1, // proposal is now at version 2
    operationIds: [eventFormatOperationId],
    overwriteConfirmedOperationIds: [],
    idempotencyKey: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
  });
  assert.equal(stale.created, true);

  await assert.rejects(
    candidateApplicationRepository.execute({
      organizationMongoId: tenant.organizationMongoId,
      actorUserMongoId: tenant.actorUserMongoId,
      applicationId: stale.application.id as string,
    }),
    (error: unknown) => (error as { code?: string }).code === "PROPOSAL_VERSION_CONFLICT",
  );

  const read = await candidateApplicationRepository.readApplication({
    ...ids(),
    applicationId: stale.application.id as string,
  });
  assert.equal(read.status, "conflict");
  assert.equal(read.safe_error_code, "PROPOSAL_VERSION_OR_LIFECYCLE_CONFLICT");

  const afterDoc = await readProposal();
  assert.equal(afterDoc.version, 2, "conflicting application must not touch the proposal");
  assert.equal(afterDoc.event?.eventFormat, undefined, "conflicting candidate value must not be applied");
});
