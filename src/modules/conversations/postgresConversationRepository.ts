/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import { syncFieldGapQuestions } from "./fieldGapQuestions";
import {
  ConversationError,
  IMPORTANT_FIELD_QUESTIONS,
  MAX_OPEN_FIELD_QUESTIONS,
  fieldQuestionCode,
  isCatchAllIssue,
  questionImpact,
  questionAnswerType,
  questionPrompt,
  runStatusMessage,
  type MessageIntent,
} from "./domain";

type Ctx = { organizationMongoId: string; actorUserMongoId: string; correlationId: string };

const tenant = async (c: PoolClient, external: string) => {
  await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [external]);
  const r = await c.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [external],
  );
  if (!r.rows[0]) throw new ConversationError("ORGANIZATION_NOT_READY", "Organization data foundation is unavailable.", 503);
  await c.query("SELECT set_config('app.organization_id',$1,true)", [r.rows[0].id]);
  return r.rows[0].id;
};

const proposal = async (c: PoolClient, id: string, actor: string) => {
  const r = await c.query<{ id: string }>(
    "SELECT p.id FROM rfpilot.proposal_references p JOIN rfpilot.users u ON u.id=p.owner_user_id WHERE p.external_mongo_id=$1 AND u.external_mongo_id=$2 AND u.status='active'",
    [id, actor],
  );
  if (!r.rows[0]) throw new ConversationError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  return r.rows[0].id;
};

const audit = async (c: PoolClient, org: string, actor: string, action: string, targetType: string, targetId: string, correlationId: string, metadata: Record<string, unknown>) => {
  await c.query(
    "INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata) VALUES($1,$2,$3,$4,$5,$6,'allowed',$7,$8::jsonb)",
    [uuidv7(), org, actor, action, targetType, targetId, correlationId, JSON.stringify(metadata)],
  );
};

const getOrCreateConversation = async (c: PoolClient, org: string, proposalRefId: string, actor: string) => {
  const r = await c.query<any>(
    `INSERT INTO rfpilot.conversations(id,organization_id,proposal_reference_id,owner_external_user_id)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(proposal_reference_id) DO UPDATE SET updated_at=now()
     RETURNING *`,
    [uuidv7(), org, proposalRefId, actor],
  );
  return r.rows[0];
};

// Refresh pending assistant messages from their linked run state so a finished
// run becomes a completed assistant turn on the next read (write-on-read).
const materializeRuns = async (c: PoolClient, conversationId: string) => {
  const pending = await c.query<any>(
    "SELECT id,run_type,run_id FROM rfpilot.conversation_messages WHERE conversation_id=$1 AND status='pending' AND run_id IS NOT NULL",
    [conversationId],
  );
  for (const message of pending.rows) {
    const table = message.run_type === "proposal_context" ? "proposal_context_runs" : "proposal_draft_runs";
    const run = await c.query<{ status: string }>(`SELECT status FROM rfpilot.${table} WHERE id=$1`, [message.run_id]);
    const status = run.rows[0]?.status;
    if (!status || ["queued", "running"].includes(status)) continue;
    const messageStatus = status === "succeeded" ? "complete" : "failed";
    await c.query(
      "UPDATE rfpilot.conversation_messages SET status=$2,content=$3,updated_at=now() WHERE id=$1",
      [message.id, messageStatus, runStatusMessage(message.run_type, status)],
    );
  }
};

const latestSucceededContextRun = async (c: PoolClient, proposalRefId: string) => {
  const r = await c.query<{ id: string }>(
    "SELECT id FROM rfpilot.proposal_context_runs WHERE proposal_reference_id=$1 AND status='succeeded' ORDER BY created_at DESC LIMIT 1",
    [proposalRefId],
  );
  return r.rows[0]?.id ?? null;
};

