import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { answerTargetPath, conversationsEnabled, parseMessageInput, parseQuestionUpdate, ConversationError } from "../src/modules/conversations/domain";
import { conversationRepository } from "../src/modules/conversations/postgresConversationRepository";
import { applyAnswerToProposalField, type AppliedAnswerField } from "../src/modules/conversations/answerFieldWriter";
import { contextEnabled, sourceContextInput } from "../src/modules/proposalContext/domain";
import { proposalContextRepository } from "../src/modules/proposalContext/postgresProposalContextRepository";
import { proposalDraftEnabled, parseDraftInput } from "../src/modules/proposalDraft/domain";
import { proposalDraftRepository } from "../src/modules/proposalDraft/postgresProposalDraftRepository";
import { durableJobDispatcher } from "../src/modules/durableJobs/composition";
import { appendChatReply } from "../src/modules/conversations/chatReply";
import { maybeExtractSegment } from "../src/modules/conversations/segmentIntake";
import { conversationExtractionEnabled } from "../src/modules/conversations/segmentation";
import { withConversationProposalReference } from "../src/modules/conversations/conversationProposalReference";
import { safeLog } from "../src/shared/observability/safeTelemetry";

const context = (req: AuthRequest) => {
  if (!conversationsEnabled())
    throw new ConversationError("CONVERSATIONS_DISABLED", "The proposal conversation workspace is disabled.", 503);
  if (!req.user?.organizationId || !req.user.userId)
    throw new ConversationError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return {
    organizationMongoId: req.user.organizationId,
    actorUserMongoId: req.user.userId,
    correlationId: String(req.headers["x-correlation-id"] || crypto.randomUUID()),
  };
};
const proposalId = (value: string) => {
  if (!/^[0-9a-f]{24}$/i.test(value)) throw new ConversationError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  return value;
};
const questionId = (value: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new ConversationError("QUESTION_NOT_FOUND", "Clarification question was not found.", 404);
  return value;
};
const idempotencyKey = (req: AuthRequest) => {
  const value = String(req.headers["idempotency-key"] || "").trim();
  if (!value || value.length > 200)
    throw new ConversationError("IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key is required.", 400);
  return value;
};
const handle = (res: Response, error: unknown) => {
  const known = error instanceof ConversationError;
  // Errors thrown by the reused context/draft modules carry the same shape.
  const shaped = !known && error && typeof error === "object" && "code" in error && "status" in error
    ? (error as { code: string; message: string; status: number })
    : null;
  const status = known ? error.status : shaped ? shaped.status : 500;
  const code = known ? error.code : shaped ? shaped.code : "INTERNAL_ERROR";
  const title = known ? error.message : shaped ? shaped.message : "Conversation operation failed";
  res.status(status).type("application/problem+json").json({
    type: `https://api.rfpilot.example/problems/${code.toLowerCase().replace(/_/g, "-")}`,
    title, status, code,
  });
};

export const getConversation = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    const proposalMongoId = proposalId(req.params.proposalId);
    const conversation = await withConversationProposalReference(
      ctx,
      proposalMongoId,
      () =>
        conversationRepository.read({
          ...ctx,
          proposalMongoId,
          limit: Number(req.query.limit) || undefined,
        }),
    );
    res.json({
      // Runtime-authoritative capability state prevents a dashboard build flag
      // from offering a control the API will reject. The backend remains the
      // deny-by-default authority.
      data: {
        ...conversation,
        capabilities: { conversationExtraction: conversationExtractionEnabled() },
      },
    });
  } catch (error) { handle(res, error); }
};

export const postConversationMessage = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    const proposalMongoId = proposalId(req.params.proposalId);
    const key = idempotencyKey(req);
    const input = parseMessageInput(req.body as Record<string, unknown>);
    let run: { runType: "proposal_context" | "proposal_draft"; runId: string; jobId: string | null } | null = null;
    if (input.intent === "extract_requirements") {
      if (!contextEnabled()) throw new ConversationError("PROPOSAL_CONTEXT_DISABLED", "Requirement extraction is disabled.", 503);
      if (process.env.LIVE_AI_PROPOSAL_SOURCE_ENABLED !== "true")
        throw new ConversationError("LIVE_AI_SOURCE_DISABLED", "Live AI proposal-source processing is disabled.", 503);
      const parsed = sourceContextInput({ sourceIds: input.sourceIds });
      const result = await withConversationProposalReference(
        ctx,
        proposalMongoId,
        () =>
          proposalContextRepository.create({
            ...ctx,
            ...parsed,
            live: true,
            proposalMongoId,
            idempotencyKey: key,
          }),
      );
      run = { runType: "proposal_context", runId: result.runId, jobId: result.job.id };
    } else if (input.intent === "generate_draft") {
      if (!proposalDraftEnabled()) throw new ConversationError("PROPOSAL_DRAFT_DISABLED", "Draft generation is disabled.", 503);
      const parsed = parseDraftInput({ expectedProposalVersion: input.expectedProposalVersion, fixture: "synthetic-proposal-draft" });
      const result = await withConversationProposalReference(
        ctx,
        proposalMongoId,
        () =>
          proposalDraftRepository.create({
            ...ctx,
            ...parsed,
            live: true,
            proposalMongoId,
            idempotencyKey: key,
          }),
      );
      run = { runType: "proposal_draft", runId: result.run.id, jobId: result.run.job_id };
    }
    const exchange = await withConversationProposalReference(
      ctx,
      proposalMongoId,
      () =>
        conversationRepository.appendExchange({
          ...ctx,
          proposalMongoId,
          idempotencyKey: key,
          content: input.content,
          intent: input.intent,
          sourceIds: input.sourceIds,
          run,
        }),
    );
    if (run) void durableJobDispatcher.dispatch().catch(() => undefined);
    if (input.intent === "chat" && exchange.created) {
      // What the planner typed is no longer a dead end: once the accumulated
      // turns close into a segment, they are materialised as a scanned source
      // and the scan chains extraction. Batched rather than per-message so a
      // correction lands in the same run as what it corrects, where the
      // conflict detector can see them disagree. Never blocks the reply.
      await maybeExtractSegment({ ...ctx, proposalMongoId });
      await appendChatReply(
        ctx,
        proposalMongoId,
        (exchange as { organizationId?: string }).organizationId,
        exchange.message.id,
      );
    }
    safeLog("info", "conversation_message_created", { outcome: exchange.created ? "created" : "duplicate", operation: input.intent });
    res.status(exchange.created ? 201 : 200).json({ data: { ...exchange, run } });
  } catch (error) { handle(res, error); }
};

