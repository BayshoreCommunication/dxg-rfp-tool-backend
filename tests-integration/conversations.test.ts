// Conversation repository against real Postgres: read auto-creates the
// conversation, clarification questions are synced from the latest succeeded
// context run's issues, answering a question appends a question_answer
// message, and appendExchange is idempotent.
//
// The attachments query now selects o.safe_filename from rfpilot.document_objects,
// so read() no longer fails with 42703 once the conversation has a message. The
// workaround this file used to carry — snapshot() and direct SQL for every
// post-message assertion — is gone, and read() is exercised with messages
// present, which is the path that used to break.
import { closeIntegrationConnections, createMongoProposal, ensureMigrated, ensureServices, seedTenant, type Tenant } from "./setup";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import Proposal from "../modal/proposalsModel";
import { postgresPool } from "../config/postgres";
import { conversationRepository } from "../src/modules/conversations/postgresConversationRepository";
import { contextInput } from "../src/modules/proposalContext/domain";
import { proposalContextRepository } from "../src/modules/proposalContext/postgresProposalContextRepository";

let tenant: Tenant;
let conversationId: string;
let questionId: string;
let fieldGapCount: number;

const ctx = () => ({
  organizationMongoId: tenant.organizationMongoId,
  actorUserMongoId: tenant.actorUserMongoId,
  proposalMongoId: tenant.proposalMongoId,
  correlationId: crypto.randomUUID(),
});

before(async () => {
  await ensureServices();
  ensureMigrated();
  tenant = await seedTenant("Conversations Org");
  // conversationRepository.read syncs field-gap questions, which reads the
  // proposal from Mongo. Without a connection every read buffered for ten
  // seconds and then failed.
  await createMongoProposal(tenant);
});

after(async () => {
  await Proposal.deleteOne({ _id: new mongoose.Types.ObjectId(tenant.proposalMongoId) });
  await closeIntegrationConnections();
});

test("read creates the conversation and opens the beginner intake questions", async () => {
  const result = await conversationRepository.read(ctx());
  assert.ok(result.conversation.id);
  conversationId = result.conversation.id;
  assert.equal(result.conversation.messageCount, 0);
  assert.deepEqual(result.messages, []);

  // read syncs field-gap questions from the Mongo proposal, which is the whole
  // reason it needs a Mongo connection. The fixture has only an event name, so
  // the next seven highest-impact fields are asked and eventName
  // is not — a filled field is never asked about.
  assert.deepEqual(
    result.questions.map((question) => question.code),
    [
      "MISSING_FIELD:/content/event/startDate",
      "MISSING_FIELD:/content/event/endDate",
      "MISSING_FIELD:/content/event/eventFormat",
      "MISSING_FIELD:/content/event/eventType/eventType",
      "MISSING_FIELD:/content/venueSchedule/venueName",
      "MISSING_FIELD:/content/venueSchedule/venueCity",
      "MISSING_FIELD:/content/event/attendees",
    ],
  );
  assert.ok(result.questions.every((question) => question.status === "open" && question.contextRunId === null));
  fieldGapCount = result.questions.length;

  const again = await conversationRepository.read(ctx());
  assert.equal(again.conversation.id, conversationId, "read must reuse the existing conversation");
  // The unique index behind ON CONFLICT DO NOTHING is what stops a second read
  // asking the same seven questions again.
  assert.equal(again.questions.length, fieldGapCount, "re-reading must not duplicate the intake");
});

test("issues from a succeeded context run surface as clarification questions", async () => {
  // The medium fixture produces one issue:
  // MISSING_SHOW_END_TIME (severity question, path /content/venueSchedule/showEndTime).
  const correlationId = crypto.randomUUID();
  const run = await proposalContextRepository.create({
    ...ctx(),
    ...contextInput({ fixture: "synthetic-conference-medium" }),
    idempotencyKey: `it-conversations-context:${correlationId}`,
    correlationId,
  });
  await proposalContextRepository.execute({
    organizationMongoId: tenant.organizationMongoId,
    actorUserMongoId: tenant.actorUserMongoId,
    runId: run.runId,
    correlationId,
  });

  const state = await conversationRepository.read(ctx());
  // The extraction issue joins the intake questions rather than replacing them:
  // both are things the planner still has to answer.
  assert.equal(state.questions.length, fieldGapCount + 1);
  const question = state.questions.find((item) => item.code === "MISSING_SHOW_END_TIME");
  assert.ok(question, "the context run's issue is surfaced as a question");
  questionId = question.id;
  assert.equal(question.severity, "question");
  assert.equal(question.status, "open");
  assert.equal(question.contextRunId, run.runId, "unlike a field gap, this one names the run it came from");
  assert.deepEqual(question.paths, ["/content/venueSchedule/showEndTime"]);
  assert.ok(question.prompt.length > 0);

  const snapshot = await conversationRepository.snapshot(ctx());
  assert.equal(snapshot.openQuestions, fieldGapCount + 1);
});


