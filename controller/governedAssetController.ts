import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import {
  GovernanceError,
  parseGovernedAssetId,
  parseGovernedAssetListFilters,
  parseGovernedAssetUpdate,
  parseReplacementActivation,
} from "../src/modules/governance/domain";
import { governanceRepository } from "../src/modules/governance/postgresGovernanceRepository";

const context = (req: AuthRequest) => {
  if (!req.user?.organizationId || !req.user.userId) {
    throw new GovernanceError(
      "AUTHENTICATION_REQUIRED",
      "Authentication required.",
      401,
    );
  }
  return {
    organizationMongoId: req.user.organizationId,
    actorUserMongoId: req.user.userId,
    correlationId:
      (req as AuthRequest & { correlationId?: string }).correlationId ||
      String(req.headers["x-correlation-id"] || crypto.randomUUID()),
  };
};

const requireJson = (req: AuthRequest) => {
  if (
    !String(req.headers["content-type"] || "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    throw new GovernanceError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Governance changes must use application/json.",
      415,
    );
  }
};

const problem = (res: Response, error: unknown) => {
  const known = error instanceof GovernanceError ? error : null;
  const status = known?.status ?? 500;
  const code = known?.code ?? "INTERNAL_ERROR";
  res
    .status(status)
    .type("application/problem+json")
    .json({
      type: `https://api.rfpilot.example/problems/${code
        .toLowerCase()
        .replace(/_/g, "-")}`,
      title: known?.message ?? "Governance operation failed.",
      status,
      code,
    });
};

export const listGovernedAssets = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    res.json({
      data: await governanceRepository.list(
        context(req),
        parseGovernedAssetListFilters(
          req.query as Record<string, unknown>,
        ),
      ),
    });
  } catch (error) {
    problem(res, error);
  }
};

export const updateGovernedAsset = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    requireJson(req);
    res.json({
      data: await governanceRepository.update(
        context(req),
        parseGovernedAssetId(req.params.governedAssetId),
        parseGovernedAssetUpdate(req.body),
      ),
    });
  } catch (error) {
    problem(res, error);
  }
};

export const activateGovernedAssetReplacement = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    requireJson(req);
    res.json({
      data: await governanceRepository.activateReplacement(
        context(req),
        parseGovernedAssetId(req.params.governedAssetId),
        parseReplacementActivation(req.body),
      ),
    });
  } catch (error) {
    problem(res, error);
  }
};

export const listGovernedAssetEvents = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    res.json({
      data: await governanceRepository.events(
        context(req),
        parseGovernedAssetId(req.params.governedAssetId),
      ),
    });
  } catch (error) {
    problem(res, error);
  }
};
