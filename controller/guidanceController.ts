import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { guidanceEnabled, GuidanceError } from "../src/modules/guidance/domain";
import { guidanceRepository } from "../src/modules/guidance/postgresGuidanceRepository";

const context = (req: AuthRequest) => {
  if (!guidanceEnabled()) throw new GuidanceError("GUIDANCE_DISABLED", "Proposal guidance is disabled.", 503);
  if (!req.user?.organizationId || !req.user.userId) throw new GuidanceError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return {
    organizationMongoId: req.user.organizationId,
    actorUserMongoId: req.user.userId,
    correlationId: String(req.headers["x-correlation-id"] || crypto.randomUUID()),
  };
};
const proposalId = (value: string) => {
  if (!/^[0-9a-f]{24}$/i.test(value)) throw new GuidanceError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  return value;
};
const handle = (res: Response, error: unknown) => {
  const known = error instanceof GuidanceError;
  const status = known ? error.status : 500;
  const code = known ? error.code : "INTERNAL_ERROR";
  res.status(status).type("application/problem+json").json({
    type: `https://api.rfpilot.example/problems/${code.toLowerCase().replace(/_/g, "-")}`,
    title: known ? error.message : "Guidance operation failed",
    status,
    code,
  });
};

export const generateGuidance = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    res.status(201).json({ data: await guidanceRepository.generate({ ...ctx, proposalMongoId: proposalId(req.params.proposalId) }) });
  } catch (error) { handle(res, error); }
};

export const latestGuidance = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    res.json({ data: await guidanceRepository.latest({ ...ctx, proposalMongoId: proposalId(req.params.proposalId) }) });
  } catch (error) { handle(res, error); }
};
