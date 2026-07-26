import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { investmentEnabled, InvestmentError } from "../src/modules/investment/domain";
import { investmentRepository } from "../src/modules/investment/postgresInvestmentRepository";

const context = (req: AuthRequest) => {
  if (!investmentEnabled()) throw new InvestmentError("INVESTMENT_GUIDANCE_DISABLED", "Investment guidance is disabled.", 503);
  if (!req.user?.organizationId || !req.user.userId) throw new InvestmentError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return {
    organizationMongoId: req.user.organizationId,
    actorUserMongoId: req.user.userId,
    correlationId: String(req.headers["x-correlation-id"] || crypto.randomUUID()),
  };
};
const proposalId = (value: string) => {
  if (!/^[0-9a-f]{24}$/i.test(value)) throw new InvestmentError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  return value;
};
const handle = (res: Response, error: unknown) => {
  const known = error instanceof InvestmentError;
  const status = known ? error.status : 500;
  const code = known ? error.code : "INTERNAL_ERROR";
  res.status(status).type("application/problem+json").json({
    type: `https://api.rfpilot.example/problems/${code.toLowerCase().replace(/_/g, "-")}`,
    title: known ? error.message : "Investment guidance operation failed",
    status,
    code,
  });
};

export const generateInvestmentGuidance = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    res.status(201).json({ data: await investmentRepository.generate({ ...ctx, proposalMongoId: proposalId(req.params.proposalId) }) });
  } catch (error) { handle(res, error); }
};

export const latestInvestmentGuidance = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = context(req);
    res.json({ data: await investmentRepository.latest({ ...ctx, proposalMongoId: proposalId(req.params.proposalId) }) });
  } catch (error) { handle(res, error); }
};