test("answering a question appends a question_answer message and closes it", async () => {
  const answer = "The show ends at 22:00 local time.";
  const updated = await conversationRepository.updateQuestion({
    ...ctx(),
    questionId,
    status: "answered",
    answer,
  });
  assert.equal(updated.status, "answered");
  assert.ok(updated.answeredMessageId);

  // read() with a message present: the case the old attachments join broke on,
  // so it is asserted through the repository rather than around it.
  const state = await conversationRepository.read(ctx());
  assert.equal(state.conversation.messageCount, 1, "the answer becomes the first conversation message");
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].id, updated.answeredMessageId);
  assert.equal(state.messages[0].role, "user");
  assert.equal(state.messages[0].kind, "question_answer");
  assert.equal(state.messages[0].content, answer);
  assert.equal(state.messages[0].status, "complete");
  assert.deepEqual(state.messages[0].attachments, [], "no attachments, but the join still has to run");

  const answered = state.questions.find((item) => item.id === questionId);
  assert.equal(answered?.status, "answered");
  assert.equal(answered?.answeredMessageId, updated.answeredMessageId);
  assert.equal(
    state.questions.filter((item) => item.status === "open").length,
    fieldGapCount,
    "the answered question is no longer open, the intake still is",
  );

  // A resolved question cannot be answered twice.
  await assert.rejects(
    conversationRepository.updateQuestion({ ...ctx(), questionId, status: "answered", answer }),
    (error: unknown) => (error as { code?: string }).code === "QUESTION_NOT_OPEN",
  );
});

test("chat append is durable and a replay returns the same job and placeholder", async () => {
  const baseline = await conversationRepository.snapshot(ctx());
  const idempotencyKey = crypto.randomUUID();
  const first = await conversationRepository.appendExchange({
    ...ctx(),
    idempotencyKey,
    content: "Hello from the integration suite",
    intent: "chat",
    sourceIds: [],
    run: null,
  });
  assert.equal(first.created, true);
  assert.equal(first.message.role, "user");
  assert.equal(first.message.kind, "note");
  assert.ok(first.jobId, "chat acceptance creates the generation job before returning");
  assert.ok(first.assistantMessageId, "chat acceptance creates a pending assistant placeholder");

  const replay = await conversationRepository.appendExchange({
    ...ctx(),
    idempotencyKey,
    content: "Hello from the integration suite",
    intent: "chat",
    sourceIds: [],
    run: null,
  });
  assert.equal(replay.created, false);
  assert.equal(replay.message.id, first.message.id);
  assert.equal(replay.jobId, first.jobId, "an idempotent replay must not create another provider job");
  assert.equal(replay.assistantMessageId, first.assistantMessageId);

  const state = await conversationRepository.read(ctx());
  assert.equal(state.conversation.messageCount, baseline.messageCount + 2, "one chat turn adds the user turn and one assistant placeholder");
  const placeholder = state.messages.find((message) => message.id === first.assistantMessageId);
  assert.equal(placeholder?.role, "assistant");
  assert.equal(placeholder?.status, "pending");
  assert.equal(placeholder?.jobId, first.jobId);
  const rows = await postgresPool().query<{ n: string }>(
    "SELECT count(*) n FROM rfpilot.conversation_messages WHERE conversation_id=$1 AND idempotency_key=$2",
    [conversationId, idempotencyKey],
  );
  assert.equal(Number(rows.rows[0].n), 1);
  const durable = await postgresPool().query<{ job_type: string; status: string; input_reference: string; outbox_count: string }>(
    `SELECT j.job_type,j.status,j.input_reference,
            (SELECT count(*) FROM rfpilot.outbox_events e
              WHERE e.aggregate_id=j.id::text AND e.event_type='job.queued')::text outbox_count
       FROM rfpilot.ai_jobs j WHERE j.id=$1`,
    [first.jobId],
  );
  assert.equal(durable.rows.length, 1);
  assert.equal(durable.rows[0].job_type, "conversation_chat");
  assert.equal(durable.rows[0].status, "queued");
  assert.equal(durable.rows[0].input_reference, first.message.id);
  assert.equal(Number(durable.rows[0].outbox_count), 1, "the job is recoverable from exactly one outbox event");
});