// Promote extraction issues from the latest succeeded run into clarification
// questions with a lifecycle; questions from older runs are superseded.
const syncQuestions = async (c: PoolClient, org: string, proposalRefId: string, conversationId: string) => {
  const runId = await latestSucceededContextRun(c, proposalRefId);
  if (!runId) return;
  await c.query(
    "UPDATE rfpilot.clarification_questions SET status='superseded',updated_at=now() WHERE proposal_reference_id=$1 AND status='open' AND context_run_id<>$2",
    [proposalRefId, runId],
  );
  const issues = await c.query<{ code: string; severity: string; paths: string[] }>(
    "SELECT code,severity,paths FROM rfpilot.proposal_context_issues WHERE run_id=$1 ORDER BY ordinal",
    [runId],
  );
  const insertQuestion = (code: string, severity: string, paths: string[], prompt: string) =>
    c.query<{ id: string }>(
      `INSERT INTO rfpilot.clarification_questions(id,organization_id,proposal_reference_id,conversation_id,context_run_id,issue_code,severity,canonical_paths,prompt)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       ON CONFLICT(proposal_reference_id,context_run_id,issue_code) DO NOTHING
       RETURNING id`,
      [uuidv7(), org, proposalRefId, conversationId, runId, code, severity, JSON.stringify(paths), prompt.slice(0, 1000)],
    );
  for (const issue of issues.rows) {
    const paths = issue.paths || [];
    if (isCatchAllIssue(issue.code, paths)) {
      // A broad "missing fields" issue never becomes one giant card. It is
      // exploded into individual questions — one whitelisted high-impact field
      // each, in whitelist priority order, capped at MAX_OPEN_FIELD_QUESTIONS
      // open at once. As earlier ones get answered or dismissed, later
      // whitelist fields are backfilled on the next sync.
      const open = await c.query<{ n: number }>(
        "SELECT count(*)::int n FROM rfpilot.clarification_questions WHERE proposal_reference_id=$1 AND context_run_id=$2 AND status='open' AND issue_code LIKE 'MISSING_FIELD:%'",
        [proposalRefId, runId],
      );
      let budget = MAX_OPEN_FIELD_QUESTIONS - Number(open.rows[0]?.n ?? 0);
      for (const field of IMPORTANT_FIELD_QUESTIONS) {
        if (budget <= 0) break;
        if (!paths.includes(field.path)) continue;
        const inserted = await insertQuestion(fieldQuestionCode(field.path), issue.severity, [field.path], field.prompt);
        if (inserted.rows[0]) budget -= 1;
      }
      continue;
    }
    await insertQuestion(issue.code, issue.severity, paths, questionPrompt(issue.code, paths));
  }
};

const messagePayload = (row: any, attachments: any[]) => ({
  id: row.id,
  ordinal: row.ordinal,
  role: row.role,
  kind: row.kind,
  content: row.content,
  intent: row.intent,
  runType: row.run_type,
  runId: row.run_id,
  jobId: row.job_id,
  status: row.status,
  createdAt: row.created_at,
  attachments: attachments.filter((a) => a.message_id === row.id).map((a) => ({ sourceId: a.source_id, role: a.role, filename: a.safe_filename ?? null, sourceStatus: a.source_status ?? null })),
});

