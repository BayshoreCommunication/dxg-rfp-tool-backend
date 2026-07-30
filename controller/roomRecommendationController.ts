import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import {
  parseApplication,
  parseReview,
  RoomRecommendationError,
  roomRecommendationsEnabled,
} from "../src/modules/roomRecommendation/domain";
import { roomRecommendationAutoApply, roomRecommendationRepository } from "../src/modules/roomRecommendation/postgresRoomRecommendationRepository";

const context = (req: AuthRequest) => {
  if (!roomRecommendationsEnabled())
    throw new RoomRecommendationError("ROOM_RECOMMENDATIONS_DISABLED", "Room recommendations are disabled.", 503);
  if (!req.user?.organizationId || !req.user.userId)
    throw new RoomRecommendationError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return {
    organizationMongoId: req.user.organizationId,
    actorUserMongoId: req.user.userId,
    correlationId: String(req.headers["x-correlation-id"] || crypto.randomUUID()),
  };
};
const proposalId = (value: string) => {
  if (!/^[0-9a-f]{24}$/i.test(value)) throw new RoomRecommendationError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  return value;
};
const runId = (value: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new RoomRecommendationError("RECOMMENDATION_RUN_NOT_FOUND", "Recommendation run was not found.", 404);
  return value;
};
const idempotencyKey = (req: AuthRequest) => {
  const header = String(req.headers["idempotency-key"] || "").trim();
  if (!header || header.length > 200)
    throw new RoomRecommendationError("IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required.", 400);
  return header;
};
const handle = (res: Response, error: unknown) => {
  const known = error instanceof RoomRecommendationError;
  const status = known ? error.status : 500;
  const code = known ? error.code : "INTERNAL_ERROR";
  res.status(status).type("application/problem+json").json({
    type: `https://api.rfpilot.example/problems/${code.toLowerCase().replace(/_/g, "-")}`,
    title: known ? error.message : "Room recommendation operation failed",
    status,
    code,
  });
};

export const generateRoomRecommendations = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    const result = await roomRecommendationRepository.generate({ ...ctx, proposalMongoId: proposalId(req.params.proposalId) });
    res.status(result.created ? 201 : 200).json({ data: { ...result.run, created: result.created } });
  } catch (error) { handle(res, error); }
};

export const latestRoomRecommendations = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    res.json({ data: await roomRecommendationRepository.latest({ ...ctx, proposalMongoId: proposalId(req.params.proposalId) }) });
  } catch (error) { handle(res, error); }
};

export const readRoomRecommendationReview = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    res.json({
      data: await roomRecommendationRepository.readReview({
        ...ctx,
        proposalMongoId: proposalId(req.params.proposalId),
        runId: runId(req.params.runId),
      }),
    });
  } catch (error) { handle(res, error); }
};

export const saveRoomRecommendationReview = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    const review = parseReview((req.body ?? {}) as Record<string, unknown>);
    res.json({
      data: await roomRecommendationRepository.saveReview({
        ...ctx,
        proposalMongoId: proposalId(req.params.proposalId),
        runId: runId(req.params.runId),
        revision: review.revision,
        decisions: review.decisions,
      }),
    });
  } catch (error) { handle(res, error); }
};

export const applyRoomRecommendations = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    const application = parseApplication((req.body ?? {}) as Record<string, unknown>);
    const result = application.automatic
      ? await roomRecommendationAutoApply.apply({
          ...ctx,
          proposalMongoId: proposalId(req.params.proposalId),
          runId: runId(req.params.runId),
          idempotencyKey: idempotencyKey(req),
        })
      : await roomRecommendationRepository.apply({
          ...ctx,
          proposalMongoId: proposalId(req.params.proposalId),
          runId: runId(req.params.runId),
          expectedProposalVersion: application.expectedProposalVersion,
          recommendationKeys: application.recommendationKeys,
          idempotencyKey: idempotencyKey(req),
        });
    res.status(result.created ? 201 : 200).json({ data: { ...result.application, created: result.created } });
  } catch (error) { handle(res, error); }
};
