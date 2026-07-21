import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { durableJobDispatcher } from "../src/modules/durableJobs/composition";
import {
  parseDraftInput,
  parseSectionDecision,
  parseSectionKey,
  proposalDraftEnabled,
  ProposalDraftError,
} from "../src/modules/proposalDraft/domain";
import { proposalDraftRepository } from "../src/modules/proposalDraft/postgresProposalDraftRepository";
const context = (req: AuthRequest) => {
    if (!proposalDraftEnabled())
      throw new ProposalDraftError(
        "PROPOSAL_DRAFT_DISABLED",
        "Proposal drafting is disabled outside the approved Slice 2F test environment.",
        503,
      );
    if (!req.user?.organizationId || !req.user.userId)
      throw new ProposalDraftError(
        "AUTHENTICATION_REQUIRED",
        "Authentication required.",
        401,
      );
    return {
      organizationMongoId: req.user.organizationId,
      actorUserMongoId: req.user.userId,
      correlationId: String(
        req.headers["x-correlation-id"] || crypto.randomUUID(),
      ),
    };
  },
  proposalId = (x: string) => {
    if (!/^[0-9a-f]{24}$/i.test(x))
      throw new ProposalDraftError(
        "PROPOSAL_NOT_FOUND",
        "Proposal was not found.",
        404,
      );
    return x;
  },
  runId = (x: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(x))
      throw new ProposalDraftError(
        "DRAFT_RUN_NOT_FOUND",
        "Draft run was not found.",
        404,
      );
    return x;
  },
  key = (req: AuthRequest) => {
    const x = String(req.headers["idempotency-key"] || "").trim();
    if (!x)
      throw new ProposalDraftError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key is required.",
        400,
      );
    return x;
  },
  handle = (res: Response, e: unknown) => {
    const known = e instanceof ProposalDraftError,
      status = known ? e.status : 500,
      code = known ? e.code : "INTERNAL_ERROR";
    res
      .status(status)
      .json({
        title: known ? e.message : "Draft operation failed",
        status,
        code,
      });
  };
export const createProposalDraft = async (req: AuthRequest, res: Response) => {
  try {
    const c = context(req),
      r = await proposalDraftRepository.create({
        ...c,
        ...parseDraftInput(req.body as Record<string, unknown>),
        live: req.path.includes("live-draft-jobs"),
        proposalMongoId: proposalId(req.params.proposalId),
        idempotencyKey: key(req),
      });
    void durableJobDispatcher.dispatch().catch(() => undefined);
    res
      .status(r.created ? 202 : 200)
      .json({
        data: {
          runId: r.run.id,
          jobId: r.run.job_id,
          status: r.run.job_status,
          created: r.created,
        },
      });
  } catch (e) {
    handle(res, e);
  }
};
export const readProposalDraft = async (req: AuthRequest, res: Response) => {
  try {
    const c = context(req);
    res.json({
      data: await proposalDraftRepository.read({
        ...c,
        proposalMongoId: proposalId(req.params.proposalId),
        runId: runId(req.params.runId),
      }),
    });
  } catch (e) {
    handle(res, e);
  }
};
export const latestProposalDraft = async (req: AuthRequest, res: Response) => {
  try {
    const c = context(req);
    res.json({
      data: await proposalDraftRepository.read({
        ...c,
        proposalMongoId: proposalId(req.params.proposalId),
      }),
    });
  } catch (e) {
    handle(res, e);
  }
};

export const decideDraftSection = async (req: AuthRequest, res: Response) => {
  try {
    const c = context(req);
    const decision = parseSectionDecision(req.body as Record<string, unknown>);
    res.json({
      data: await proposalDraftRepository.decideSection({
        ...c,
        proposalMongoId: proposalId(req.params.proposalId),
        runId: runId(req.params.runId),
        sectionKey: parseSectionKey(req.params.sectionKey),
        decision: decision.decision,
        reason: decision.reason,
      }),
    });
  } catch (e) {
    handle(res, e);
  }
};

/* Regenerate one section as a NEW scoped run linked to its parent. The parent
   run and its sections stay immutable; the UI overlays the newest scoped run. */
export const regenerateDraftSection = async (req: AuthRequest, res: Response) => {
  try {
    const c = context(req);
    const parentRunId = runId(req.params.runId);
    const sectionKey = parseSectionKey(req.params.sectionKey);
    const parsed = parseDraftInput({
      expectedProposalVersion: (req.body as Record<string, unknown>)?.expectedProposalVersion,
      fixture: "synthetic-proposal-draft",
    });
    const parent = await proposalDraftRepository.read({
      ...c,
      proposalMongoId: proposalId(req.params.proposalId),
      runId: parentRunId,
    });
    if (parent.run.status !== "succeeded")
      throw new ProposalDraftError("DRAFT_RUN_NOT_REVIEWABLE", "Only completed drafts can be regenerated.", 409);
    const r = await proposalDraftRepository.create({
      ...c,
      ...parsed,
      live: parent.run.provider === "openai",
      proposalMongoId: proposalId(req.params.proposalId),
      idempotencyKey: key(req),
      sectionScope: sectionKey,
      parentRunId,
    });
    void durableJobDispatcher.dispatch().catch(() => undefined);
    res.status(r.created ? 202 : 200).json({
      data: { runId: r.run.id, jobId: r.run.job_id, status: r.run.job_status, sectionScope: sectionKey, parentRunId, created: r.created },
    });
  } catch (e) {
    handle(res, e);
  }
};