export const conversationRepository = {
  async read(ctx: Ctx & { proposalMongoId: string; limit?: number }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      const proposalRefId = await proposal(c, ctx.proposalMongoId, ctx.actorUserMongoId);
      const conversation = await getOrCreateConversation(c, org, proposalRefId, ctx.actorUserMongoId);
      await materializeRuns(c, conversation.id);
      await syncQuestions(c, org, proposalRefId, conversation.id);
      // Key questions must also appear when there are no sources at all, so a
      // proposal started by conversation still gets asked what matters.
      await syncFieldGapQuestions(c, org, proposalRefId, conversation.id, {
        organizationMongoId: ctx.organizationMongoId,
        actorUserMongoId: ctx.actorUserMongoId,
        proposalMongoId: ctx.proposalMongoId,
      });
      const limit = Math.min(Math.max(ctx.limit ?? 200, 1), 500);
      const messages = await c.query<any>(
        "SELECT * FROM rfpilot.conversation_messages WHERE conversation_id=$1 ORDER BY ordinal DESC LIMIT $2",
        [conversation.id, limit],
      );
      const rows = messages.rows.reverse();
      const attachments = rows.length
        ? (await c.query<any>(
            `SELECT a.message_id,a.source_id,a.role,o.safe_filename,s.status source_status
             FROM rfpilot.conversation_message_attachments a
             JOIN rfpilot.document_sources s ON s.id=a.source_id
             LEFT JOIN rfpilot.document_objects o ON o.source_id=s.id
             WHERE a.message_id=ANY($1::uuid[])`,
            [rows.map((row) => row.id)],
          )).rows
        : [];
      const questions = await c.query<any>(
        "SELECT id,issue_code,severity,canonical_paths,prompt,status,answered_message_id,context_run_id,created_at FROM rfpilot.clarification_questions WHERE proposal_reference_id=$1 AND status IN('open','answered') ORDER BY created_at",
        [proposalRefId],
      );
      return {
        conversation: { id: conversation.id, title: conversation.title, status: conversation.status, messageCount: conversation.message_count, updatedAt: conversation.updated_at },
        messages: rows.map((row) => messagePayload(row, attachments)),
        questions: questions.rows.map((q) => {
          const paths: string[] = Array.isArray(q.canonical_paths) ? q.canonical_paths : [];
          const { answerType, options } = questionAnswerType(paths);
          return {
            id: q.id,
            code: q.issue_code,
            severity: q.severity,
            paths: q.canonical_paths,
            prompt: q.prompt,
            status: q.status,
            impact: questionImpact(paths),
            // The control the dashboard renders (date picker, choice pills,
            // number or free text) plus the exact option strings to submit.
            answerType,
            options: options ? [...options] : [],
            // Pairs an answered question with the answer message it produced so
            // the thread can show what was asked above the answer.
            answeredMessageId: q.answered_message_id ?? null,
            contextRunId: q.context_run_id,
            createdAt: q.created_at,
          };
        }),
      };
    });
  },

  async appendExchange(ctx: Ctx & {
    proposalMongoId: string;
    idempotencyKey: string;
    content: string;
    intent: MessageIntent;
    sourceIds: string[];
    run: { runType: "proposal_context" | "proposal_draft"; runId: string; jobId: string | null } | null;
  }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      const proposalRefId = await proposal(c, ctx.proposalMongoId, ctx.actorUserMongoId);
      const conversation = await getOrCreateConversation(c, org, proposalRefId, ctx.actorUserMongoId);
      await c.query("SELECT id FROM rfpilot.conversations WHERE id=$1 FOR UPDATE", [conversation.id]);
      const existing = await c.query<any>(
        "SELECT * FROM rfpilot.conversation_messages WHERE conversation_id=$1 AND idempotency_key=$2",
        [conversation.id, ctx.idempotencyKey],
      );
      if (existing.rows[0]) return { created: false, message: messagePayload(existing.rows[0], []) };
      if (ctx.sourceIds.length) {
        const sources = await c.query<{ id: string }>(
          "SELECT id FROM rfpilot.document_sources WHERE id=ANY($1::uuid[]) AND organization_id=$2 AND proposal_reference_id=$3 AND deleted_at IS NULL",
          [ctx.sourceIds, org, proposalRefId],
        );
        if (sources.rows.length !== ctx.sourceIds.length)
          throw new ConversationError("INVALID_MESSAGE_SOURCES", "A selected source does not belong to this proposal.", 404);
      }
      const count = await c.query<{ n: number }>("SELECT message_count n FROM rfpilot.conversations WHERE id=$1", [conversation.id]);
      let ordinal = Number(count.rows[0]?.n ?? 0);
      const insertMessage = async (row: { role: string; kind: string; content: string; intent?: string | null; run?: typeof ctx.run; status?: string; idempotencyKey?: string | null }) => {
        ordinal += 1;
        const id = uuidv7();
        await c.query(
          `INSERT INTO rfpilot.conversation_messages(id,organization_id,conversation_id,ordinal,role,kind,content,intent,run_type,run_id,job_id,status,idempotency_key,actor_external_user_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [id, org, conversation.id, ordinal, row.role, row.kind, row.content, row.intent ?? null, row.run?.runType ?? null, row.run?.runId ?? null, row.run?.jobId ?? null, row.status ?? "complete", row.idempotencyKey ?? null, ctx.actorUserMongoId],
        );
        return id;
      };
      const userKind = ctx.intent === "chat" ? "note" : "action_request";
      const userMessageId = await insertMessage({ role: "user", kind: userKind, content: ctx.content, intent: ctx.intent, idempotencyKey: ctx.idempotencyKey });
      for (const sourceId of ctx.sourceIds)
        await c.query(
          "INSERT INTO rfpilot.conversation_message_attachments(id,organization_id,message_id,source_id) VALUES($1,$2,$3,$4) ON CONFLICT(message_id,source_id) DO NOTHING",
          [uuidv7(), org, userMessageId, sourceId],
        );
      let assistantMessageId: string | null = null;
      if (ctx.run)
        assistantMessageId = await insertMessage({ role: "assistant", kind: "run_result", content: runStatusMessage(ctx.run.runType, "queued"), run: ctx.run, status: "pending" });
      await c.query("UPDATE rfpilot.conversations SET message_count=$2,updated_at=now() WHERE id=$1", [conversation.id, ordinal]);
      await audit(c, org, ctx.actorUserMongoId, "conversation_message_created", "conversation", conversation.id, ctx.correlationId, { intent: ctx.intent, runType: ctx.run?.runType ?? null });
      const message = await c.query<any>("SELECT * FROM rfpilot.conversation_messages WHERE id=$1", [userMessageId]);
      return { created: true, message: messagePayload(message.rows[0], []), assistantMessageId, conversationId: conversation.id, organizationId: org };
    });
  },

  // Direct assistant turn with no backing run (e.g. the live chat reply).
  async appendAssistantMessage(ctx: Ctx & { proposalMongoId: string; content: string }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      const proposalRefId = await proposal(c, ctx.proposalMongoId, ctx.actorUserMongoId);
      const conversation = await getOrCreateConversation(c, org, proposalRefId, ctx.actorUserMongoId);
      await c.query("SELECT id FROM rfpilot.conversations WHERE id=$1 FOR UPDATE", [conversation.id]);
      const count = await c.query<{ n: number }>("SELECT message_count n FROM rfpilot.conversations WHERE id=$1", [conversation.id]);
      const ordinal = Number(count.rows[0]?.n ?? 0) + 1;
      const id = uuidv7();
      await c.query(
        `INSERT INTO rfpilot.conversation_messages(id,organization_id,conversation_id,ordinal,role,kind,content,status,actor_external_user_id)
         VALUES($1,$2,$3,$4,'assistant','status',$5,'complete',$6)`,
        [id, org, conversation.id, ordinal, ctx.content.slice(0, 4000), ctx.actorUserMongoId],
      );
      await c.query("UPDATE rfpilot.conversations SET message_count=$2,updated_at=now() WHERE id=$1", [conversation.id, ordinal]);
      return { id, ordinal };
    });
  },

  // Lightweight lookup used before answering so a single-field question's
  // answer can also be written into the proposal (human data entry).
  async readQuestion(ctx: Ctx & { proposalMongoId: string; questionId: string }) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, ctx.organizationMongoId);
      const proposalRefId = await proposal(c, ctx.proposalMongoId, ctx.actorUserMongoId);
      const question = await c.query<{ id: string; issue_code: string; canonical_paths: string[]; status: string }>(
        "SELECT id,issue_code,canonical_paths,status FROM rfpilot.clarification_questions WHERE id=$1 AND proposal_reference_id=$2",
        [ctx.questionId, proposalRefId],
      );
      if (!question.rows[0]) throw new ConversationError("QUESTION_NOT_FOUND", "Clarification question was not found.", 404);
      const row = question.rows[0];
      return { id: row.id, code: row.issue_code, paths: Array.isArray(row.canonical_paths) ? row.canonical_paths : [], status: row.status };
    });
  },

  async updateQuestion(ctx: Ctx & { proposalMongoId: string; questionId: string; status: "answered" | "dismissed"; answer: string; appliedPath?: string | null }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      const proposalRefId = await proposal(c, ctx.proposalMongoId, ctx.actorUserMongoId);
      const question = await c.query<any>(
        "SELECT * FROM rfpilot.clarification_questions WHERE id=$1 AND proposal_reference_id=$2 FOR UPDATE",
        [ctx.questionId, proposalRefId],
      );
      if (!question.rows[0]) throw new ConversationError("QUESTION_NOT_FOUND", "Clarification question was not found.", 404);
      const row = question.rows[0];
      // A single-field answer is written to Mongo immediately before this
      // transaction. The live snapshot synchronizer can observe that value and
      // mark the question superseded in the narrow gap between those writes.
      // Treat that state as this request's successful continuation when the
      // applied path is exactly one of the question's canonical paths.
      const supersededByThisAnswer = row.status === "superseded"
        && ctx.status === "answered"
        && !!ctx.appliedPath
        && Array.isArray(row.canonical_paths)
        && row.canonical_paths.includes(ctx.appliedPath);
      if (row.status !== "open" && !supersededByThisAnswer)
        throw new ConversationError("QUESTION_NOT_OPEN", "This question has already been resolved.", 409);
      let answeredMessageId: string | null = null;
      if (ctx.status === "answered") {
        const conversation = await getOrCreateConversation(c, org, proposalRefId, ctx.actorUserMongoId);
        await c.query("SELECT id FROM rfpilot.conversations WHERE id=$1 FOR UPDATE", [conversation.id]);
        const count = await c.query<{ n: number }>("SELECT message_count n FROM rfpilot.conversations WHERE id=$1", [conversation.id]);
        const ordinal = Number(count.rows[0]?.n ?? 0) + 1;
        answeredMessageId = uuidv7();
        await c.query(
          `INSERT INTO rfpilot.conversation_messages(id,organization_id,conversation_id,ordinal,role,kind,content,intent,status,actor_external_user_id)
           VALUES($1,$2,$3,$4,'user','question_answer',$5,'chat','complete',$6)`,
          [answeredMessageId, org, conversation.id, ordinal, ctx.answer, ctx.actorUserMongoId],
        );
        await c.query("UPDATE rfpilot.conversations SET message_count=$2,updated_at=now() WHERE id=$1", [conversation.id, ordinal]);
      }
      await c.query(
        "UPDATE rfpilot.clarification_questions SET status=$2,answered_message_id=$3,answered_by_external_user_id=$4,updated_at=now() WHERE id=$1",
        [ctx.questionId, ctx.status, answeredMessageId, ctx.actorUserMongoId],
      );
      await audit(c, org, ctx.actorUserMongoId, "clarification_question_updated", "clarification_question", ctx.questionId, ctx.correlationId, { outcome: ctx.status, appliedPath: ctx.appliedPath ?? null });
      return { id: ctx.questionId, status: ctx.status, answeredMessageId };
    });
  },

  // Lightweight change signal for the SSE stream: materializes finished runs,
  // then reports counters the client can diff to decide when to refetch.
  async snapshot(ctx: Ctx & { proposalMongoId: string }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      const proposalRefId = await proposal(c, ctx.proposalMongoId, ctx.actorUserMongoId);
      const conversation = await getOrCreateConversation(c, org, proposalRefId, ctx.actorUserMongoId);
      await materializeRuns(c, conversation.id);
      await syncQuestions(c, org, proposalRefId, conversation.id);
      // Key questions must also appear when there are no sources at all, so a
      // proposal started by conversation still gets asked what matters.
      await syncFieldGapQuestions(c, org, proposalRefId, conversation.id, {
        organizationMongoId: ctx.organizationMongoId,
        actorUserMongoId: ctx.actorUserMongoId,
        proposalMongoId: ctx.proposalMongoId,
      });
      const pending = await c.query<{ n: number }>(
        "SELECT count(*)::int n FROM rfpilot.conversation_messages WHERE conversation_id=$1 AND status='pending'",
        [conversation.id],
      );
      const open = await c.query<{ n: number }>(
        "SELECT count(*)::int n FROM rfpilot.clarification_questions WHERE proposal_reference_id=$1 AND status='open'",
        [proposalRefId],
      );
      const count = await c.query<{ n: number; updated_at: string }>(
        "SELECT message_count n,updated_at FROM rfpilot.conversations WHERE id=$1",
        [conversation.id],
      );
      return {
        conversationId: conversation.id,
        messageCount: Number(count.rows[0]?.n ?? 0),
        pendingMessages: Number(pending.rows[0]?.n ?? 0),
        openQuestions: Number(open.rows[0]?.n ?? 0),
        updatedAt: count.rows[0]?.updated_at ?? null,
      };
    });
  },
};