/**
 * Close the current transcript segment on request.
 *
 * Segments otherwise close on idle or turn count, which means a planner who has
 * just finished describing their event has no way to say "use that now" — they
 * would sit waiting for a timer. No Idempotency-Key header: the operation is
 * already idempotent on the id of the message that closes the segment, so a
 * double click reuses the existing source rather than creating a second one.
 */
export const postConversationSegment = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    const proposalMongoId = proposalId(req.params.proposalId);
    const result = await maybeExtractSegment({ ...ctx, proposalMongoId, explicit: true });
    safeLog("info", "conversation_segment_requested", {
      outcome: result.created ? "created" : "skipped",
      operation: result.reason,
    });
    // 200 with the reason either way: "nothing new to use yet" is a normal
    // answer, not an error, and the UI needs to say which happened.
    res.status(200).json({ data: result });
  } catch (error) { handle(res, error); }
};

export const patchConversationQuestion = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    const update = parseQuestionUpdate(req.body as Record<string, unknown>);
    const proposalMongoId = proposalId(req.params.proposalId);
    const targetQuestionId = questionId(req.params.questionId);
    // Answers to single whitelisted-field questions are also written into the
    // proposal as human data entry. normalizeCandidate rejects invalid values
    // with a friendly 422 BEFORE the question is resolved, so the UI re-asks.
    let appliedField: AppliedAnswerField | null = null;
    if (update.status === "answered") {
      const question = await withConversationProposalReference(
        ctx,
        proposalMongoId,
        () =>
          conversationRepository.readQuestion({
            ...ctx,
            proposalMongoId,
            questionId: targetQuestionId,
          }),
      );
      const targetPath = question.status === "open" ? answerTargetPath(question.paths) : null;
      if (targetPath)
        appliedField = await applyAnswerToProposalField({
          organizationMongoId: ctx.organizationMongoId,
          actorUserMongoId: ctx.actorUserMongoId,
          proposalMongoId,
          path: targetPath,
          answer: update.answer,
        });
    }
    const result = await withConversationProposalReference(
      ctx,
      proposalMongoId,
      () =>
        conversationRepository.updateQuestion({
          ...ctx,
          proposalMongoId,
          questionId: targetQuestionId,
          status: update.status,
          answer: update.answer,
          appliedPath: appliedField?.path ?? null,
        }),
    );
    await conversationRepository.appendRoomScheduleSuggestionWhenReady({
      ...ctx,
      proposalMongoId,
    }).catch(() => undefined);
    res.json({ data: { ...result, appliedField } });
  } catch (error) { handle(res, error); }
};

// Server-sent events: one server-side poller per open workspace replaces
// per-panel 1s client polling. Clients diff `update` payloads and refetch the
// conversation when counters change; `reconnect` asks the client to reopen.
export const conversationEvents = async (req: AuthRequest, res: Response) => {
  let interval: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => { if (interval) clearInterval(interval); if (timeout) clearTimeout(timeout); };
  try {
    const ctx = context(req);
    const proposalMongoId = proposalId(req.params.proposalId);
    res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    let last = "";
    let ticks = 0;
    const push = async () => {
      try {
        const snapshot = await withConversationProposalReference(
          ctx,
          proposalMongoId,
          () =>
            conversationRepository.snapshot({
              ...ctx,
              proposalMongoId,
            }),
        );
        const payload = JSON.stringify(snapshot);
        if (payload !== last) { last = payload; res.write(`event: update\ndata: ${payload}\n\n`); }
        ticks += 1;
        if (ticks % 7 === 0) res.write(": ping\n\n");
      } catch { res.write("event: stream_error\ndata: {}\n\n"); }
    };
    await push();
    interval = setInterval(() => { void push(); }, 2000);
    timeout = setTimeout(() => { res.write("event: reconnect\ndata: {}\n\n"); cleanup(); res.end(); }, 5 * 60_000);
    req.on("close", cleanup);
  } catch (error) {
    cleanup();
    if (!res.headersSent) { handle(res, error); return; }
    res.end();
  }
};
